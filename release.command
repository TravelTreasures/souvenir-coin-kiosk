#!/usr/bin/env bash
#
# Souvenir Coin Kiosk — one-click release
# =======================================
# WHAT IT DOES: bumps the app version, tags it, and pushes to GitHub — which
# makes GitHub build the new AppImage and publish the update feed automatically.
#
# HOW TO USE:
#   1. Make your code change, then commit & push it in GitHub Desktop (as usual).
#   2. Double-click this file (it must live inside your souvenir-coin-kiosk repo folder).
#      • default   → a bug-fix bump   (1.20.0 → 1.20.1)
#   3. When the GitHub build goes green, open the dashboard → Updates,
#      add the new version to the registry, and Deploy.
#
# ADVANCED (optional): run it from Terminal with an argument to control the bump:
#      ./release.command minor      1.20.1 → 1.21.0   (new feature)
#      ./release.command major      1.21.0 → 2.0.0    (big change)
#      ./release.command 1.25.3     set an exact version
#
set -euo pipefail
cd "$(dirname "$0")"

GH_REPO="https://github.com/TravelTreasures/souvenir-coin-kiosk"
BUMP="${1:-patch}"

pause() { echo; read -n 1 -s -r -p "Press any key to close."; echo; }

echo "=================================================="
echo "  Souvenir Coin Kiosk — release"
echo "=================================================="
echo "Repo folder: $(pwd)"
echo

# --- checks ---------------------------------------------------------------
if [ ! -f package.json ]; then
  echo "❌ This isn't the repo folder (no package.json here)."
  echo "   Move release.command into your souvenir-coin-kiosk folder and try again."
  pause; exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ Node/npm not found. Open Terminal, 'cd' into this folder, and run ./release.command there."
  pause; exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "❌ git not found. Make sure GitHub Desktop (or git) is installed."
  pause; exit 1
fi

# Block only if there are uncommitted changes to TRACKED files (untracked
# helper files like this script are fine). Commit your code first in GitHub Desktop.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "⚠  You have uncommitted code changes."
  echo "   Commit & push them in GitHub Desktop first, then run this again."
  echo "   (Nothing was changed.)"
  pause; exit 1
fi

CURRENT=$(node -p "require('./package.json').version")
echo "Current version:  v$CURRENT"
echo "Bump type:        $BUMP"
echo
read -r -p "Create and publish the next release? [y/N] " ans
case "$ans" in
  y|Y) ;;
  *) echo "Cancelled — nothing changed."; pause; exit 0 ;;
esac

# --- bump + tag + push ----------------------------------------------------
# npm version updates package.json, makes a commit, and creates the git tag vX.Y.Z.
echo
echo "Bumping version ..."
NEWTAG=$(npm version "$BUMP" -m "Release v%s")
echo "New version:      $NEWTAG"

echo "Pushing commit + tag to GitHub ..."
git push
git push origin "$NEWTAG"

VER="${NEWTAG#v}"
echo
echo "=================================================="
echo "  ✅ Done — GitHub is building $NEWTAG now (~2–5 min)."
echo "=================================================="
echo "  Watch the build:   $GH_REPO/actions"
echo
echo "  When it goes green:"
echo "    Dashboard → Updates → Version registry: add  $VER  (stable) → Add"
echo "    Then choose a target and click Deploy."
echo
pause
