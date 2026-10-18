/**
 * Fleet Sync Client
 *
 * Runs in the kiosk's main process. On a timer it talks OUTBOUND to the central
 * Fleet Admin server (no inbound connection to the kiosk required):
 *   1. pulls this kiosk's config and applies it (e.g. site-specific price),
 *   2. pushes new local transactions (deduplicated server-side),
 *   3. sends a heartbeat with status + the config version it has applied
 *      (so the dashboard can confirm the change was received).
 *
 * Enabled only when fleetUrl + fleetApiKey are set in the kiosk config
 * (via the Admin → System tab, or FLEET_URL / FLEET_API_KEY env vars).
 */

import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getConfig, updateConfig, setPriceCents } from '../config/Config'
import { getTransactionsSince, getHopperEventsSince } from '../database/Database'
import { HopperController } from '../hopper/HopperController'
import type { NayaxController } from '../nayax/NayaxController'
import { runUpdateTick, getUpdateReport } from '../update/UpdateController'

// OTA is disabled in dev / hardware-simulation builds.
const OTA_DEV = is.dev || process.env.SIMULATE_HARDWARE === 'true'

/**
 * How often the kiosk syncs with the Fleet Admin server.
 *
 * Default 60s — small enough that price / coin / PIN / image changes and offline
 * detection stay responsive, large enough that server load stays trivial even
 * for a large fleet (100 kiosks ≈ a couple of requests per second).
 *
 * Tunable per-deployment WITHOUT rebuilding the app: set the FLEET_SYNC_SECONDS
 * env var (e.g. in the kiosk's autostart), or a `fleetSyncSeconds` value in the
 * kiosk config. Clamped to 15s–1h so a typo can neither hammer the server nor
 * effectively disable sync.
 */
const DEFAULT_SYNC_SECONDS = 60
const MIN_SYNC_SECONDS = 15
const MAX_SYNC_SECONDS = 3600

function resolveSyncIntervalMs(): number {
  const cfg = getConfig() as { fleetSyncSeconds?: number }
  const candidates = [Number(process.env.FLEET_SYNC_SECONDS), Number(cfg.fleetSyncSeconds)]
  const chosen = candidates.find((n) => Number.isFinite(n) && n > 0) ?? DEFAULT_SYNC_SECONDS
  const seconds = Math.min(Math.max(chosen, MIN_SYNC_SECONDS), MAX_SYNC_SECONDS)
  return seconds * 1000
}

let timer: ReturnType<typeof setInterval> | null = null

export function startFleetSync(mdb: HopperController, nayax: NayaxController): void {
  // Allow first-run provisioning via env vars.
  const cfg = getConfig()
  if (process.env.FLEET_URL && process.env.FLEET_API_KEY && (!cfg.fleetUrl || !cfg.fleetApiKey)) {
    updateConfig({ fleetUrl: process.env.FLEET_URL, fleetApiKey: process.env.FLEET_API_KEY })
  }

  const c = getConfig()
  if (!c.fleetUrl || !c.fleetApiKey) {
    console.log('[fleet-sync] disabled — set fleet URL + API key in Admin → System to enable')
    return
  }

  const intervalMs = resolveSyncIntervalMs()
  console.log(`[fleet-sync] enabled → ${c.fleetUrl} (every ${intervalMs / 1000}s)`)
  const tick = (): void => {
    syncOnce(mdb, nayax).catch((e) => console.error('[fleet-sync] error:', e?.message ?? e))
  }
  tick()
  timer = setInterval(tick, intervalMs)
}

