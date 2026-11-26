#!/usr/bin/env bash
# Full system simulation. Run from anywhere:
#   bash simulation/run.sh <kiosk source root with node_modules> <path to jsdom>
# It never touches the real server data: the server is copied to a temp folder.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(dirname "$HERE")"
SRC="${1:-$ROOT}"; JSDOM_PATH="${2:-jsdom}"
W="$(mktemp -d)"; cp -r "$HERE" "$W/simulation"; chmod +x "$W/simulation/fakebin/"*
fresh(){ rm -rf "$W/$1"; cp -r "$ROOT/fleet-admin" "$W/$1"; rm -rf "$W/$1/data"; echo "$W/$1"; }
ESB="$SRC/node_modules/.bin/esbuild"
bundle(){ "$ESB" "$W/simulation/$1" --bundle --platform=node --format=cjs --outfile="$W/$2" --alias:electron="$W/simulation/mock-electron.ts" --alias:@electron-toolkit/utils="$W/simulation/mock-toolkit.ts" --alias:better-sqlite3="$W/simulation/mock-sqlite.ts" --alias:@src="$SRC/src" --external:serialport --external:electron-updater --external:node:sqlite --log-level=warning; }
echo "== 1. kiosk app: type check + production build"
( cd "$SRC" && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && echo "   type check clean" ) || echo "   TYPE CHECK FAILED"
( cd "$SRC" && npx electron-vite build >/dev/null 2>&1 && echo "   build ok" ) || echo "   BUILD FAILED"
echo "== 2. fleet server"; SRV_DIR="$(fresh srv)" node "$W/simulation/server-sim.mjs" 2>&1 | grep -v "^…"
echo "== 3. dashboard (every page and tab, 3 roles)"; SRV_DIR="$(fresh srvd)" JSDOM="$JSDOM_PATH" node "$W/simulation/dashboard-crawl.mjs" 2>&1
echo "== 4. kiosk + server end to end"; bundle kiosk-harness.ts harness.cjs && SRV_DIR="$(fresh srvk)" NODE_PATH="$SRC/node_modules" node --no-warnings "$W/harness.cjs" 2>&1 | grep -v "^\["
echo "== 5. network self-repair"
bundle nethealth-test.ts nh.cjs && sed -i 's/await sleep(5e3)/await sleep(20)/g; s/await sleep(4e3)/await sleep(20)/g; s/await sleep(1e4)/await sleep(20)/g' "$W/nh.cjs"
export NETSTATE="$W/netstate" NETMODE="$W/netmode" NETCALLS="$W/netcalls"
for mode in curable stuck; do
  echo down > "$NETSTATE"; echo $mode > "$NETMODE"; : > "$NETCALLS"
  OUT="$(PATH="$W/simulation/fakebin:$PATH" node --no-warnings "$W/nh.cjs" $mode 2>&1 | grep -v '^\[network\]')"
  if [ $mode = curable ]; then
    echo "$OUT" | grep -q "LOG back online" && grep -q "device connect enp1s0" "$NETCALLS" && echo "   PASS stuck 'connected (externally)' state is repaired and comes back online" || { echo "   FAIL curable case"; echo "$OUT" | tail -5; }
    grep -q "connection modify netplan-enp1s0 ipv4.dhcp-timeout 2147483647" "$NETCALLS" && echo "   PASS 'never give up' setting applied to the saved connection" || echo "   FAIL never-give-up setting not applied"
  else
    N=$(echo "$OUT" | grep -c "LOG repair #"); R=$(grep -c "systemctl" "$NETCALLS")
    [ "$N" -ge 3 ] && [ "$R" = 0 ] && echo "   PASS unrepairable fault: keeps retrying ($N repairs), never restarts the PC" || echo "   FAIL stuck case (repairs=$N restart commands=$R)"
  fi
done
rm -rf "$W"
