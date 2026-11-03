#!/usr/bin/env bash
# =============================================================================
# Souvenir Coin Kiosk — turnkey lockdown provisioning
# -----------------------------------------------------------------------------
# Turns a freshly-installed kiosk into an unattended appliance:
#   1. Never sleeps, never blanks the screen, never shows a lock screen.
#   2. Boots straight to the desktop with NO password (auto-login).
#   3. Launches the app FULL-SCREEN in kiosk mode automatically on login.
#   4. Gives the kiosk user serial-port access (for the hopper + Nayax).
#   5. Never suspends at the system level.
#
# Run this ONCE per kiosk, in the kiosk's own Terminal (inside the desktop
# session — e.g. over AnyDesk), as the normal kiosk user.  Do NOT run it with
# sudo; it will ask for the password itself where root is needed.  It is safe
# to re-run at any time (idempotent).
#
#   bash setup-kiosk.sh                 # auto-detects the AppImage
#   bash setup-kiosk.sh /path/to.AppImage   # or point it at one explicitly
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/souvenir-kiosk"
APP="$APP_DIR/Souvenir-Coin-Kiosk.AppImage"
ICON="$HOME/.local/share/icons/souvenir-coin-kiosk.png"
DESKTOP_ID="souvenir-coin-kiosk.desktop"

echo "== Souvenir Coin Kiosk — kiosk lockdown =="

if [ "$(id -u)" = "0" ]; then
  echo "ERROR: run this as the kiosk user, NOT with sudo." >&2
  exit 1
fi

# --- 1. Locate / normalise the AppImage --------------------------------------
# A fixed filename means autostart and OTA updates never break when the version
# number changes (electron-updater replaces the file in place, keeping the name).
REPO_SLUG="TravelTreasures/souvenir-coin-kiosk"
mkdir -p "$APP_DIR"
if [ "${1:-}" != "" ] && [ -f "$1" ]; then
  echo "Using supplied AppImage: $1 -> $APP"
  mv -f "$1" "$APP"
elif [ ! -f "$APP" ]; then
  CAND=$(ls -1t "$APP_DIR"/*.AppImage "$HOME/Downloads"/*.AppImage 2>/dev/null | head -1 || true)
  if [ -n "${CAND:-}" ]; then
    echo "Found AppImage: $CAND -> $APP"
    mv -f "$CAND" "$APP"
  fi
fi
# Nothing local? Fetch the latest release straight from GitHub.
if [ ! -f "$APP" ]; then
  echo "No local AppImage — downloading the latest release…"
  DL=$(curl -fsSL "https://api.github.com/repos/$REPO_SLUG/releases/latest" 2>/dev/null \
        | grep -oE 'https://[^"]+\.AppImage' | head -1 || true)
  if [ -n "${DL:-}" ]; then
    curl -L -o "$APP" "$DL" && echo "[ok] downloaded: $DL"
  else
    echo "[!!] could not resolve a download URL (no internet?)."
  fi
fi
if [ -f "$APP" ]; then
  chmod +x "$APP"
  echo "[ok] app: $APP"
else
  echo "[!!] $APP not found. Put the AppImage in $APP_DIR and re-run."
fi

# --- 2. No sleep / no screen blank / no lock (runs in the user session) ------
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
echo "[ok] screen blanking, sleep and lock screen disabled"

# --- 3. Never suspend at the system level ------------------------------------
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
echo "[ok] system suspend/hibernate targets masked"

# --- 4. Auto-login (no password at boot) -------------------------------------
sudo bash -c "printf '[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin=%s\n' '$USER' > /etc/gdm3/custom.conf"
echo "[ok] auto-login enabled for user: $USER"

# --- 5. Serial-port access for the hopper + Nayax ----------------------------
sudo usermod -aG dialout "$USER"
echo "[ok] $USER added to the 'dialout' group (serial ports)"

# --- 6. App icon + menu/dock launcher ----------------------------------------
# Install a stable icon (shipped next to this script, or pulled out of the
# AppImage as a fallback) and a .desktop launcher so the app shows up in the
# applications grid with its proper icon.
mkdir -p "$HOME/.local/share/icons" "$HOME/.local/share/applications"
if [ -f "$SCRIPT_DIR/souvenir-coin-kiosk.png" ]; then
  cp -f "$SCRIPT_DIR/souvenir-coin-kiosk.png" "$ICON"
elif [ -f "$APP" ]; then
  # Fallback: extract an icon from inside the AppImage.
  TMP=$(mktemp -d)
  ( cd "$TMP" && "$APP" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 || true )
  PNG=$(find "$TMP" -name '*.png' 2>/dev/null | sort -t/ -k99 | tail -1 || true)
  [ -n "${PNG:-}" ] && cp -f "$PNG" "$ICON"
  rm -rf "$TMP"
fi
[ -f "$ICON" ] && echo "[ok] icon installed: $ICON" || echo "[!!] no icon found (launcher still works, generic icon)"

cat > "$HOME/.local/share/applications/$DESKTOP_ID" <<EOF
[Desktop Entry]
Type=Application
Name=Souvenir Coin Kiosk
Comment=Souvenir coin vending kiosk
Exec=env KIOSK_MODE=kiosk $APP --no-sandbox
Icon=$ICON
Terminal=false
Categories=Utility;
StartupWMClass=Souvenir-Coin-Kiosk
EOF
update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
echo "[ok] launcher installed (shows in the app menu)"

# Also drop a clickable icon on the Desktop itself.
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
mkdir -p "$DESKTOP_DIR"
cp -f "$HOME/.local/share/applications/$DESKTOP_ID" "$DESKTOP_DIR/$DESKTOP_ID"
chmod +x "$DESKTOP_DIR/$DESKTOP_ID"
gio set "$DESKTOP_DIR/$DESKTOP_ID" metadata::trusted true 2>/dev/null || true
echo "[ok] icon placed on the Desktop"

# Pin it to the GNOME dock (the side bar / favourites).
CUR=$(gsettings get org.gnome.shell favorite-apps 2>/dev/null || echo "@as []")
if [[ "$CUR" != *"$DESKTOP_ID"* ]]; then
  if [[ "$CUR" == "@as []" || "$CUR" == "[]" ]]; then
    gsettings set org.gnome.shell favorite-apps "['$DESKTOP_ID']"
  else
    gsettings set org.gnome.shell favorite-apps "${CUR%]}, '$DESKTOP_ID']"
  fi
  echo "[ok] pinned to the dock (side bar)"
else
  echo "[ok] already pinned to the dock"
fi

# --- 7. Autostart the app full-screen in kiosk mode --------------------------
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/souvenir-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Souvenir Coin Kiosk
Comment=Launches the kiosk full-screen in locked kiosk mode
Exec=bash -c 'sleep 12; exec env KIOSK_MODE=kiosk $APP --no-sandbox'
Icon=$ICON
X-GNOME-Autostart-enabled=true
Terminal=false
EOF
echo "[ok] autostart installed (full-screen kiosk mode, 12s hardware-settle delay)"

cat <<'DONE'

-----------------------------------------------------------------------------
Done. Reboot to verify the full chain:
  power on -> auto-login -> app opens full-screen, no sleep, no lock.

To leave kiosk mode for maintenance (keyboard required):
  Ctrl+Alt+Shift+Q   quit the app
  Ctrl+Alt+Shift+D   drop to windowed TEST mode
  Ctrl+Alt+Shift+K   back to locked kiosk mode

The dialout (serial) change needs ONE logout/login to take effect — the
reboot above covers it.
-----------------------------------------------------------------------------
DONE
