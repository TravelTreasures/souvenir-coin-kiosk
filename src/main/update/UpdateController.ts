/**
 * OTA Update Controller (electron-updater)
 *
 * Runs in the kiosk main process. Responsibilities:
 *   • Read the OTA policy the Fleet Admin server pushes into the kiosk config
 *     (feed URL, channel, approved target version, and the install window).
 *   • On each fleet-sync tick, decide whether it may update right now:
 *       – inside the scheduled window (default 02:00–04:00 kiosk-local time), AND
 *       – the kiosk is idle (never mid-sale),
 *       – OR an explicit "update now" was pushed from the dashboard (bypasses the window).
 *   • Drive electron-updater: check → download → (when still idle) install & relaunch.
 *   • Enforce the approved version: if the server pinned a targetVersion, only a
 *     build matching it is installed (so a kiosk never jumps to an unapproved build).
 *   • Track status (idle/checking/downloading/installing/successful/failed) in the
 *     kiosk config so the next heartbeat reports it to the dashboard.
 *
 * electron-updater is loaded at runtime (require) and typed against the small
 * surface we use, so the project still compiles before `npm install` and the
 * dependency stays external (not bundled) in the main build.
 *
 * Linux/AppImage needs no OS code-signing: electron-updater verifies the
 * download against the signed latest-linux.yml (sha512). Windows/macOS would
 * need signing for unattended install (see OTA design doc §3) — not required for
 * the Ubuntu production target.
 */

import { app } from 'electron'
import { getConfig, setOtaStatus, updateConfig } from '../config/Config'

// ---- minimal typing of the electron-updater surface we use ----
interface UpdateInfo {
  version: string
}
interface AutoUpdaterLike {
  autoDownload: boolean
  allowDowngrade: boolean
  autoInstallOnAppQuit: boolean
  channel: string | null
  fullChangelog?: boolean
  logger: unknown
  setFeedURL(options: { provider: 'generic'; url: string; channel?: string }): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

let updater: AutoUpdaterLike | null = null
let wired = false
let busyPhase: '' | 'checking' | 'downloading' | 'installing' = ''
let isIdle: () => boolean = () => true
let pendingInstall = false // a build finished downloading and is ready to install

function loadUpdater(): AutoUpdaterLike | null {
  if (updater) return updater
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater: AutoUpdaterLike }
    updater = mod.autoUpdater
    return updater
  } catch (e) {
    console.log('[ota] electron-updater not installed — OTA disabled until `npm install`')
    return null
  }
}

/** "HH:MM" -> minutes since midnight, or null if malformed. */
function hhmmToMinutes(s: string | undefined): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Is `now` (local) within [start,end]? Handles windows that cross midnight. */
function withinWindow(startStr?: string, endStr?: string, now = new Date()): boolean {
  const start = hhmmToMinutes(startStr)
  const end = hhmmToMinutes(endStr)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true // 24h window
  if (start < end) return cur >= start && cur < end
  // wraps midnight (e.g. 23:00–02:00)
  return cur >= start || cur < end
}

/** Install/relaunch only if it's still safe (idle + allowed) at the moment of install. */
function tryInstallIfSafe(reason: string): void {
  const cfg = getConfig()
  const force = (cfg.otaForceVersion ?? 0) > (cfg.otaForceVersionApplied ?? 0)
  const windowOpen = cfg.otaWindowEnabled === false || withinWindow(cfg.otaWindowStart, cfg.otaWindowEnd)
  if (!pendingInstall) return
  if (!isIdle()) {
    console.log('[ota] update downloaded — deferring install (kiosk busy)')
    return
  }
  if (!force && !windowOpen) {
    console.log('[ota] update downloaded — waiting for the update window to install')
    return
  }
  console.log(`[ota] installing update and relaunching (${reason})`)
  setOtaStatus('installing')
  updateConfig({ otaPreviousVersion: app.getVersion(), otaLastUpdateAt: new Date().toISOString() })
  busyPhase = 'installing'
  try {
    updater?.quitAndInstall(true, true)
  } catch (e) {
    busyPhase = ''
    pendingInstall = false
    setOtaStatus('failed', (e as Error)?.message || 'install failed')
  }
}

