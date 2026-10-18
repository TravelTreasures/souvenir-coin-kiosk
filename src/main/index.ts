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
      contextIsolation: true
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

app.whenReady().then(async () => {
  appMode = resolveMode()

  // Strip the application menu in kiosk mode; keep the default (Cmd+Q,
  // DevTools, etc.) in dev so testing is comfortable.
  if (isKiosk()) Menu.setApplicationMenu(null)

  try {
    await mdb.connect()
    await nayax.connect()
  } catch (err) {
    console.error('[startup] Hardware connect error (continuing in simulation):', err)
  }

  // Reconcile hopper counts so the kiosk and the Fleet Admin always agree.
  // The MDB controller and the DB are two separate stores; align them at boot:
  // restore a persisted DB count into the live controller, or seed the DB from
  // the controller's current count when the DB is empty/new.
  for (const id of [1, 2] as const) {
    const addr = id === 1 ? HopperController.HOPPER_1_ADDR : HopperController.HOPPER_2_ADDR
    const dbCount = getHopperCount(id)
    if (dbCount > 0) {
      simSetHopperCoinCount(addr, dbCount)
    } else {
      setHopperCount(id, mdb.getCoinCount(addr))
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