export function stopFleetSync(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * Download newly-assigned coin images and store them as data URLs in the kiosk
 * config. Only re-downloads a slot whose image id changed. Leaving a slot unset
 * means the kiosk keeps showing its bundled default image.
 */
async function applyCoinImages(
  base: string,
  headers: Record<string, string>,
  coinImages: Record<string, { id: number; url: string }>
): Promise<void> {
  const cfg = getConfig()
  const ids = { ...(cfg.coinImageIds || {}) }
  const data = { ...(cfg.coinImages || {}) }
  let changed = false

  for (const slot of ['1', '2'] as const) {
    const assigned = coinImages[slot]
    if (assigned && assigned.id !== ids[slot]) {
      try {
        const r = await fetch(`${base}${assigned.url}`, { headers })
        if (!r.ok) continue
        const buf = Buffer.from(await r.arrayBuffer())
        const mime = r.headers.get('content-type') || 'image/png'
        data[slot] = `data:${mime};base64,${buf.toString('base64')}`
        ids[slot] = assigned.id
        changed = true
        console.log(`[fleet-sync] downloaded coin ${slot} image (id ${assigned.id})`)
      } catch {
        /* retry next tick */
      }
    }
  }
  if (changed) updateConfig({ coinImages: data, coinImageIds: ids })
}

/** Download marketing images (when the set changes) and store settings. */
async function applyMarketing(
  base: string,
  headers: Record<string, string>,
  marketing: { enabled?: boolean; slideSeconds?: number; idleSeconds?: number; activeStart?: string; activeEnd?: string; images?: { id: number; url: string }[] } | undefined
): Promise<void> {
  if (!marketing) return
  const cfg = getConfig()
  const settings = {
    enabled: !!marketing.enabled,
    slideSeconds: marketing.slideSeconds || 10,
    idleSeconds: marketing.idleSeconds || 60,
    activeStart: marketing.activeStart || '',
    activeEnd: marketing.activeEnd || ''
  }
  const ids = (marketing.images || []).map((i) => i.id)
  const prev = cfg.marketingImageIds || []
  const changed = ids.length !== prev.length || ids.some((id, i) => id !== prev[i])
  if (changed) {
    const dataUrls: string[] = []
    for (const im of marketing.images || []) {
      try {
        const r = await fetch(`${base}${im.url}`, { headers })
        if (!r.ok) continue
        const buf = Buffer.from(await r.arrayBuffer())
        const mime = r.headers.get('content-type') || 'image/png'
        dataUrls.push(`data:${mime};base64,${buf.toString('base64')}`)
      } catch {
        /* retry next tick */
      }
    }
    updateConfig({ marketing: settings, marketingImages: dataUrls, marketingImageIds: ids })
    console.log(`[fleet-sync] marketing applied: downloaded ${dataUrls.length}/${ids.length} images, enabled=${settings.enabled}`)
  } else {
    updateConfig({ marketing: settings })
  }
}

async function syncOnce(mdb: HopperController, nayax: NayaxController): Promise<void> {
  const cfg = getConfig()
  if (!cfg.fleetUrl || !cfg.fleetApiKey) return
  const base = cfg.fleetUrl.replace(/\/$/, '')
  const headers = { 'Content-Type': 'application/json', 'X-Kiosk-Key': cfg.fleetApiKey }

  // 1. Pull config and apply if the server has a newer version.
  try {
    const res = await fetch(`${base}/api/ingest/config`, { headers })
    if (res.ok) {
      const conf = await res.json()
      if (typeof conf.configVersion === 'number' && conf.configVersion !== cfg.appliedConfigVersion) {
        if (typeof conf.coinPriceCents === 'number') setPriceCents(conf.coinPriceCents)
        await applyCoinImages(base, headers, conf.coinImages || {})
        if (conf.promo) {
          updateConfig({ promoText: String(conf.promo.text || ''), promoEnabled: !!conf.promo.enabled })
        }
        if (conf.qr) {
          updateConfig({ qrEnabled: !!conf.qr.enabled, qrUrl: String(conf.qr.url || ''), qrCaption: String(conf.qr.caption || '') })
        }
        if (conf.coins) {
          updateConfig({ coinsEnabled: { '1': conf.coins['1'] !== false, '2': conf.coins['2'] !== false } })
        }
        if (Array.isArray(conf.operators)) {
          updateConfig({ operators: conf.operators })
        }
        // Admin PIN is a ONE-SHOT push, not a synced field. Only apply it when the
        // server's PIN-push version is newer than what we've already applied — so a
        // price (or any other) config change never overwrites a locally-set PIN.
        const pinVer = typeof conf.adminPinVersion === 'number' ? conf.adminPinVersion : 0
        if (pinVer > (cfg.appliedAdminPinVersion ?? 0)) {
          if (typeof conf.adminPin === 'string' && /^\d{4,8}$/.test(conf.adminPin)) {
            updateConfig({ adminPin: conf.adminPin })
          }
          updateConfig({ appliedAdminPinVersion: pinVer })
        }
        await applyMarketing(base, headers, conf.marketing)
        // OTA policy: feed, channel, approved version and the install window.
        if (conf.ota) {
          const o = conf.ota
          updateConfig({
            otaFeedUrl: typeof o.feedUrl === 'string' ? o.feedUrl : '',
            otaChannel: o.channel || 'stable',
            otaTargetVersion: typeof o.targetVersion === 'string' ? o.targetVersion : '',
            otaWindowStart: o.windowStart || '02:00',
            otaWindowEnd: o.windowEnd || '04:00',
            otaWindowEnabled: o.windowEnabled !== false,
            ...(typeof o.forceVersion === 'number' ? { otaForceVersion: o.forceVersion } : {})
          })
        }
        updateConfig({ appliedConfigVersion: conf.configVersion })
        console.log(`[fleet-sync] applied config v${conf.configVersion} (price ${conf.coinPriceCents})`)
      }
      updateConfig({ fleetStatus: { state: 'ok', at: new Date().toISOString() } })
    } else {
      console.log(`[fleet-sync] config pull failed: HTTP ${res.status}`)
      updateConfig({ fleetStatus: { state: res.status === 401 || res.status === 403 ? 'auth_failed' : 'error', at: new Date().toISOString(), code: res.status } })
    }
  } catch (e) {
    console.log(`[fleet-sync] cannot reach ${base} — is the central server running? (${(e as Error)?.message})`)
    updateConfig({ fleetStatus: { state: 'offline', at: new Date().toISOString() } })
  }

  // 2. Push new transactions + hopper maintenance events since the last synced ids.
  try {
    const fresh = getConfig()
    const txs = getTransactionsSince(fresh.lastSyncedTxId)
    const events = getHopperEventsSince(fresh.lastSyncedHopperEventId ?? 0)
    if (txs.length || events.length) {
      const transactions = txs.map((t) => ({
        transactionId: t.transactionId,
        amount: t.amount,
        coinSelected: t.coinSelected,
        paymentResult: t.paymentResult,
        dispenseResult: t.dispenseResult,
        createdAt: t.createdAt
      }))
      const hopperEvents = events.map((e) => ({
        srcId: e.id,
        hopperId: e.hopperId,
        type: e.type,
        quantity: e.quantity,
        oldStock: e.oldStock,
        newStock: e.newStock,
        operator: e.operator,
        operatorRole: e.operatorRole,
        createdAt: e.createdAt
      }))
      const res = await fetch(`${base}/api/ingest/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ transactions, hopperEvents })
      })
      if (res.ok) {
        if (txs.length) {
          updateConfig({ lastSyncedTxId: txs.reduce((m, t) => Math.max(m, t.id ?? 0), fresh.lastSyncedTxId) })
        }
        if (events.length) {
          updateConfig({ lastSyncedHopperEventId: events.reduce((m, e) => Math.max(m, e.id ?? 0), fresh.lastSyncedHopperEventId ?? 0) })
        }
      }
    }
  } catch {
    /* offline — retry next tick */
  }

  // 3. Heartbeat: report status + the config version we have applied.
  try {
    const fresh = getConfig()
    const [h1, h2] = await Promise.all([
      mdb.getHopperStatus(HopperController.HOPPER_1_ADDR),
      mdb.getHopperStatus(HopperController.HOPPER_2_ADDR)
    ])
    const ota = getUpdateReport()
    await fetch(`${base}/api/ingest/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appVersion: app.getVersion(),
        appliedConfigVersion: fresh.appliedConfigVersion,
        coinPriceCents: fresh.coinPriceCents,
        mdbConnected: mdb.isConnected(),
        nayaxConnected: nayax.isConnected(),
        hopper1: { status: h1.status, coinCount: h1.coinCount },
        hopper2: { status: h2.status, coinCount: h2.coinCount },
        // OTA status so the dashboard can show version + update progress.
        updateStatus: ota.updateStatus,
        updateError: ota.updateError
      })
    })
  } catch {
    /* offline — retry next tick */
  }

  // 4. OTA: let the updater decide whether it may check / download / install now
  //    (respects the scheduled window + idle rule; a dashboard "update now" bypasses the window).
  try {
    await runUpdateTick({ dev: OTA_DEV })
  } catch (e) {
    console.log('[ota] tick error:', (e as Error)?.message ?? e)
  }
}
