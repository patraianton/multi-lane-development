#!/usr/bin/env bash
# Watchtower host setup. Idempotent: safe to re-run after an update.
#
# Rsync-friendly layout
# ---------------------
#   /opt/watchtower/          application tree (bin/, deploy/, docs/, ...)
#                             overwrite on every deploy from the Windows machine
#   /opt/watchtower/state/    persistent board state (cards, clocks, settings)
#                             MUST survive updates — exclude from rsync/scp,
#                             never rsync --delete without excluding state/
#
# Copy the repository onto /opt/watchtower first (see docs/DEPLOY.md), then:
#   bash /opt/watchtower/deploy/setup.sh
#
# Expects Node.js 22 or newer already on PATH. Does not install Node, a
# reverse proxy, or TLS certificates.

set -euo pipefail

# Match systemd's default PATH so this script and the unit see the same node.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export PATH

umask 022

APP_DIR="/opt/watchtower"
ENV_FILE="/etc/watchtower.env"
UNIT_DST="/etc/systemd/system/watchtower.service"
UNIT_NAME="watchtower.service"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="${SCRIPT_DIR}/watchtower.service"

die() {
  printf '%s\n' "error: $*" >&2
  exit 1
}

require_bash() {
  if [[ -z "${BASH_VERSION:-}" ]]; then
    die "run this script with bash"
  fi
}

require_root() {
  if (( EUID != 0 )); then
    die "run as root (needed to install a systemd unit)"
  fi
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    die "systemd (systemctl) is required on this host"
  fi
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js 22 or newer is required, and 'node' is not on PATH"
  fi
  local major
  major="$(node -p "parseInt(process.versions.node, 10)")"
  if [[ -z "${major}" || "${major}" -lt 22 ]]; then
    die "Node.js 22 or newer is required; found $(node -v)"
  fi
}

require_unit_src() {
  if [[ ! -f "${UNIT_SRC}" ]]; then
    die "unit file not found: ${UNIT_SRC}"
  fi
}

require_app_tree() {
  if [[ ! -f "${APP_DIR}/bin/watchtower.mjs" ]]; then
    die "${APP_DIR}/bin/watchtower.mjs is missing. Copy the repository onto ${APP_DIR} first (exclude state/ — see docs/DEPLOY.md), then re-run this script."
  fi
}

create_layout() {
  mkdir -p "${APP_DIR}/state"
  chmod 0755 "${APP_DIR}"
  chmod 0755 "${APP_DIR}/state"
}

# Created once. Never overwrite operator edits.
create_env_file() {
  if [[ -e "${ENV_FILE}" ]]; then
    return 0
  fi
  local ssh_bin
  ssh_bin="$(command -v ssh || true)"
  if [[ -z "${ssh_bin}" ]]; then
    ssh_bin="/usr/bin/ssh"
  fi
  cat > "${ENV_FILE}" <<EOF
# Watchtower environment. setup.sh creates this file once and will not
# overwrite it. Uncomment or edit as needed, then:
#   systemctl restart watchtower
#
# WATCHTOWER_PORT=4878
WATCHTOWER_SSH=${ssh_bin}
WATCHTOWER_GH=gh
EOF
  chmod 0644 "${ENV_FILE}"
}

install_unit() {
  install -m 0644 "${UNIT_SRC}" "${UNIT_DST}"
}

start_unit() {
  systemctl daemon-reload
  systemctl enable "${UNIT_NAME}"
  systemctl restart "${UNIT_NAME}"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "${UNIT_NAME}"; then
      printf '%s\n' "watchtower.service is active (node $(node -v), tree ${APP_DIR})"
      return 0
    fi
    sleep 1
  done

  printf '%s\n' "error: ${UNIT_NAME} failed to become active" >&2
  systemctl --no-pager --full status "${UNIT_NAME}" >&2 || true
  journalctl -u "${UNIT_NAME}" -n 40 --no-pager >&2 || true
  exit 1
}

require_bash
require_root
require_systemd
require_node
require_unit_src
create_layout
require_app_tree
create_env_file
install_unit
start_unit
