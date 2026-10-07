#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 EC2 instance for Wysiwys (runner + CRE CLI + app + Caddy).
# Run as the default `ubuntu` user:  curl -sSfL <raw url of this file> | bash   or   bash setup.sh
# Re-runnable. Secrets are NOT handled here: fill the .env files afterwards (see README.md).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chiwjieren/wysiwys.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/wysiwys
DATA_DIR=/var/lib/wysiwys
SVC_USER=wysiwys

echo "== packages"
sudo apt-get update -y
sudo apt-get install -y git curl unzip ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "== 2 GB swap (WASM compile and Next.js build)"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "== Node 22"
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "== Bun (system-wide)"
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
fi

echo "== CRE CLI (system-wide)"
if ! command -v cre >/dev/null; then
  curl -sSfL https://cre.chain.link/install.sh | bash
  CRE_BIN_PATH="$(find "$HOME" -maxdepth 4 -type f -name cre -perm -u+x | head -1)"
  sudo install -m 0755 "$CRE_BIN_PATH" /usr/local/bin/cre
fi

echo "== Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "== service user and directories"
id "$SVC_USER" >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir "$DATA_DIR/home" --shell /usr/sbin/nologin "$SVC_USER"
sudo mkdir -p "$APP_DIR" "$DATA_DIR/home"
sudo chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR" "$DATA_DIR"

echo "== code"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u "$SVC_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  sudo -u "$SVC_USER" git -C "$APP_DIR" pull --ff-only
fi

echo "== build"
cd "$APP_DIR"
sudo -u "$SVC_USER" HOME="$DATA_DIR/home" npm ci --ignore-scripts
sudo -u "$SVC_USER" HOME="$DATA_DIR/home" npm run build --workspace=packages/decoder
sudo -u "$SVC_USER" HOME="$DATA_DIR/home" bash -c "cd workflow/confidential-preflight/review && bun install"
# The app reads server env at runtime; build after app/.env.local exists is not required (no NEXT_PUBLIC values).
sudo -u "$SVC_USER" HOME="$DATA_DIR/home" npm run build --workspace=app

echo "== systemd units"
sudo install -m 0644 deploy/ec2/wysiwys-runner.service /etc/systemd/system/wysiwys-runner.service
sudo install -m 0644 deploy/ec2/wysiwys-app.service /etc/systemd/system/wysiwys-app.service
sudo systemctl daemon-reload
sudo systemctl enable wysiwys-runner wysiwys-app

echo
echo "Done. Next (README.md): fill $APP_DIR/.env, $APP_DIR/workflow/confidential-preflight/.env and $APP_DIR/app/.env.local,"
echo "copy deploy/ec2/Caddyfile to /etc/caddy/Caddyfile with your hostnames, then:"
echo "  sudo systemctl restart wysiwys-runner wysiwys-app caddy"
