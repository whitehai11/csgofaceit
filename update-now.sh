#!/usr/bin/env bash
# FragHub updater with queue lock, live-match draining, Discord notifications, and rollback.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

INSTALL_DIR="/opt/fraghub"
LOG_FILE="${INSTALL_DIR}/update.log"
ENV_FILE="${INSTALL_DIR}/.env"
MODE="interactive"
WAIT_SECONDS_DEFAULT=600
DRAIN_CHECK_INTERVAL_SECONDS=30
DRAIN_TIMEOUT_SECONDS_DEFAULT=7200
API_BASE_URL_DEFAULT="http://localhost:8080"

mkdir -p "${INSTALL_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

have_cmd() {
  command -v "$1" >/dev/null 2>&1
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

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

load_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  fi
}

send_discord_message() {
  local channel_id="$1"
  local payload="$2"
  if [[ -z "${DISCORD_TOKEN:-}" || -z "${channel_id}" ]]; then
    info "Discord token/channel missing; skipping Discord notification."
    return 0
  fi

  local response_code
  response_code="$(curl -sS -o /tmp/fraghub-discord-response.txt -w '%{http_code}' \
    -X POST "https://discord.com/api/v10/channels/${channel_id}/messages" \
    -H "Authorization: Bot ${DISCORD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${payload}" || true)"

  if [[ "${response_code}" -lt 200 || "${response_code}" -ge 300 ]]; then
    error "Failed to send Discord notification to channel ${channel_id} (HTTP ${response_code})."
    return 1
  fi
  return 0
}

notify_update_available() {
  local commit_hash_short="$1"
  local commit_subject="$2"
  local commit_author="$3"
  local commit_date="$4"
  local wait_minutes="$5"
  local payload

  payload="$(
    cat <<EOF
{
  "embeds": [
    {
      "title": "New Update Available",
      "description": "Update detected for FragHub.",
      "color": 16763904,
      "fields": [
        { "name": "Version / Commit", "value": "$(json_escape "${commit_hash_short}")", "inline": true },
        { "name": "Commit Hash", "value": "$(json_escape "${commit_hash_short}")", "inline": true },
        { "name": "Commit Message", "value": "$(json_escape "${commit_subject}")", "inline": false },
        { "name": "Author", "value": "$(json_escape "${commit_author}")", "inline": true },
        { "name": "Time", "value": "$(json_escape "${commit_date}")", "inline": true }
      ],
      "footer": { "text": "Update will begin in ${wait_minutes} minutes." }
    }
  ]
}
EOF
  )"
  send_discord_message "${DISCORD_UPDATE_LOG_CHANNEL_ID:-}" "${payload}" || true
}

notify_announcement_incoming() {
  local wait_minutes="$1"
  local payload
  payload="$(
    cat <<EOF
{
  "content": "@everyone",
  "embeds": [
    {
      "title": "FragHub Update Incoming",
      "description": "Matchmaking is temporarily disabled while the system prepares an update.",
      "color": 16744192,
      "fields": [
        { "name": "Matches", "value": "Active matches will finish normally.", "inline": false },
        { "name": "Restart", "value": "Servers will restart shortly after all matches end.", "inline": false },
        { "name": "Expected downtime", "value": "~1-2 minutes", "inline": true },
        { "name": "Start", "value": "Update begins in ${wait_minutes} minutes.", "inline": true }
      ]
    }
  ],
  "allowed_mentions": { "parse": ["everyone"] }
}
EOF
  )"
  send_discord_message "${DISCORD_ANNOUNCEMENT_CHANNEL_ID:-}" "${payload}" || true
}

notify_forced_update() {
  local payload
  payload='{"embeds":[{"title":"Update forced after timeout","description":"Active matches exceeded drain timeout. Update is proceeding with warning.","color":16760576}]}'
  send_discord_message "${DISCORD_UPDATE_LOG_CHANNEL_ID:-}" "${payload}" || true
  send_discord_message "${DISCORD_ANNOUNCEMENT_CHANNEL_ID:-}" "${payload}" || true
}