function wireEvents(u: AutoUpdaterLike): void {
  if (wired) return
  wired = true

  u.on('error', (...args: unknown[]) => {
    const err = args[0]
    busyPhase = ''
    pendingInstall = false
    const msg = err instanceof Error ? err.message : String(err)
    console.log('[ota] updater error:', msg)
    setOtaStatus('failed', msg)
  })

  u.on('update-available', (...args: unknown[]) => {
    const info = (args[0] || {}) as UpdateInfo
    const cfg = getConfig()
    const target = (cfg.otaTargetVersion || '').trim()
    // Enforce the approved version: if the server pinned one, only install a
    // matching build. (Empty target = accept whatever is latest on the channel.)
    if (target && info.version && info.version !== target) {
      console.log(`[ota] feed has v${info.version} but approved target is v${target} — skipping`)
      busyPhase = ''
      setOtaStatus('idle')
      return
    }
    console.log(`[ota] update available: v${info.version} — downloading`)
    busyPhase = 'downloading'
    setOtaStatus('downloading')
    u.downloadUpdate().catch((e) => {
      busyPhase = ''
      setOtaStatus('failed', (e as Error)?.message || 'download failed')
    })
  })

  u.on('update-not-available', () => {
    busyPhase = ''
    if (getConfig().otaStatus !== 'successful') setOtaStatus('idle')
  })

  u.on('update-downloaded', (...args: unknown[]) => {
    const info = (args[0] || {}) as UpdateInfo
    console.log(`[ota] downloaded v${info.version}`)
    pendingInstall = true
    busyPhase = ''
    setOtaStatus('pending')
    tryInstallIfSafe('just downloaded')
  })
}

/** Call once at startup with a predicate that returns true when the kiosk is idle. */
export function initUpdater(idleFn: () => boolean): void {
  isIdle = idleFn
}

/**
 * Called on every fleet-sync tick. Returns quickly unless it's both allowed
 * (window / force) and safe (idle) to look for an update.
 */
export async function runUpdateTick(opts: { dev: boolean }): Promise<void> {
  if (opts.dev) return // never OTA in dev / simulation
  const cfg = getConfig()
  if (!cfg.otaFeedUrl) return // no feed configured yet — nothing to do

  // A download already finished and is waiting — try to install when safe.
  if (pendingInstall) {
    tryInstallIfSafe('pending from earlier tick')
    return
  }
  if (busyPhase) return // a check/download is already in flight

  const force = (cfg.otaForceVersion ?? 0) > (cfg.otaForceVersionApplied ?? 0)
  const windowOpen = cfg.otaWindowEnabled === false || withinWindow(cfg.otaWindowStart, cfg.otaWindowEnd)

  if (!force && !windowOpen) return // outside the allowed window
  if (!isIdle()) return // never start an update mid-sale

  const u = loadUpdater()
  if (!u) return

  // Acknowledge the one-shot "update now" so we don't loop on it.
  if (force) updateConfig({ otaForceVersionApplied: cfg.otaForceVersion ?? 0 })

  wireEvents(u)
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  u.allowDowngrade = true // so a dashboard rollback (to an older build) can install
  u.channel = cfg.otaChannel || 'stable'
  try {
    u.setFeedURL({ provider: 'generic', url: cfg.otaFeedUrl, channel: cfg.otaChannel || 'stable' })
  } catch (e) {
    setOtaStatus('failed', 'bad feed URL: ' + ((e as Error)?.message || ''))
    return
  }

  busyPhase = 'checking'
  setOtaStatus('checking')
  try {
    await u.checkForUpdates()
    // handlers (update-available / not-available / downloaded / error) take over.
  } catch (e) {
    busyPhase = ''
    setOtaStatus('failed', (e as Error)?.message || 'check failed')
  }
}

/** Snapshot for the heartbeat so the dashboard can show version + update status. */
export function getUpdateReport(): {
  currentVersion: string
  updateStatus: string
  updateError: string
} {
  const cfg = getConfig()
  return {
    currentVersion: app.getVersion(),
    updateStatus: cfg.otaStatus || 'idle',
    updateError: cfg.otaError || ''
  }
}
