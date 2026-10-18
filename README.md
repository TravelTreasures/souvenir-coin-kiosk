# Souvenir Coin Kiosk

Full-screen touchscreen kiosk application for selling souvenir coins, with MDB hopper dispensing and Nayax POS payment integration.

**Production target: Ubuntu / Linux (x64) — recommended; Windows (x64) also supported**
**Development / testing: macOS (MacBook Pro)**

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 31 |
| UI framework | React 18 + TypeScript |
| Build tool | electron-vite |
| Database | SQLite via better-sqlite3 |
| Hardware (MDB) | serialport (production) / in-memory mock (dev) |
| Payment | Nayax VPOS protocol (production) / simulator (dev) |

---

## Prerequisites

Install on your **MacBook Pro** for development and testing:

- **Node.js 20+** – https://nodejs.org
- **npm 10+** (bundled with Node)

```bash
node -v   # should print v20.x or higher
npm -v    # should print 10.x or higher
```

To **build the Windows installer** from macOS you also need Wine and the Windows build tools — or use a Windows machine / CI pipeline. See the Production Build section below.

---

## Install

```bash
cd "Souvenir Coin Kiosk Application"
npm install

# Rebuild native modules (better-sqlite3 and serialport) for Electron
npm run rebuild
```

> If `electron-rebuild` fails, install it globally first:
> ```bash
> npm install -g electron-rebuild
> ```

---

## Run in Development (with Simulator)

```bash
npm run dev
```

This opens **two windows**:

1. **Kiosk window** – the full customer-facing UI (1080 × 1920 in windowed mode during dev)
2. **Hardware Simulator** – controls payment and hopper responses without real hardware

### Using the Simulator

When the kiosk reaches the **Payment screen**, click **▶ Simulate Card Tap** in the simulator window to send a payment response.

| Simulator control | What it does |
|---|---|
| Payment result toggle | Sets the next payment to Approved / Declined / Comm Error |
| Simulate Card Tap | Fires the payment response (replaces physically tapping a card) |
| Hopper status toggle | Sets OK / Empty / Jam / Offline per hopper |
| Coin count slider | Adjusts simulated coin inventory |
| Quick Scenarios | One-click preset test cases |

### Admin Panel

From the home screen, **tap the top-right corner 5 times** rapidly to open the PIN prompt.
Default PIN: **1234** (change in `src/renderer/src/components/AdminPIN.tsx`).

---

## Changing Coin Images

The coin images are bundled into the app at build time. To change them, replace these files
(keep the same names) and rebuild:

```
src/renderer/src/assets/
  coin1.png    ← image for Coin 1
  coin2.png    ← image for Coin 2
```

PNG with a transparent background works best. Recommended size: 500 × 500 px minimum.
If an image fails to load, the app shows a CSS gold-coin placeholder automatically.

---

## Building & Installing

### macOS DMG (for testing on your MacBook Pro)

```bash
npm run dist:mac
```

Output is in `dist/`. You get:

```
dist/
  Souvenir Coin Kiosk-1.0.0-arm64.dmg   ← Apple Silicon (M1/M2/M3)
  Souvenir Coin Kiosk-1.0.0.dmg         ← Intel x64
```

**To install:** open the `.dmg`, drag the app to `/Applications`, eject the disk image.

**To uninstall:** drag `Souvenir Coin Kiosk.app` from `/Applications` to the Trash. To also remove the database and settings:
```bash
rm -rf ~/Library/Application\ Support/souvenir-coin-kiosk
```

### Windows Installer (production kiosk PC)

```bash
npm run dist:win
```

Output: `dist/Souvenir Coin Kiosk Setup 1.0.0.exe` — a one-click NSIS installer.

**To uninstall on Windows:** Settings → Apps → Souvenir Coin Kiosk → Uninstall.

> **Cross-compiling from macOS to Windows:** electron-builder can attempt this, but native modules (`better-sqlite3`, `serialport`) need to be compiled for Windows. The safest approach is to **run `npm run dist:win` on a Windows machine** or a CI pipeline with a Windows runner.

### Ubuntu / Linux (recommended production target)

Linux (Ubuntu) is a strong production target for 24/7 kiosks: stable, no licensing cost,
easy to lock into true kiosk mode, no surprise updates/restarts, good remote management, and
solid MDB support via USB-to-serial. The same app, in-app Admin panel, and web dashboard all
run unchanged.

