#!/usr/bin/env bash
# One-shot bootstrap for a fresh Ubuntu 22.04 (arm64) server (Oracle Ampere or any VM).
# Installs Docker, opens the firewall for web traffic, and starts the app + HTTPS proxy.
#
# Prereqs before running:
#   - This repo is cloned into $APP_DIR (default: ~/app)
#   - A production .env file exists at $APP_DIR/.env
#   - DNS for api.asystence.com already points at this server's public IP
#
# Run with:  bash server_setup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/app}"

echo "==> [1/4] Installing Docker (if needed)..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi

echo "==> [2/4] Opening the firewall for HTTP/HTTPS..."
# Oracle's Ubuntu image blocks everything except SSH by default. Allow 80/443.
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
# Persist across reboots (non-interactive)
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo netfilter-persistent save

echo "==> [3/4] Building and starting the stack..."
cd "$APP_DIR"
sudo docker compose -f docker-compose.prod.yml up -d --build

echo "==> [4/4] Status:"
sudo docker compose -f docker-compose.prod.yml ps
echo ""
echo "Done. Caddy will fetch an HTTPS certificate within ~1 minute once DNS is live."
echo "Watch app logs with:  sudo docker compose -f docker-compose.prod.yml logs -f app"
