import { app, BrowserWindow, shell, ipcMain, globalShortcut, Menu } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { HopperController, simSetHopperCoinCount } from './hopper/HopperController'
import { NayaxController } from './nayax/NayaxController'
import { getHopperCount, setHopperCount } from './database/Database'
import { setupIPC, isSaleInProgress } from './ipc'
import { startAdminServer } from './server/AdminServer'
import { startFleetSync } from './fleet/FleetSync'
import { initUpdater } from './update/UpdateController'
import { detectPorts, type PortAssignment } from './hardware/portDetect'

// ------------------------------------------------------------------
// App mode: 'kiosk' (production lockdown) vs 'dev' (test mode)
// ------------------------------------------------------------------
// Resolution order:
//   1. KIOSK_MODE env var  (kiosk|1|true  ·  dev|0|false)
//   2. Persisted setting written by the Admin panel / shortcuts
//   3. Default: dev when running under electron-vite dev, kiosk when packaged
//
// In DEV mode the app behaves like a normal macOS window: it can be
// closed, minimized, and you can Cmd+Tab away. In KIOSK mode it is
// locked full-screen with no frame and close/minimize disabled.
// ------------------------------------------------------------------
type AppMode = 'kiosk' | 'dev'

// Raspberry Pi 5 (Linux arm64) only: Chromium leaves GPU acceleration OFF on this
// hardware by default, so every animation frame is drawn by the CPU and touches
// are handled late. Switch the GPU on for compositing + rasterisation. The x86
// mini-PCs already accelerate and are NOT touched. Must run before app 'ready'.
// Escape hatch: start with KIOSK_GPU=off to go back to the previous behaviour.
const IS_PI = process.platform === 'linux' && process.arch === 'arm64'
if (IS_PI && process.env.KIOSK_GPU !== 'off') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
}

// Serial port for the ccTalk hopper interface (SuzoHapp 107-0251 in USB→ccTalk
// mode). HOPPER_PORT is the preferred env var; MDB_PORT is kept as a fallback
// for older configs. On Linux a USB serial adapter is usually /dev/ttyUSB0 —
// run `ls /dev/serial/by-id/` on the kiosk to find the exact port.
const HOPPER_SERIAL_PATH = process.env.HOPPER_PORT ?? process.env.MDB_PORT ?? '/dev/ttyUSB0'
// Serial port for the Nayax card reader via the Waferstar MDB-RS232 adapter.
// Also a USB serial port — a DIFFERENT one from the hopper interface. Use
// stable names from `ls /dev/serial/by-id/` on the kiosk to pin each device.
const NAYAX_SERIAL_PATH = process.env.NAYAX_PORT ?? '/dev/ttyUSB1'

let appMode: AppMode = 'dev'
let allowQuit = false
let mainWindow: BrowserWindow | null = null
let simWindow: BrowserWindow | null = null

const isKiosk = (): boolean => appMode === 'kiosk'

function modeFilePath(): string {
  return join(app.getPath('userData'), 'app-mode.json')
}

function readPersistedMode(): AppMode | null {
  try {
    const p = modeFilePath()
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf8'))
      if (data.mode === 'kiosk' || data.mode === 'dev') return data.mode
    }
  } catch {
    /* ignore – fall back to default */
  }
  return null
}

function writePersistedMode(mode: AppMode): void {
  try {
    writeFileSync(modeFilePath(), JSON.stringify({ mode }), 'utf8')
  } catch (err) {
    console.error('[mode] could not persist mode:', err)
  }
}

function resolveMode(): AppMode {
  const env = process.env.KIOSK_MODE?.toLowerCase()
  if (env === 'dev' || env === '0' || env === 'false') return 'dev'
  if (env === 'kiosk' || env === '1' || env === 'true') return 'kiosk'

  const persisted = readPersistedMode()
  if (persisted) return persisted

  // Default is TEST mode so the app never traps you on first launch.
  // Kiosk lockdown is opt-in: enable it from Admin > System, the
  // ⌘/Ctrl+Alt+Shift+K shortcut, or KIOSK_MODE=kiosk before deploying.
  return 'dev'
}

/** Switch mode, persist it, and relaunch so window flags apply cleanly. */
function switchMode(mode: AppMode): void {
  appMode = mode
  writePersistedMode(mode)
  allowQuit = true
  app.relaunch()
  app.exit(0)
}

// Hardware controllers. A real kiosk uses the physical MDB hopper + Nayax
// reader. Simulation runs ONLY in dev, or when explicitly requested for bench
// testing without hardware attached (set SIMULATE_HARDWARE=true). In a normal
// production install the app talks to the real hardware and the Hardware
// Simulator window never appears.
const USE_SIMULATION = is.dev || process.env.SIMULATE_HARDWARE === 'true'
const mdb = new HopperController(HOPPER_SERIAL_PATH, USE_SIMULATION)
const nayax = new NayaxController(NAYAX_SERIAL_PATH, USE_SIMULATION)

