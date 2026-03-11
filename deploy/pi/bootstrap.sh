#!/usr/bin/env bash
set -euo pipefail

APP_DIR_DEFAULT="/opt/CP-OPS"
SERVICE_NAME="cp-ops.service"
COMPOSE_FILE="deploy/docker/docker-compose.server.yml"
COMPOSE_PI_OVERRIDE_FILE="deploy/docker/docker-compose.pi.override.yml"
PI_HOST_PORT_DEFAULT="80"
APP_DIR="$APP_DIR_DEFAULT"
REPO_URL="${REPO_URL:-https://github.com/AMTvzw/cp-ops.git}"
APT_RETRY_COUNT="${APT_RETRY_COUNT:-5}"
APT_TIMEOUT_SECONDS="${APT_TIMEOUT_SECONDS:-30}"

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/pi/bootstrap.sh [--app-dir /opt/CP-OPS] [--repo-url <git-url>] [--host-port 80]

What this script does:
  - Installs Docker (if missing)
  - Ensures Docker service starts on boot
  - Clones/updates CP-OPS in APP_DIR
  - Creates .env from .env.example (if missing)
  - Generates SESSION_SECRET and DEFAULT_ROOT_PASSWORD if missing/placeholder
  - Creates and enables a systemd service for automatic app start
  - Forces Raspberry Pi Docker builds to use deploy/docker/Dockerfile.raspberrypi
  - Exposes the app on Raspberry Pi host port 80 by default
  - Allows the host port in UFW, nftables, or iptables/ip6tables (when available)
  - Only stops listeners that actually block that port
  - Starts the app with Docker Compose
EOF
}

disable_ntop_repo_if_present() {
  local found=0
  local file

  while IFS= read -r file; do
    [[ -z "${file}" ]] && continue
    found=1
    if [[ -f "${file}" ]]; then
      mv "${file}" "${file}.disabled"
      echo "Disabled problematic apt source: ${file}"
    fi
  done < <(grep -Ril "packages.ntop.org" /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true)

  if [[ "${found}" -eq 1 ]]; then
    return 0
  fi
  return 1
}

safe_apt_update() {
  local apt_opts=(
    -o "Acquire::Retries=${APT_RETRY_COUNT}"
    -o "Acquire::http::Timeout=${APT_TIMEOUT_SECONDS}"
    -o "Acquire::https::Timeout=${APT_TIMEOUT_SECONDS}"
  )

  if apt-get "${apt_opts[@]}" update; then
    return
  fi

  echo "apt-get update failed. Checking for broken ntop repository entries..."
  if disable_ntop_repo_if_present; then
    echo "Retrying apt-get update after disabling ntop source..."
    apt-get "${apt_opts[@]}" update
    return
  fi

  echo "apt-get update failed and no ntop source was found to disable." >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root (use sudo)." >&2
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --app-dir)
        APP_DIR="${2:?Missing value for --app-dir}"
        shift 2
        ;;
      --repo-url)
        REPO_URL="${2:?Missing value for --repo-url}"
        shift 2
        ;;
      --host-port)
        PI_HOST_PORT_DEFAULT="${2:?Missing value for --host-port}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage
        exit 1
        ;;
    esac
  done
}

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1; then
    echo "Docker already installed."
    return
  fi

  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
}

ensure_compose_plugin() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi

  echo "Docker Compose plugin not available. Installing package..."
  if command -v apt-get >/dev/null 2>&1; then
    safe_apt_update
    apt-get install -y docker-compose-plugin
  else
    echo "Could not install docker compose plugin automatically on this distro." >&2
    exit 1
  fi
}

ensure_base_tools() {
  local missing=()
  local tool
  for tool in curl git openssl; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      missing+=("${tool}")
    fi
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    safe_apt_update
    apt-get install -y "${missing[@]}"
  else
    echo "Missing required tools: ${missing[*]}" >&2
    exit 1
  fi
}

ensure_docker_service() {
  systemctl enable docker
  systemctl start docker
}

ensure_firewall_port_allowed() {
  local port="$1"
  local allowed=0

  if command -v ufw >/dev/null 2>&1; then
    local status
    status="$(ufw status 2>/dev/null || true)"
    if echo "${status}" | head -n1 | grep -qi "Status: active"; then
      ufw allow "${port}/tcp" >/dev/null 2>&1 || ufw allow "${port}/tcp"
      echo "UFW allow ${port}/tcp applied."
      allowed=1
    fi
  fi

  if command -v nft >/dev/null 2>&1; then
    if nft list chain inet filter input >/dev/null 2>&1; then
      if ! nft list chain inet filter input 2>/dev/null | grep -Eq "tcp dport ${port} .* accept|tcp dport \\{[^}]*${port}[^}]*\\} .* accept"; then
        nft add rule inet filter input tcp dport "${port}" counter accept >/dev/null 2>&1 || true
      fi
      echo "nftables allow tcp/${port} ensured in inet/filter/input."
      allowed=1
    fi
  fi

  if command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1 \
      || iptables -I INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1 \
      || true
    if iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1; then
      echo "iptables allow tcp/${port} ensured."
      allowed=1
    fi
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1 \
      || ip6tables -I INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1 \
      || true
    if ip6tables -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1; then
      echo "ip6tables allow tcp/${port} ensured."
      allowed=1
    fi
  fi

  if [[ "${allowed}" -eq 0 ]]; then
    echo "No active/recognized local firewall manager detected for auto-allow on port ${port}."
  fi
}