**Build on an Ubuntu machine** (native modules must be compiled for Linux — don't cross-compile
from macOS):

```bash
# One-time: build tools for the native modules
sudo apt update
sudo apt install -y build-essential python3

# In the project folder
npm install
npm run dist:linux
```

Output in `dist/`:
- `Souvenir Coin Kiosk-<version>.AppImage` — single portable file; great for kiosks
  (`chmod +x` it, then run). No installation required.
- `souvenir-coin-kiosk_<version>_amd64.deb` — system package: `sudo apt install ./<file>.deb`.

**MDB hardware on Linux:** the USB-to-MDB adapter shows up as a serial device, typically
`/dev/ttyUSB0`. Point the app at it and give the app user serial access:

```bash
sudo usermod -aG dialout $USER     # then log out/in once
MDB_PORT=/dev/ttyUSB0 ./Souvenir\ Coin\ Kiosk-<version>.AppImage
```

**True kiosk lockdown on Ubuntu:** unlike macOS (where Cmd+Tab/Spotlight can't be fully
blocked by an app), Ubuntu can be fully locked down — run the AppImage in a dedicated kiosk
session/autostart, disable the desktop's hotkeys/switching, and the app's own kiosk mode
handles the rest. Set `KIOSK_MODE=kiosk` (or switch via Admin → System) for the locked
full-screen experience.

> **Linux icon:** uses `assets/icon.png` (a 512×512 PNG is ideal).

### Icon files needed before building

