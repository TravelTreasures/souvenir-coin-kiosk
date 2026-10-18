#!/bin/bash
# Post-install script for the Souvenir Coin Kiosk .deb package.
#
# Sets the SUID bit on Electron's sandbox helper (chrome-sandbox), which the
# default Debian post-install step does not do reliably. Without it, Chromium
# refuses to start ("The SUID sandbox helper binary ... is not configured
# correctly"). This runs automatically on every install/upgrade, so no manual
# chown/chmod is ever needed on a new kiosk. It also re-registers the /usr/bin
# launcher symlink.
#
# NOTE: use only literal paths here. electron-builder runs a macro substitution
# (dollar-brace tokens) over this script at build time, so any shell-variable
# syntax using dollar-brace would be misread as an undefined macro and break the
# build. Keep every path spelled out in full.

set -e

# Launcher symlink in /usr/bin
update-alternatives --install /usr/bin/souvenir-coin-kiosk souvenir-coin-kiosk /opt/Souvenir-Coin-Kiosk/souvenir-coin-kiosk 100 || true

# The critical fix: Electron's sandbox helper must be root-owned and SUID 4755.
if [ -f /opt/Souvenir-Coin-Kiosk/chrome-sandbox ]; then
  chown root:root /opt/Souvenir-Coin-Kiosk/chrome-sandbox || true
  chmod 4755 /opt/Souvenir-Coin-Kiosk/chrome-sandbox || true
fi

# Refresh desktop / mime caches so the menu icon appears immediately.
update-mime-database /usr/share/mime || true
update-desktop-database /usr/share/applications || true

exit 0
