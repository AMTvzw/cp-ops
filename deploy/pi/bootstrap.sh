#!/usr/bin/env bash
set -euo pipefail

APP_DIR_DEFAULT="/opt/CP-OPS"
SERVICE_NAME="cp-ops.service"
COMPOSE_FILE="deploy/docker/docker-compose.server.yml"
APP_DIR="$APP_DIR_DEFAULT"
REPO_URL="${REPO_URL:-https://github.com/AMTvzw/cp-ops.git}"

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/pi/bootstrap.sh [--app-dir /opt/CP-OPS] [--repo-url <git-url>]

What this script does:
  - Installs Docker (if missing)
  - Ensures Docker service starts on boot
  - Clones/updates CP-OPS in APP_DIR
  - Creates .env from .env.example (if missing)
  - Generates SESSION_SECRET and DEFAULT_ROOT_PASSWORD if missing/placeholder
  - Creates and enables a systemd service for automatic app start
  - Starts the app with Docker Compose
EOF
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
    apt-get update
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
    apt-get update
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
ExecStart=/usr/bin/docker compose -f ${COMPOSE_FILE} up -d --build --pull always
ExecStop=/usr/bin/docker compose -f ${COMPOSE_FILE} down
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
  clone_or_update_repo
  ensure_env_file
  seed_required_env
  write_systemd_service
  enable_and_start_app
  print_summary
}

main "$@"