// Serial-port auto-detection (real hardware only). Skipped when the ports are
// pinned explicitly with HOPPER_PORT / NAYAX_PORT.
const PORTS_PINNED = !!(process.env.HOPPER_PORT || process.env.MDB_PORT || process.env.NAYAX_PORT)
let portInfo: PortAssignment = {
  hopper: HOPPER_SERIAL_PATH,
  nayax: NAYAX_SERIAL_PATH,
  verified: false,
  note: PORTS_PINNED ? 'Ports fixed by configuration' : 'Not checked yet'
}

/**
 * Find out which USB serial adapter the hoppers are really on and point both
 * controllers at the right ports. Both ports must be CLOSED when this runs.
 */
async function assignSerialPorts(): Promise<void> {
  if (USE_SIMULATION || PORTS_PINNED) return
  try {
    portInfo = await detectPorts({ hopper: mdb.getSerialPath() ?? HOPPER_SERIAL_PATH, nayax: nayax.getSerialPath() ?? NAYAX_SERIAL_PATH })
    mdb.setSerialPath(portInfo.hopper)
    nayax.setSerialPath(portInfo.nayax)
    console.log(`[ports] ${portInfo.note}`)
  } catch (e) {
    console.error('[ports] detection failed:', (e as Error)?.message ?? e)
  }
}

