#!/usr/bin/env bash
#
# Souvenir Coin Kiosk - Fleet Admin server installer.
# Run as root on a fresh Ubuntu VPS, from the folder where you unzipped the app.
#
#   sudo bash install-server.sh
#
# It installs Node.js 20, sets the app up as an always-on service (auto-start
# + auto-restart), opens the firewall, and asks you for a dashboard password.
#
set -euo pipefail

APP_DIR=/opt/fleet-admin
PORT=9090
SERVICE=/etc/systemd/system/fleet-admin.service

echo "========================================================"
echo "  Souvenir Coin Kiosk - Fleet Admin install"
echo "========================================================"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this with sudo / as root."; exit 1
fi

# --- 1. choose a dashboard admin password -------------------------------
echo
echo "Choose a password for the dashboard login (user name will be 'admin')."
echo "Use at least 10 characters. Write it down somewhere safe."
read -r -p "New admin password: " ADMIN_PASS
if [ "${#ADMIN_PASS}" -lt 10 ]; then
  echo "That password is too short (min 10 chars). Aborting."; exit 1
fi

# --- 2. put the app in /opt/fleet-admin ---------------------------------
echo
echo "Installing app to ${APP_DIR} ..."
mkdir -p "${APP_DIR}"
# copy everything from the current folder except the data dir (fresh start)
SRC="$(cd "$(dirname "$0")" && pwd)"
rsync -a --exclude 'data' --exclude '.DS_Store' "${SRC}/" "${APP_DIR}/" 2>/dev/null \
  || cp -a "${SRC}/." "${APP_DIR}/"
# ensure a clean, empty data folder (no demo data, your chosen password applies)
rm -rf "${APP_DIR}/data"
mkdir -p "${APP_DIR}/data"

# --- 3. install Node.js 20 ----------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | sed 's/v//;s/\..*//')" -lt 18 ]; then
  echo
  echo "Installing Node.js 20 ..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg rsync
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js: $(node -v)"

# --- 4. create the always-on service ------------------------------------
echo
echo "Creating auto-start service ..."
cat > "${SERVICE}" <<EOF
[Unit]
Description=Souvenir Coin Kiosk - Fleet Admin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=5
Environment=FLEET_PORT=${PORT}
Environment=FLEET_ADMIN_USER=admin
Environment=FLEET_ADMIN_PASSWORD=${ADMIN_PASS}

[Install]
WantedBy=multi-user.target
EOF
chmod 600 "${SERVICE}"

systemctl daemon-reload
systemctl enable --now fleet-admin
sleep 2

# --- 5. firewall --------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  echo
  echo "Opening firewall (SSH, HTTP, HTTPS, ${PORT}) ..."
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow ${PORT}/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

# --- 6. report ----------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "========================================================"
systemctl --no-pager --lines=0 status fleet-admin | head -4 || true
echo "========================================================"
echo "  DONE. The Fleet Admin is running."
echo
echo "  Open in a browser (temporary, HTTP):"
echo "      http://${IP:-<server-ip>}:${PORT}"
echo "  Login:  admin  /  (the password you just set)"
echo
echo "  Next step: once fleet.coinkiosk.co.za points to this"
echo "  server, we switch on free HTTPS (run add-https.sh)."
echo "========================================================"