notify_update_complete() {
  local commit_hash_short="$1"
  local duration="$2"
  local payload
  payload="$(
    cat <<EOF
{
  "embeds": [
    {
      "title": "Update Complete",
      "description": "FragHub servers are back online. Matchmaking is now enabled again.",
      "color": 5763719,
      "fields": [
        { "name": "Commit", "value": "$(json_escape "${commit_hash_short}")", "inline": true },
        { "name": "Duration", "value": "$(json_escape "${duration}")", "inline": true }
      ]
    }
  ]
}
EOF
  )"
  send_discord_message "${DISCORD_UPDATE_LOG_CHANNEL_ID:-}" "${payload}" || true
  send_discord_message "${DISCORD_ANNOUNCEMENT_CHANNEL_ID:-}" "${payload}" || true
}

notify_update_failed() {
  local commit_hash_short="$1"
  local summary="$2"
  local payload
  payload="$(
    cat <<EOF
{
  "embeds": [
    {
      "title": "Update Failed",
      "description": "Servers restored to previous version.",
      "color": 15548997,
      "fields": [
        { "name": "Commit", "value": "$(json_escape "${commit_hash_short}")", "inline": true },
        { "name": "Error", "value": "$(json_escape "${summary}")", "inline": false }
      ]
    }
  ]
}
EOF
  )"
  send_discord_message "${DISCORD_UPDATE_LOG_CHANNEL_ID:-}" "${payload}" || true
  send_discord_message "${DISCORD_ANNOUNCEMENT_CHANNEL_ID:-}" "${payload}" || true
}

format_duration() {
  local total="$1"
  local mins=$((total / 60))
  local secs=$((total % 60))
  printf '%dm %02ds' "${mins}" "${secs}"
}

api_url() {
  printf '%s' "${PUBLIC_API_URL:-${API_BASE_URL_DEFAULT}}"
}

set_matchmaking_enabled() {
  local enabled="$1"
  local reason="$2"
  if [[ -z "${INTERNAL_API_TOKEN:-}" ]]; then
    error "INTERNAL_API_TOKEN is required to toggle matchmaking state."
    return 1
  fi
  local enabled_json="false"
  if [[ "${enabled}" == "true" ]]; then enabled_json="true"; fi
  curl -sS -X POST "$(api_url)/internal/matchmaking/set" \
    -H "Content-Type: application/json" \
    -H "x-internal-token: ${INTERNAL_API_TOKEN}" \
    -d "{\"enabled\":${enabled_json},\"reason\":\"$(json_escape "${reason}")\"}" >/dev/null
  return 0
}

count_live_matches() {
  local output count
  output="$(curl -fsS "$(api_url)/matches/live" || echo "[]")"
  count="$(printf '%s' "${output}" | grep -o '"id"' | wc -l | tr -d ' ')"
  if [[ -z "${count}" ]]; then count=0; fi
  printf '%s' "${count}"
}

drain_live_matches() {
  local start_epoch="$1"
  local timeout_seconds="$2"
  local forced=0
  while true; do
    local live_count now elapsed
    live_count="$(count_live_matches)"
    if [[ "${live_count}" -eq 0 ]]; then
      info "No active live matches remaining."
      echo "0"
      return 0
    fi

    now="$(date +%s)"
    elapsed="$((now - start_epoch))"
    if [[ "${elapsed}" -ge "${timeout_seconds}" ]]; then
      error "Live match drain timeout reached (${timeout_seconds}s). Forcing update."
      notify_forced_update
      forced=1
      echo "${forced}"
      return 0
    fi

    info "Waiting for active matches to finish... live=${live_count}"
    sleep "${DRAIN_CHECK_INTERVAL_SECONDS}"
  done
}

rollback_needed=0
previous_commit=""
target_commit_short="unknown"
update_start_epoch=0
match_wait_seconds=0
matchmaking_locked=0

unlock_matchmaking() {
  if [[ "${matchmaking_locked}" -eq 1 ]]; then
    set_matchmaking_enabled "true" "Update flow complete" || true
    matchmaking_locked=0
  fi
}

rollback() {
  if [[ "${rollback_needed}" -ne 1 ]]; then return; fi
  error "Update failed. Starting rollback."
  cd "${INSTALL_DIR}"
  if [[ -n "${previous_commit}" ]]; then
    git reset --hard "${previous_commit}"
  else
    git reset --hard HEAD@{1} || true
  fi
  compose restart || true
  unlock_matchmaking
  error "Rollback completed. Services restarted on previous revision."
}