function createMainWindow(): void {
  const kioskOn = isKiosk()

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 1920,
    fullscreen: kioskOn,
    kiosk: kioskOn,
    resizable: !kioskOn,
    minimizable: !kioskOn,
    maximizable: !kioskOn,
    closable: !kioskOn,
    autoHideMenuBar: kioskOn,
    frame: !kioskOn,
    title: kioskOn ? 'Souvenir Coin Kiosk' : 'Souvenir Coin Kiosk — TEST MODE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Keep renderer timers (config re-poll, coin-image refresh, marketing) running
      // at full rate while the kiosk sits idle. Without this, Chromium throttles an
      // un-interacted window's timers, so fleet changes only appeared after a touch.
      backgroundThrottling: false
    },
    backgroundColor: '#0a1628'
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // In kiosk mode, swallow the common "escape" keyboard shortcuts that
  // the web contents can see. (OS-level combos like Cmd+Tab / Cmd+Space
  // must be disabled at the macOS level — see RELEASE_NOTES.md.)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isKiosk()) return
    const mod = input.meta || input.control
    const key = (input.key || '').toLowerCase()
    if (mod && ['q', 'w', 'm', 'h', 'r', 'tab'].includes(key)) event.preventDefault()
    if (key === 'f11') event.preventDefault()
  })

  // Block window close in kiosk mode unless an internal action allowed it.
  mainWindow.on('close', (e) => {
    if (isKiosk() && !allowQuit) e.preventDefault()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createSimulatorWindow(): void {
  simWindow = new BrowserWindow({
    width: 520,
    height: 700,
    title: 'Hardware Simulator',
    resizable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/simulator.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const simHtml = is.dev
    ? join(__dirname, '../../src/renderer/simulator/index.html')
    : join(__dirname, '../renderer/simulator/index.html')
  simWindow.loadFile(simHtml)

  simWindow.on('closed', () => {
    simWindow = null
  })
}

// ------------------------------------------------------------------
// App-control IPC (used by the Admin > System panel)
// ------------------------------------------------------------------
function registerAppControlIPC(): void {
  ipcMain.handle('app:getMode', () => appMode)
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('app:getPortInfo', () => portInfo)
  // Whether Chromium is drawing with the GPU (shown in Admin → Diagnostics).
  ipcMain.handle('app:getGraphicsStatus', () => {
    try {
      const st = app.getGPUFeatureStatus() as unknown as Record<string, string>
      const comp = String(st.gpu_compositing ?? 'unknown')
      const rast = String(st.rasterization ?? 'unknown')
      return { accelerated: comp.startsWith('enabled'), detail: `compositing ${comp} · raster ${rast}` }
    } catch {
      return { accelerated: false, detail: 'unknown' }
    }
  })
  ipcMain.handle('app:setMode', (_e, mode: AppMode) => {
    switchMode(mode === 'dev' ? 'dev' : 'kiosk')
    return { ok: true }
  })
  ipcMain.handle('app:quit', () => {
    allowQuit = true
    app.quit()
    return { ok: true }
  })
  ipcMain.handle('app:restart', () => {
    allowQuit = true
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('app:minimize', () => {
    mainWindow?.minimize()
    return { ok: true }
  })
}

// ------------------------------------------------------------------
// Global "service" shortcuts — work even in locked kiosk mode so a
// technician can always recover without restarting the machine.
//   Cmd/Ctrl+Alt+Shift+Q → quit
//   Cmd/Ctrl+Alt+Shift+D → switch to Dev/Test mode (relaunch)
//   Cmd/Ctrl+Alt+Shift+K → switch to Kiosk mode (relaunch)
// ------------------------------------------------------------------
function registerServiceShortcuts(): void {
  globalShortcut.register('CommandOrControl+Alt+Shift+Q', () => {
    allowQuit = true
    app.quit()
  })
  globalShortcut.register('CommandOrControl+Alt+Shift+D', () => switchMode('dev'))
  globalShortcut.register('CommandOrControl+Alt+Shift+K', () => switchMode('kiosk'))
}

// Single-instance guard. A second copy of the app (a stray autostart, a leftover
// from an OTA relaunch, or a manual launch) would fight the running one for the
// serial ports — the loser reports "Cannot lock port" and shows the hoppers/Nayax
// OFFLINE even though the hardware is fine. Only one instance may run; any extra
// launch quits immediately and hands focus to the one already running.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  appMode = resolveMode()

  // Strip the application menu in kiosk mode; keep the default (Cmd+Q,
  // DevTools, etc.) in dev so testing is comfortable.
  if (isKiosk()) Menu.setApplicationMenu(null)

  // Connect each device independently so a missing/unwired one (e.g. the Nayax
  // before its converter arrives, or a loose cable) never stops the other — or
  // the app window — from starting. Each just shows offline.
  // Work out which USB adapter is which BEFORE opening them (the /dev/ttyUSB
  // names are not stable across a reboot).
  await assignSerialPorts()
  try { await mdb.connect() } catch (err) { console.error('[startup] hopper connect failed (offline):', (err as Error)?.message ?? err) }
  try { await nayax.connect() } catch (err) { console.error('[startup] Nayax connect failed (offline):', (err as Error)?.message ?? err) }

  // Reconcile hopper counts so the kiosk and the Fleet Admin always agree.
  // The MDB controller and the DB are two separate stores; align them at boot:
  // restore a persisted DB count into the live controller, or seed the DB from
  // the controller's current count when the DB is empty/new.
  for (const id of [1, 2] as const) {
    const addr = id === 1 ? HopperController.HOPPER_1_ADDR : HopperController.HOPPER_2_ADDR
    const dbCount = getHopperCount(id)
    if (dbCount <= 0 && USE_SIMULATION) {
      // Bench/dev simulation only: start with stock so the simulator can sell.
      simSetHopperCoinCount(addr, 500)
      setHopperCount(id, 500)
    } else {
      // Real kiosk: the DB is the single source of truth — INCLUDING zero. A new
      // kiosk starts at 0 until it is refilled on site, and an emptied hopper
      // stays empty across restarts (it used to come back as 500).
      simSetHopperCoinCount(addr, dbCount)
    }
  }

  setupIPC(mdb, nayax)
  registerAppControlIPC()
  registerServiceShortcuts()
  startAdminServer(mdb, nayax)
  // OTA: the updater treats the kiosk as idle whenever a purchase isn't in flight.
  initUpdater(() => !isSaleInProgress())
  startFleetSync(mdb, nayax)
  createMainWindow()

  // Hardware watchdog. The USB serial devices and the hoppers can take several
  // seconds to be ready after boot, so a single connect at startup sometimes
  // leaves them offline until a manual relaunch. This retries on a timer —
  // reconnecting a dropped bus and re-initialising any offline hopper — so the
  // hardware comes online on its own once ready (no restart), and also recovers
  // from a transient disconnect during the day. Runs only with real hardware.
  if (!USE_SIMULATION) {
    let watchdogBusy = false
    let allOfflineTicks = 0
    setInterval(() => {
      if (watchdogBusy) return // a previous pass is still running
      watchdogBusy = true
      void (async () => {
        try {
          if (!mdb.isConnected()) await mdb.connect().catch(() => undefined)
          // Retry ANY offline hopper (it used to retry only when BOTH were
          // offline, so a single hopper that missed start-up never came back).
          // Not during a sale, so the retry can't interleave with a dispense.
          else if (mdb.anyHopperOffline() && !isSaleInProgress()) await mdb.reinitOfflineHoppers()
        } catch {
          /* ignore — retry next tick */
        }
        try {
          if (!nayax.isConnected()) await nayax.connect().catch(() => undefined)
        } catch {
          /* ignore — retry next tick */
        }
        // NO hopper answering at all for ~30s? Then we may be on the wrong USB
        // adapter (the port names swapped). Close both ports, find the hoppers
        // again, and reconnect on the right ones. Nothing can be sold while the
        // hoppers are offline anyway, so briefly re-opening the reader is safe.
        try {
          allOfflineTicks = mdb.anyHopperOnline() ? 0 : allOfflineTicks + 1
          if (allOfflineTicks >= 4 && !PORTS_PINNED && !isSaleInProgress()) {
            allOfflineTicks = 0
            await mdb.disconnect()
            await nayax.disconnect()
            await assignSerialPorts()
            await mdb.connect().catch(() => undefined)
            await nayax.connect().catch(() => undefined)
          }
        } catch {
          /* ignore — retry later */
        }
      })().finally(() => { watchdogBusy = false })
    }, 8000)
  }

  // Show the Hardware Simulator window only when actually simulating (dev, or
  // SIMULATE_HARDWARE=true for bench testing). A real kiosk running the real
  // MDB hopper + Nayax reader never sees it.
  if (USE_SIMULATION) {
    createSimulatorWindow()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || allowQuit) {
    app.quit()
  }
})
