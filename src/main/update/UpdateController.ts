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
import { spawn } from 'child_process'
import { copyFileSync, chmodSync, renameSync, existsSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { getConfig, setOtaStatus, updateConfig } from '../config/Config'

// ---- minimal typing of the electron-updater surface we use ----
interface UpdateInfo {
  version: string
  // Path electron-updater saved the downloaded AppImage to (we install it
  // ourselves rather than trusting the library's fragile file-swap step).
  downloadedFile?: string
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
let downloadedFile = '' // where electron-updater saved the new AppImage
// A dashboard "Update now" was requested. This MUST persist from the moment we
// start the check all the way through to the install, so a forced update still
// installs even after the one-shot force counter has been acknowledged (the
// acknowledgement happens at check time to avoid re-checking on every tick).
let forcedInstall = false

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
  // forcedInstall persists a dashboard "Update now" across the whole cycle; the
  // counter check covers a force that arrives after the download is already pending.
  const force = forcedInstall || (cfg.otaForceVersion ?? 0) > (cfg.otaForceVersionApplied ?? 0)
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

  // Install the AppImage OURSELVES instead of electron-updater's built-in
  // swap (which has repeatedly failed on this kiosk — "unlink: no such file",
  // "mv: cannot stat pending"). We copy the freshly-downloaded file in beside
  // the running AppImage, then atomically rename it over APPIMAGE. rename()
  // replaces the name even while the old binary is still executing (its inode
  // stays alive until we exit), and it never fails on a missing target — so the
  // two failure modes above cannot happen. Then relaunch the new file directly.
  const target = process.env.APPIMAGE || ''
  if (target && downloadedFile && existsSync(downloadedFile)) {
    const tmp = join(dirname(target), '.souvenir-update.tmp')
    try {
      copyFileSync(downloadedFile, tmp)
      chmodSync(tmp, 0o755)
      renameSync(tmp, target) // atomic in-place replace
      console.log(`[ota] self-installed -> ${target}; relaunching`)
      forcedInstall = false
      // Relaunch the NEW AppImage as a fully detached process, then exit. Two
      // things make this robust where electron's app.relaunch() failed with
      // "Cannot mount AppImage / check FUSE":
      //   1. detached + unref: the child outlives us and starts cleanly after
      //      this process releases its own FUSE mount.
      //   2. APPIMAGE_EXTRACT_AND_RUN=1: the new AppImage extracts and runs
      //      instead of FUSE-mounting, so it can't collide with our mount (and
      //      doesn't depend on FUSE being healthy at the moment of relaunch).
      spawn(target, ['--no-sandbox'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', KIOSK_MODE: process.env.KIOSK_MODE || 'kiosk' }
      }).unref()
      app.exit(0)
      return
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
      console.log('[ota] self-install failed, falling back to electron-updater:', (e as Error)?.message)
    }
  }

  // Fallback: electron-updater's own installer (non-AppImage builds, or if we
  // somehow have no downloaded-file path).
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
    forcedInstall = false
    const msg = err instanceof Error ? err.message : String(err)
    // A 404 for the channel file (e.g. stable-linux.yml) just means the newest
    // release is still being published — its assets aren't uploaded yet — or a
    // momentary network blip. The updater retries on the next check, so this is
    // NOT a real failure: report a calm idle state instead of a red "failed"
    // with a stack trace, so an in-progress publish doesn't look like breakage.
    const transient = /HttpError:\s*404|Cannot find channel|update info|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(msg)
    if (transient) {
      console.log('[ota] update check deferred — release not ready or transient:', msg.split('\n')[0])
      setOtaStatus('idle')
      return
    }
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
    forcedInstall = false // nothing to install; don't carry the force into a later cycle
    if (getConfig().otaStatus !== 'successful') setOtaStatus('idle')
  })

  u.on('update-downloaded', (...args: unknown[]) => {
    const info = (args[0] || {}) as UpdateInfo
    downloadedFile = info.downloadedFile || ''
    console.log(`[ota] downloaded v${info.version} -> ${downloadedFile || '(path unknown)'}`)
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

  // Acknowledge the one-shot "update now" so we don't loop on it — but remember
  // (in forcedInstall) that this cycle was forced, so the later install step can
  // still bypass the window even though the counter now reads "applied".
  if (force) {
    forcedInstall = true
    updateConfig({ otaForceVersionApplied: cfg.otaForceVersion ?? 0 })
  }

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
