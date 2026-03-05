#!/usr/bin/env bash
# FragHub interactive installer for fresh Ubuntu hosts.
# Installs dependencies, clones repo, configures .env, builds, and starts services.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

on_error() {
  local line="$1"
  error "Installation failed at line ${line}. Check output above."
  exit 1
}
trap 'on_error ${LINENO}' ERR

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    error "This installer must run as root (use sudo)."
    exit 1
  fi
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_node_20() {
  local current_major=0
  if have_cmd node; then
    current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi

  if [[ "${current_major}" -ge 20 ]]; then
    return 0
  fi

  info "Node.js >=20 is required. Installing/upgrading Node.js 20 LTS..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

  local installed_major
  installed_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "${installed_major}" -lt 20 ]]; then
    error "Node.js upgrade failed. Detected version: $(node -v 2>/dev/null || echo 'unknown')"
    exit 1
  fi
  success "Node.js upgraded to $(node -v)."
}

load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    [[ "$line" != *"="* ]] && continue
    local key="${line%%=*}"
    local value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [[ -z "$key" ]] && continue
    if [[ "$value" =~ ^\".*\"$ ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "${key}=${value}"
  done < "$file"
}

compose() {
  if have_cmd docker && docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  if have_cmd docker-compose; then
    docker-compose "$@"
    return
  fi
  error "Docker Compose is not available."
  exit 1
}

install_packages_if_missing() {
  local packages=()

  have_cmd git || packages+=(git)
  have_cmd curl || packages+=(curl)
  have_cmd docker || packages+=(docker.io)

  if ! (have_cmd docker && docker compose version >/dev/null 2>&1) && ! have_cmd docker-compose; then
    packages+=(docker-compose-plugin)
  fi

  have_cmd node || packages+=(nodejs)
  have_cmd npm || packages+=(npm)

  if [[ ${#packages[@]} -gt 0 ]]; then
    info "Installing missing packages: ${packages[*]}"
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
  else
    info "All required packages are already installed."
  fi

  systemctl enable docker >/dev/null 2>&1 || true
  systemctl start docker >/dev/null 2>&1 || true
  ensure_node_20
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { updated = 0 }
    index($0, k "=") == 1 {
      print k "=" v
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print k "=" v
      }
    }
  ' "$file" > "$tmp_file"
  mv "$tmp_file" "$file"
}

prompt_secret() {
  local label="$1"
  local current="$2"
  local input
  read -r -s -p "${label} [leave empty to auto-generate]: " input
  echo
  if [[ -n "$input" ]]; then
    printf '%s' "$input"
    return
  fi
  if [[ -n "$current" && "$current" != "change-me"* && ${#current} -ge 32 ]]; then
    printf '%s' "$current"
    return
  fi
  openssl rand -hex 32
}

wait_for_infra() {
  local pg_user="$1"
  info "Waiting for PostgreSQL and Redis to become healthy..."

  local tries=60
  for ((i=1; i<=tries; i++)); do
    local pg_ok=0
    local redis_ok=0

    if compose exec -T postgres pg_isready -U "$pg_user" >/dev/null 2>&1; then
      pg_ok=1
    fi
    if compose exec -T redis redis-cli ping 2>/dev/null | grep -q "PONG"; then
      redis_ok=1
    fi

    if [[ $pg_ok -eq 1 && $redis_ok -eq 1 ]]; then
      success "PostgreSQL and Redis are healthy."
      return
    fi

    sleep 2
  done

  error "Timed out waiting for PostgreSQL/Redis health checks."
  exit 1
}

main() {
  require_root

  local install_dir="/opt/fraghub"
  local default_repo_url="https://github.com/OWNER/REPO.git"
  local repo_url

  info "FragHub interactive installer started."
  read -r -p "Repository URL [${default_repo_url}]: " repo_url
  repo_url="${repo_url:-$default_repo_url}"

  install_packages_if_missing

  if [[ -d "$install_dir/.git" ]]; then
    info "Existing git repository detected at ${install_dir}."
    read -r -p "Reuse existing directory and pull latest code? [y/N]: " reuse
    if [[ "$reuse" =~ ^[Yy]$ ]]; then
      cd "$install_dir"
      git fetch origin
      git pull --ff-only origin main
    else
      error "Installation aborted to avoid overwriting existing directory."
      exit 1
    fi
  else
    if [[ -e "$install_dir" && -n "$(ls -A "$install_dir" 2>/dev/null || true)" ]]; then
      error "${install_dir} exists and is not empty. Move/remove it and rerun."
      exit 1
    fi
    mkdir -p "$install_dir"
    info "Cloning repository into ${install_dir}"
    git clone "$repo_url" "$install_dir"
    cd "$install_dir"
  fi

  if [[ ! -f .env ]]; then
    info "Creating .env from .env.example"
    cp .env.example .env
  else
    info ".env already exists; values will be updated interactively."
  fi

  load_env_file .env

  local discord_token jwt_secret internal_api_token internal_webhook_secret server_manager_token cors_origins

  read -r -s -p "Discord Bot Token [leave empty to keep current]: " discord_token
  echo
  if [[ -z "$discord_token" ]]; then
    discord_token="${DISCORD_TOKEN:-}"
  fi

  jwt_secret="$(prompt_secret "JWT Secret" "${JWT_SECRET:-}")"
  internal_api_token="$(prompt_secret "Internal API Token" "${INTERNAL_API_TOKEN:-}")"
  internal_webhook_secret="$(prompt_secret "Internal Webhook Secret" "${INTERNAL_WEBHOOK_SECRET:-}")"
  server_manager_token="$(prompt_secret "Server Manager Token" "${SERVER_MANAGER_API_TOKEN:-}")"

  read -r -p "Allowed CORS Origins (comma-separated, empty to disable browser clients) [${CORS_ORIGINS:-}]: " cors_origins
  cors_origins="${cors_origins:-${CORS_ORIGINS:-}}"

  if [[ -z "$discord_token" ]]; then
    error "DISCORD_TOKEN is required."
    exit 1
  fi

  upsert_env_var .env "DISCORD_TOKEN" "$discord_token"
  upsert_env_var .env "JWT_SECRET" "$jwt_secret"
  upsert_env_var .env "INTERNAL_API_TOKEN" "$internal_api_token"
  upsert_env_var .env "INTERNAL_WEBHOOK_SECRET" "$internal_webhook_secret"
  upsert_env_var .env "SERVER_MANAGER_API_TOKEN" "$server_manager_token"
  upsert_env_var .env "CORS_ORIGINS" "$cors_origins"

  info "Ensuring persistent Docker volumes exist."
  docker volume create fraghub_postgres_data >/dev/null
  docker volume create fraghub_redis_data >/dev/null

  info "Starting infrastructure services (postgres, redis)."
  compose up -d postgres redis

  local pg_user
  pg_user="$(grep -E '^POSTGRES_USER=' .env | head -n1 | cut -d'=' -f2-)"
  pg_user="${pg_user:-postgres}"
  wait_for_infra "$pg_user"

  info "Installing Node dependencies."
  npm install

  info "Building project."
  npm run build

  info "Starting all services."
  compose up -d

  info "Validating API health via proxy."
  local tries=30
  for ((i=1; i<=tries; i++)); do
    if curl -fsS "http://localhost:8080/health" >/dev/null 2>&1; then
      success "FragHub deployed successfully at ${install_dir}."
      success "API health check passed."
      exit 0
    fi
    sleep 2
  done

  error "Deployment finished but API health check failed. Inspect: docker compose logs"
  exit 1
}

main "$@"
