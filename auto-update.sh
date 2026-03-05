#!/usr/bin/env bash
# Configures automatic FragHub updates every 12 hours.
# Auto mode uses update-now.sh --auto (always announces + waits before update).

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
  error "Auto-update setup failed at line ${line}."
  exit 1
}
trap 'on_error ${LINENO}' ERR

INSTALL_DIR="/opt/fraghub"
UPDATE_SCRIPT="${INSTALL_DIR}/update-now.sh"
CRON_ENTRY="0 */12 * * * ${UPDATE_SCRIPT} --auto >> ${INSTALL_DIR}/update.log 2>&1"

if [[ ! -f "${UPDATE_SCRIPT}" ]]; then
  error "${UPDATE_SCRIPT} not found. Run install.sh first."
  exit 1
fi

if ! command -v crontab >/dev/null 2>&1; then
  error "crontab command not found. Install cron (apt-get install -y cron) and rerun."
  exit 1
fi

current_cron="$(crontab -l 2>/dev/null || true)"

if echo "${current_cron}" | grep -Fq "${CRON_ENTRY}"; then
  info "Auto-update cron entry already exists."
  success "No changes were needed."
  exit 0
fi

info "Adding cron entry for 12-hour auto updates."
{
  echo "${current_cron}"
  echo "${CRON_ENTRY}"
} | awk 'NF' | crontab -

success "Auto-update enabled."
success "Schedule: ${CRON_ENTRY}"