on_error() {
  local line="$1"
  local cmd="${BASH_COMMAND:-unknown}"
  local end_epoch duration
  end_epoch="$(date +%s)"
  duration="$((end_epoch - update_start_epoch))"
  error "Update failed at line ${line}: ${cmd}"
  notify_update_failed "${target_commit_short}" "${cmd}"
  rollback
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) commit=${target_commit_short} result=failed duration_seconds=${duration} match_wait_seconds=${match_wait_seconds}" >> "${LOG_FILE}"
  exit 1
}
trap 'on_error ${LINENO}' ERR

parse_args() {
  if [[ "${1:-}" == "--auto" ]]; then MODE="auto"; fi
}

main() {
  parse_args "${1:-}"
  load_env
  update_start_epoch="$(date +%s)"

  if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
    error "${INSTALL_DIR} is not a git repository. Run install.sh first."
    exit 1
  fi
  cd "${INSTALL_DIR}"

  info "Checking for updates..."
  git fetch origin
  local local_commit remote_commit
  local_commit="$(git rev-parse HEAD)"
  remote_commit="$(git rev-parse origin/main)"
  if [[ "${local_commit}" == "${remote_commit}" ]]; then
    info "No updates found."
    success "System is already up to date."
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) commit=${local_commit:0:7} result=no_update duration_seconds=0 match_wait_seconds=0" >> "${LOG_FILE}"
    exit 0
  fi

  local commit_subject commit_author commit_date
  commit_subject="$(git log -1 --pretty=%s "${remote_commit}")"
  commit_author="$(git log -1 --pretty=%an "${remote_commit}")"
  commit_date="$(git log -1 --pretty=%ad --date=iso-strict "${remote_commit}")"
  target_commit_short="${remote_commit:0:7}"
  previous_commit="${local_commit}"
  rollback_needed=1

  info "Update available: ${target_commit_short} | ${commit_subject}"
  info "Disabling matchmaking queue."
  set_matchmaking_enabled "false" "Scheduled update preparation"
  matchmaking_locked=1

  local send_notifications="yes"
  if [[ "${MODE}" == "interactive" ]]; then
    echo
    echo "An update was found."
    echo "Send Discord announcements before updating?"
    echo "1) Yes (recommended)"
    echo "2) No (silent update)"
    read -r -p "Choose [1/2]: " choice
    if [[ "${choice}" == "2" ]]; then send_notifications="no"; fi
  fi

  local wait_seconds="${UPDATE_NOTIFY_WAIT_SECONDS:-$WAIT_SECONDS_DEFAULT}"
  local wait_minutes=$((wait_seconds / 60))
  if [[ "${MODE}" == "auto" || "${send_notifications}" == "yes" ]]; then
    notify_update_available "${target_commit_short}" "${commit_subject}" "${commit_author}" "${commit_date}" "${wait_minutes}"
    notify_announcement_incoming "${wait_minutes}"
    info "Countdown started (${wait_seconds}s). Queue remains locked."
    sleep "${wait_seconds}"
  else
    info "Silent update selected. Skipping announcements and countdown."
  fi

  local drain_timeout="${UPDATE_DRAIN_TIMEOUT_SECONDS:-$DRAIN_TIMEOUT_SECONDS_DEFAULT}"
  local drain_start drain_end drain_forced
  drain_start="$(date +%s)"
  drain_forced="$(drain_live_matches "${drain_start}" "${drain_timeout}")"
  drain_end="$(date +%s)"
  match_wait_seconds="$((drain_end - drain_start))"
  if [[ "${drain_forced}" == "1" ]]; then
    info "Proceeding with forced update after drain timeout."
  fi

  info "Pulling latest code..."
  git pull --ff-only origin main
  info "Installing dependencies..."
  npm install
  info "Building project..."
  npm run build
  info "Restarting services (no volume deletion)..."
  compose restart

  info "Validating API health..."
  local tries=30
  for ((i=1; i<=tries; i++)); do
    if curl -fsS "$(api_url)/health" >/dev/null 2>&1; then
      rollback_needed=0
      unlock_matchmaking
      local end_epoch duration_seconds duration_text
      end_epoch="$(date +%s)"
      duration_seconds="$((end_epoch - update_start_epoch))"
      duration_text="$(format_duration "${duration_seconds}")"
      notify_update_complete "${target_commit_short}" "${duration_text}"
      success "Update completed successfully."
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) commit=${target_commit_short} result=success duration_seconds=${duration_seconds} match_wait_seconds=${match_wait_seconds}" >> "${LOG_FILE}"
      exit 0
    fi
    sleep 2
  done

  error "Health check failed after update."
  false
}

main "$@"
