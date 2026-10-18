#!/bin/bash
#
# Souvenir Coin Kiosk — Uninstaller (macOS)
# Double-click this file to remove the installed app and all its data.
#

APP="/Applications/Souvenir Coin Kiosk.app"
DATA="$HOME/Library/Application Support/souvenir-coin-kiosk"

echo "──────────────────────────────────────────"
echo "  Uninstalling Souvenir Coin Kiosk"
echo "──────────────────────────────────────────"
echo ""

# Quit the app if it is running
osascript -e 'quit app "Souvenir Coin Kiosk"' 2>/dev/null
sleep 1

if [ -d "$APP" ]; then
  rm -rf "$APP"
  echo "  ✓ Removed app from /Applications"
else
  echo "  • App not found in /Applications (already removed)"
fi

if [ -d "$DATA" ]; then
  rm -rf "$DATA"
  echo "  ✓ Removed database and settings"
else
  echo "  • No app data found"
fi

echo ""
echo "  Done. Souvenir Coin Kiosk has been uninstalled."
echo "  You can close this window."
echo ""
