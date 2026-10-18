#!/usr/bin/env bash
#
# Souvenir Coin Kiosk - switch on free HTTPS for the Fleet Admin.
# Run this ONLY AFTER fleet.coinkiosk.co.za points to this server
# (DNS A record -> this server's IP). Run as root:
#
#   sudo bash add-https.sh
#
set -euo pipefail

DOMAIN=fleet.coinkiosk.co.za
PORT=9090

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo / as root."; exit 1; fi

echo "Checking that ${DOMAIN} points here ..."
RESOLVED="$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -1 || true)"
MYIP="$(hostname -I | awk '{print $1}')"
echo "  ${DOMAIN} -> ${RESOLVED:-<nothing yet>}   (this server: ${MYIP})"
if [ -z "${RESOLVED}" ]; then
  echo "DNS does not resolve yet. Wait until it does, then re-run. Aborting."
  exit 1
fi

# --- install Caddy (automatic Let's Encrypt HTTPS) ----------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "Installing Caddy ..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# --- configure Caddy as a reverse proxy to the Fleet Admin --------------
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:${PORT}
}
EOF

systemctl restart caddy
sleep 3
systemctl --no-pager --lines=0 status caddy | head -4 || true

echo
echo "========================================================"
echo "  HTTPS is on (Caddy gets the certificate automatically)."
echo "  Your fleet server:  https://${DOMAIN}"
echo
echo "  In each kiosk's fleet settings, use:"
echo "      https://${DOMAIN}"
echo
echo "  You can now close port ${PORT} if you like:"
echo "      ufw delete allow ${PORT}/tcp"
echo "========================================================"