electron-builder requires icon files at these paths (create the `assets/` folder if it doesn't exist):

| File | Used for | Size |
|---|---|---|
| `assets/icon.icns` | macOS app icon | 512×512 (ICNS format) |
| `assets/icon.ico` | Windows app icon | 256×256 (ICO format) |
| `assets/icon.png` | Linux app icon | 512×512 (PNG) |
| `assets/dmg-background.png` | DMG window background | 540×380 px — optional |

If you skip the icons, remove the `"icon"` lines from `package.json` before building and electron-builder will use a default icon.

### Kiosk Mode

In production (`npm run build` + `electron-vite preview` or packaged app), the app launches in **full-screen kiosk mode** automatically (no title bar, no menu, OS-level lock). During development it runs in a regular resizable window.

---

## Connecting Real Hardware

### MDB Hoppers

MDB uses a 9-bit serial protocol. Standard serial ports don't support 9-bit natively, so you need a **USB-to-MDB bridge adapter** (examples: ICKE USB-MDB, CPI MDB adapter, or a custom Arduino MDB master).

**On Windows (production kiosk):**
1. Plug the USB-MDB adapter into the kiosk PC.
2. Open **Device Manager → Ports (COM & LPT)** to find the assigned COM port (e.g. `COM3`).
3. Set the port via environment variable or update the default in `src/main/index.ts`:
   ```
   MDB_PORT=COM5 npm run dev
   ```
4. Implement `parseMDBResponse()` in `src/main/mdb/MDBController.ts` to match your adapter's framing.
5. Set `is.dev` to `false` in the `MDBController` constructor call to switch off simulation.

**On macOS (dev/testing):**
- The simulator replaces the MDB bus entirely — no adapter needed.
- If you want to test with a real adapter on macOS, the port path looks like `/dev/tty.usbserial-XXXX`.

### Nayax POS Terminal

1. Obtain the Nayax SDK from the [Nayax Partner Portal](https://partners.nayax.com).
2. Place the SDK package in `vendor/nayax-sdk/` and add it to `package.json`:
   ```json
   "nayax-sdk": "file:./vendor/nayax-sdk"
   ```
3. Open `src/main/nayax/NayaxController.ts` and implement the `connect()` and `requestSale()` methods using the SDK.
4. Set environment variables:
   ```bash
   NAYAX_TERMINAL_ID=your-terminal-id
   NAYAX_API_KEY=your-api-key
   ```

---

## File Structure

```
src/
  main/                       Electron main process
    index.ts                  Entry point: windows, app mode, startup
    ipc.ts                    IPC handlers (renderer ↔ main)
    config/
      Config.ts               Kiosk config (coin price, etc.)
    database/
      Database.ts             SQLite schema + queries (degrades gracefully)
    mdb/
      MDBController.ts         MDB protocol + simulation
    nayax/
      NayaxController.ts       Nayax payment + simulation
    server/
      AdminServer.ts          Built-in web Admin Dashboard server
  preload/
    index.ts / index.d.ts     Kiosk window preload (exposes window.kiosk)
    simulator.ts              Simulator window preload (exposes window.sim)
  renderer/
    index.html
    simulator/
      index.html              Self-contained Hardware Simulator UI
    src/
      App.tsx                 Screen router
      main.tsx                React entry
      types.ts                Shared TypeScript types
      env.d.ts                Vite type references
      screens/
        HomeScreen.tsx
        CoinSelectScreen.tsx
        PaymentScreen.tsx
        ThankYouScreen.tsx
        ErrorScreen.tsx
        AdminScreen.tsx       Admin panel (Hoppers/Sales/Transactions/Alerts/Diagnostics/System)
      components/
        CoinImage.tsx         Coin image with CSS fallback
        AdminPIN.tsx          PIN entry overlay
      assets/
        coin1.png / coin2.png Coin images (bundled at build time)
      styles/
        global.css
scripts/
  copy-simulator.mjs          Copies simulator HTML into the build output
assets/
  icon.icns / icon.ico / icon.png   App icons (macOS / Windows / Linux)
```

---

## Changing the Coin Price

Edit `COIN_PRICE_CENTS` in `src/main/ipc.ts`:

```ts
const COIN_PRICE_CENTS = 9000  // R90.00  →  change to e.g. 5000 for R50.00
```

The payment screen reads this value via the IPC result so it updates automatically.

---

## Web Admin Dashboard

The kiosk runs a built-in web server so you can view the same admin data and make changes
(refill hoppers, resolve refund alerts, view sales/transactions/diagnostics) from a browser
on another device — no extra software to install.

### Open it

1. Start the kiosk app. On startup it prints the dashboard URLs to the console, e.g.:
   ```
   [web] Admin dashboard available at:
         • http://localhost:8787
         • http://192.168.1.42:8787  (LAN)
   ```
2. On a device on the same network, open the `http://<kiosk-ip>:8787` URL.
3. Log in with the dashboard password.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_WEB_PASSWORD` | `kiosk-admin` | Dashboard login password — **change this** |
| `ADMIN_WEB_PORT` | `8787` | Port the server listens on |
| `ADMIN_WEB_ENABLED` | (on) | Set to `false` to disable the web server |

Example (dev): `ADMIN_WEB_PASSWORD=mySecret123 npm run dev`

### Accessing it over the internet (securely)

The built-in server is plain HTTP and is intended to sit behind a secure tunnel — **do not
port-forward it directly to the internet.** Recommended options:

- **Cloudflare Tunnel** (free): install `cloudflared` on the kiosk and run
  `cloudflared tunnel --url http://localhost:8787`. You get an HTTPS URL that proxies to the
  dashboard without opening any router ports.
- **Tailscale** (private mesh VPN): install on the kiosk and your devices; reach the dashboard
  at the kiosk's Tailscale IP. Nothing is exposed publicly.

Always set a strong `ADMIN_WEB_PASSWORD` before exposing the dashboard.

---

## Database Location

SQLite database (`kiosk.db`) is stored in the Electron **userData** directory:

| Platform | Path |
|---|---|
| **Windows (production)** | `C:\Users\<user>\AppData\Roaming\souvenir-coin-kiosk\kiosk.db` |
| **macOS (dev/testing)** | `~/Library/Application Support/souvenir-coin-kiosk/kiosk.db` |

Use any SQLite viewer (e.g. [DB Browser for SQLite](https://sqlitebrowser.org)) to inspect it directly.

---

## Error Reference

| Error displayed | Cause | Recovery |
|---|---|---|
| Payment Failed | Card declined by Nayax | Customer retries |
| Payment Terminal Unavailable | Nayax comm error / timeout | Return home, contact staff |
| Selected Coin Currently Unavailable | Hopper empty | Choose other coin |
| Dispensing Error (contact staff) | Hopper jam | Staff intervention |
| Machine Communication Error | MDB bus failure | Staff intervention |
| Payment taken – coin not dispensed | Critical: payment OK, dispense failed | Auto-logged + alert; staff refund |