stop_port_listeners() {
  local port="$1"
  if ! command -v ss >/dev/null 2>&1; then
    return
  fi

  local pids
  pids="$(
    ss -ltnp "sport = :${port}" 2>/dev/null \
      | awk -F'pid=' 'NF>1{for(i=2;i<=NF;i++){split($i,a,/[^0-9]/); if(a[1]!="") print a[1]}}' \
      | sort -u
  )"

  if [[ -z "${pids}" ]]; then
    return
  fi

  local pid comm
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    comm="$(ps -p "${pid}" -o comm= 2>/dev/null | xargs || true)"
    if [[ -z "${comm}" ]]; then
      continue
    fi

    if systemctl list-unit-files "${comm}.service" --no-legend 2>/dev/null | grep -q "^${comm}\.service"; then
      systemctl stop "${comm}.service" || true
      systemctl disable "${comm}.service" || true
      echo "Stopped and disabled ${comm}.service (listening on port ${port})"
    else
      kill -TERM "${pid}" 2>/dev/null || true
      echo "Stopped process ${comm} (pid ${pid}) listening on port ${port}"
    fi
  done <<< "${pids}"
}

ensure_host_port_available() {
  local port="$1"
  ensure_firewall_port_allowed "${port}"
  stop_port_listeners "${port}"
}

clone_or_update_repo() {
  if [[ -d "${APP_DIR}/.git" ]]; then
    echo "Updating existing repository in ${APP_DIR}..."
    git -C "${APP_DIR}" fetch --all --tags
    git -C "${APP_DIR}" pull --ff-only
  else
    echo "Cloning repository to ${APP_DIR}..."
    mkdir -p "$(dirname "${APP_DIR}")"
    git clone "${REPO_URL}" "${APP_DIR}"
  fi
}

ensure_env_file() {
  if [[ ! -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  fi
}

ensure_env_value() {
  local key="$1"
  local value="$2"
  local env_file="${APP_DIR}/.env"

  if grep -qE "^${key}=" "${env_file}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${env_file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${env_file}"
  fi
}

seed_required_env() {
  local env_file="${APP_DIR}/.env"

  ensure_env_value "NODE_ENV" "production"

  if grep -qE '^SESSION_SECRET=$|^SESSION_SECRET=replace-with-a-long-random-secret.*$' "${env_file}" || ! grep -q '^SESSION_SECRET=' "${env_file}"; then
    ensure_env_value "SESSION_SECRET" "$(openssl rand -hex 32)"
  fi

  if grep -qE '^DEFAULT_ROOT_PASSWORD=$|^DEFAULT_ROOT_PASSWORD=replace.*$' "${env_file}" || ! grep -q '^DEFAULT_ROOT_PASSWORD=' "${env_file}"; then
    ensure_env_value "DEFAULT_ROOT_PASSWORD" "$(openssl rand -base64 18 | tr -d '=+/')"
  fi

  if grep -qE '^SESSION_IDLE_TIMEOUT_MINUTES=$' "${env_file}" || ! grep -q '^SESSION_IDLE_TIMEOUT_MINUTES=' "${env_file}"; then
    ensure_env_value "SESSION_IDLE_TIMEOUT_MINUTES" "30"
  fi
}

write_pi_compose_override() {
  cat > "${APP_DIR}/${COMPOSE_PI_OVERRIDE_FILE}" <<EOF
services:
  app:
    build:
      dockerfile: deploy/docker/Dockerfile.raspberrypi
    environment:
      PORT: 31987
    ports:
      - "${PI_HOST_PORT_DEFAULT}:31987"
EOF
}

write_systemd_service() {
  cat > "/etc/systemd/system/${SERVICE_NAME}" <<EOF
[Unit]
Description=CP-OPS Docker Compose Service
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_PI_OVERRIDE_FILE} up -d --build --pull always
ExecStop=/usr/bin/docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_PI_OVERRIDE_FILE} down
RemainAfterExit=yes
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
}

enable_and_start_app() {
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl start "${SERVICE_NAME}"
}

print_summary() {
  echo
  echo "CP-OPS bootstrap completed."
  echo "- App directory: ${APP_DIR}"
  echo "- Service: ${SERVICE_NAME}"
  echo
  echo "Useful checks:"
  echo "  systemctl status ${SERVICE_NAME}"
  echo "  docker ps"
}

main() {
  require_root
  parse_args "$@"
  ensure_base_tools
  install_docker_if_needed
  ensure_compose_plugin
  ensure_docker_service
  ensure_host_port_available "${PI_HOST_PORT_DEFAULT}"
  clone_or_update_repo
  ensure_env_file
  seed_required_env
  write_pi_compose_override
  write_systemd_service
  enable_and_start_app
  print_summary
}

main "$@"
