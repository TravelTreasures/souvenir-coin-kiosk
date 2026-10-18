/**
 * Souvenir Coin Kiosk — Central Fleet Server
 *
 * Zero-dependency Node HTTP server providing:
 *   • a password-protected fleet Admin Web Application (served from public/)
 *   • a JSON API for the dashboard (staff token auth)
 *   • ingest endpoints for kiosks to report data (per-kiosk API key auth)
 *
 * Config (env vars):
 *   FLEET_PORT            default 9090
 *   FLEET_ADMIN_PASSWORD  default 'fleet-admin'  ← change this
 *
 * Run:  npm start   (seeds demo data on first launch)
 */
import { createServer } from 'http'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname, join, extname } from 'path'
import { fileURLToPath } from 'url'
import { load, save, data, nextId } from './store.js'
import { seedIfEmpty } from './seed.js'
import { hashPassword, verifyPassword, seedAdmin, findUser, listUsers, adminCount } from './users.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const IMAGES_DIR = join(ROOT, 'data', 'images')
const PORT = Number(process.env.FLEET_PORT ?? 9090)
const ADMIN_USER = process.env.FLEET_ADMIN_USER ?? 'admin'
const ADMIN_PASSWORD = process.env.FLEET_ADMIN_PASSWORD ?? 'fleet-admin'
const ONLINE_WINDOW_MS = 3 * 60 * 1000 // online if seen within 3 min

const tokens = new Map() // token -> { exp, username, role }
const TOKEN_TTL = 8 * 60 * 60 * 1000

// Demo data is only seeded when explicitly requested (FLEET_SEED_DEMO=1).
// A real production server starts empty and you add your own kiosks.
if (process.env.FLEET_SEED_DEMO === '1') seedIfEmpty()
load()
seedAdmin(ADMIN_USER, ADMIN_PASSWORD)

// ------------------------------------------------------------------ helpers
const newToken = (username, role) => {
  const t = randomBytes(24).toString('hex')
  tokens.set(t, { exp: Date.now() + TOKEN_TTL, username, role })
  return t
}
/** Returns the session { username, role } for a request, or null. */
const session = (req) => {
  const t = bearer(req)
  if (!t) return null
  const s = tokens.get(t)
  if (!s) return null
  if (Date.now() > s.exp) { tokens.delete(t); return null }
  return s
}
const bearer = (req) => {
  const a = req.headers['authorization'] || ''
  return a.startsWith('Bearer ') ? a.slice(7) : null
}
const body = (req) =>
  new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => { s += c; if (s.length > 15_000_000) req.destroy() })
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch { resolve({}) } })
  })
const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}
const isOnline = (kioskId) => {
  const hb = data().heartbeats[kioskId]
  if (!hb?.lastSeen) return false
  const windowMs = (getSettings().offlineMinutes || 5) * 60 * 1000
  return Date.now() - new Date(hb.lastSeen).getTime() < windowMs
}
const kioskById = (id) => data().kiosks.find((k) => k.id === id)

// Resolve an OTA action's target kiosks from a request body:
//   { all:true } | { kioskId } | { tag } | { destinationId }
function otaTargets(b) {
  const all = data().kiosks
  if (b.all) return all
  if (b.kioskId) { const k = kioskById(b.kioskId); return k ? [k] : [] }
  if (b.tag) return all.filter((k) => (k.tags || []).includes(b.tag))
  if (b.destinationId) return all.filter((k) => k.destinationId === b.destinationId)
  return []
}
const destById = (id) => data().destinations.find((d) => d.id === id)
const imageById = (id) => data().images.find((i) => i.id === id)

const SETTINGS_DEFAULTS = {
  lowCoinThreshold: 50, offlineMinutes: 5, webhookUrl: '',
  // OTA (software update) fleet-wide defaults. Per-kiosk overrides live on the kiosk.
  otaFeedUrl: '', otaChannel: 'stable',
  otaWindowStart: '02:00', otaWindowEnd: '04:00', otaWindowEnabled: true
}
const getSettings = () => ({ ...SETTINGS_DEFAULTS, ...(data().settings || {}) })

function fireWebhook(alert) {
  const url = getSettings().webhookUrl
  if (!url) return
  const k = kioskById(alert.kioskId)
  const text = `[Souvenir Coin Kiosk] ${alert.message}${k ? ' — ' + k.name : ''}`
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, alert })
  }).catch(() => {})
}

/** Open a system alert if one of this type isn't already open for the kiosk. */
function raiseAlert(kioskId, type, message) {
  const open = data().systemAlerts.find((a) => a.kioskId === kioskId && a.type === type && !a.resolved)
  if (open) return
  const alert = { id: nextId('systemAlerts'), kioskId, type, message, createdAt: new Date().toISOString(), resolved: false }
  data().systemAlerts.push(alert)
  fireWebhook(alert)
}

/** Auto-resolve any open alert of this type for the kiosk (condition cleared). */
function clearAlert(kioskId, type) {
  let changed = false
  for (const a of data().systemAlerts) {
    if (a.kioskId === kioskId && a.type === type && !a.resolved) { a.resolved = true; a.resolvedAt = new Date().toISOString(); changed = true }
  }
  return changed
}

/** Periodic fleet health check: offline + low-coin detection. */
function monitorFleet() {
  const s = getSettings()
  for (const k of data().kiosks) {
    const hb = data().heartbeats[k.id]
    // Offline (only for kiosks that have reported at least once)
    if (hb?.lastSeen) {
      if (!isOnline(k.id)) raiseAlert(k.id, 'offline', `Kiosk offline (no heartbeat for ${s.offlineMinutes}+ min)`)
      else clearAlert(k.id, 'offline')
    }
    // Low coin per hopper
    for (const slot of [1, 2]) {
      const hop = hb?.[`hopper${slot}`]
      if (hop && typeof hop.coinCount === 'number') {
        if (hop.coinCount <= s.lowCoinThreshold) raiseAlert(k.id, `low_coin_${slot}`, `Hopper ${slot} low: ${hop.coinCount} coins left`)
        else clearAlert(k.id, `low_coin_${slot}`)
      }
    }
  }
  save()
}

const MARKETING_DEFAULTS = { enabled: false, slideSeconds: 10, idleSeconds: 60, activeStart: '', activeEnd: '' }
const marketingSettings = (k) => ({ ...MARKETING_DEFAULTS, ...(k.marketing || {}) })
const marketingImagesFor = (k) =>
  data().marketingImages.filter((m) => m.kioskId === k.id).sort((a, b) => a.id - b.id)
    .map((m) => ({ id: m.id, url: '/files/' + m.filename, name: m.name }))
const bumpConfig = (k) => { k.configVersion = (k.configVersion ?? 1) + 1; k.lastConfigUpdate = new Date().toISOString() }
// Operators are fleet-wide, so a change must reach every kiosk: bump them all.
const bumpAllConfigs = () => { for (const k of data().kiosks) bumpConfig(k) }

// Concise two-way ingest log: one line per kiosk call (heartbeat / config / sync),
// so the server terminal shows live kiosk↔server traffic. Set FLEET_LOG_INGEST=0 to mute.
const logIngest = (kioskId, dir, kind, detail) => {
  if (process.env.FLEET_LOG_INGEST === '0') return
  const arrow = dir === 'in' ? '←' : '→'
  console.log(`[ingest] ${new Date().toISOString()} ${kioskId} ${arrow} ${kind}${detail ? ' · ' + detail : ''}`)
}

/** Append an audit-log entry (who did which mutating action). Keeps the last 2000. */
function logAudit(sess, method, path) {
  const a = data().audit
  a.push({ id: nextId('audit'), at: new Date().toISOString(), user: sess.username, role: sess.role, method, path })
  if (a.length > 2000) data().audit = a.slice(-2000)
}

/** Resolve a kiosk's assigned coin images to { slot: { id, url } } for sync. */
function coinImagesFor(kiosk) {
  const out = {}
  const ci = kiosk.coinImages || {}
  for (const slot of [1, 2]) {
    const img = ci[slot] ? imageById(ci[slot]) : null
    if (img) out[slot] = { id: img.id, url: '/files/' + img.filename }
  }
  return out
}

// Local-time SQL-ish date bounds for reporting periods
function periodBounds(period) {
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const now = new Date()
  let from = '1970-01-01 00:00:00'
  if (period === 'today') { const s = new Date(now); s.setHours(0, 0, 0, 0); from = fmt(s) }
  else if (period === 'week') { const s = new Date(now); s.setDate(s.getDate() - 7); from = fmt(s) }
  else if (period === 'month') { const s = new Date(now); s.setMonth(s.getMonth() - 1); from = fmt(s) }
  return { from, to: fmt(now) }
}
const norm = (ts) => (ts || '').replace('T', ' ').substring(0, 19)

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')
/** Convert from/to calendar dates (YYYY-MM-DD) to inclusive SQL-ish bounds. */
function rangeBounds(from, to) {
  return { from: `${from} 00:00:00`, to: `${to} 23:59:59` }
}

function salesBetween(kioskId, from, to) {
  const rows = data().transactions.filter(
    (t) => t.kioskId === kioskId && t.paymentResult === 'approved' && t.dispenseResult === 'success' &&
      norm(t.createdAt) >= from && norm(t.createdAt) <= to
  )
  return {
    totalSales: rows.length,
    totalRevenue: rows.reduce((a, r) => a + r.amount, 0),
    coin1Sales: rows.filter((r) => r.coinSelected === 1).length,
    coin2Sales: rows.filter((r) => r.coinSelected === 2).length,
    coin1Revenue: rows.filter((r) => r.coinSelected === 1).reduce((a, r) => a + r.amount, 0),
    coin2Revenue: rows.filter((r) => r.coinSelected === 2).reduce((a, r) => a + r.amount, 0)
  }
}

function salesFor(kioskId, period) {
  const { from, to } = periodBounds(period)
  return salesBetween(kioskId, from, to)
}

/** Resolve from/to from query params; returns null if not a valid custom range. */
function customRange(url) {
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (isDate(from) && isDate(to)) return rangeBounds(from, to)
  return null
}

/** Daily approved+dispensed series. Either the last `days` days, or an
 *  explicit calendar range {fromDate, toDate} (YYYY-MM-DD). */
function timeseries(filterKioskId, days, fromDate, toDate) {
  const pad = (n) => String(n).padStart(2, '0')
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  let start, end
  if (isDate(fromDate) && isDate(toDate)) {
    start = new Date(fromDate + 'T00:00:00'); end = new Date(toDate + 'T00:00:00')
  } else {
    end = new Date(); end.setHours(0, 0, 0, 0)
    start = new Date(end); start.setDate(end.getDate() - (days - 1))
  }
  const out = {}
  const keys = []
  for (let d = new Date(start); d <= end && keys.length < 400; d.setDate(d.getDate() + 1)) {
    const k = dateKey(d); keys.push(k); out[k] = { date: k, sales: 0, revenue: 0 }
  }
  for (const t of data().transactions) {
    if (filterKioskId && t.kioskId !== filterKioskId) continue
    if (t.paymentResult !== 'approved' || t.dispenseResult !== 'success') continue
    const d = norm(t.createdAt).substring(0, 10)
    if (out[d]) { out[d].sales++; out[d].revenue += t.amount }
  }
  return keys.map((k) => out[k])
}

const localDateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Per-hopper inventory: current count, avg daily use, days-to-empty, last refill. */
function hopperInventory(kiosk) {
  const hb = data().heartbeats[kiosk.id] || {}
  const days = 14
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1))
  const startKey = localDateKey(start)
  const out = []
  for (const slot of [1, 2]) {
    const hop = hb[`hopper${slot}`]
    const current = hop ? hop.coinCount : null
    let dispensed = 0
    for (const t of data().transactions) {
      if (t.kioskId !== kiosk.id || t.coinSelected !== slot) continue
      if (t.paymentResult === 'approved' && t.dispenseResult === 'success' && norm(t.createdAt).substring(0, 10) >= startKey) dispensed++
    }
    const avgDailyUse = dispensed / days
    const daysToEmpty = current != null && avgDailyUse > 0 ? current / avgDailyUse : null
    // "Last refill" comes from the refills the kiosk actually performed and synced.
    const refills = data().hopperEvents
      .filter((e) => e.kioskId === kiosk.id && e.hopperId === slot && e.type === 'refill')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const lastRefill = refills[0]
      ? { added: refills[0].quantity, newCount: refills[0].newStock, by: refills[0].operator, createdAt: refills[0].createdAt }
      : null
    out.push({ slot, status: hop ? hop.status : 'unknown', currentCount: current, avgDailyUse, daysToEmpty, lastRefill })
  }
  return out
}

/** Cash reconciliation per coin over [from,to]: paid vs dispensed vs refund-owed. */
function reconcile(kiosk, from, to) {
  const coins = []
  for (const slot of [1, 2]) {
    let paid = 0, paidRevenue = 0, dispensed = 0, dispensedRevenue = 0, notDispensed = 0
    for (const t of data().transactions) {
      if (t.kioskId !== kiosk.id || t.coinSelected !== slot) continue
      if (norm(t.createdAt) < from || norm(t.createdAt) > to) continue
      if (t.paymentResult === 'approved') {
        paid++; paidRevenue += t.amount
        if (t.dispenseResult === 'success') { dispensed++; dispensedRevenue += t.amount }
        else if (t.dispenseResult) notDispensed++
      }
    }
    const refillsAdded = data().hopperEvents
      .filter((e) => e.kioskId === kiosk.id && e.hopperId === slot && e.type === 'refill' && norm(e.createdAt) >= from && norm(e.createdAt) <= to)
      .reduce((a, e) => a + (e.quantity || 0), 0)
    coins.push({ slot, paid, paidRevenue, dispensed, dispensedRevenue, notDispensed, refundOwed: paidRevenue - dispensedRevenue, refillsAdded })
  }
  return coins
}

function kioskSummary(k) {
  const hb = data().heartbeats[k.id] || {}
  const openAlerts = data().alerts.filter((a) => a.kioskId === k.id && !a.resolved).length
  return {
    id: k.id,
    name: k.name,
    location: k.location,
    destination: destById(k.destinationId)?.name || k.destinationId,
    online: isOnline(k.id),
    lastSeen: hb.lastSeen || null,
    operationalStatus: k.operationalStatus,
    appVersion: hb.appVersion || k.appVersion,
    hopper1: hb.hopper1 || null,
    hopper2: hb.hopper2 || null,
    salesToday: salesFor(k.id, 'today').totalSales,
    openAlerts,
    coinPriceCents: k.coinPriceCents ?? 9000,
    configVersion: k.configVersion ?? 1,
    appliedConfigVersion: k.appliedConfigVersion ?? 0,
    synced: (k.configVersion ?? 1) === (k.appliedConfigVersion ?? 0),
    lastConfigUpdate: k.lastConfigUpdate || null,
    coinImages: coinImagesFor(k),
    tags: k.tags || [],
    // ---- OTA / software updates ----
    currentVersion: k.currentVersion || hb.appVersion || k.appVersion || null,
    targetVersion: k.targetVersion || '',
    previousVersion: k.previousVersion || '',
    updateStatus: k.updateStatus || 'idle',
    updateError: k.updateError || '',
    lastUpdateAt: k.lastUpdateAt || null,
    updateWindowStart: k.updateWindowStart || getSettings().otaWindowStart,
    updateWindowEnd: k.updateWindowEnd || getSettings().otaWindowEnd,
    updateWindowEnabled: (k.updateWindowEnabled ?? getSettings().otaWindowEnabled) !== false,
    updateWindowOverride: !!(k.updateWindowStart || k.updateWindowEnd || k.updateWindowEnabled !== undefined)
  }
}

/** Apply any scheduled price changes whose time has arrived. */
function applyDueSchedules() {
  const now = Date.now()
  let changed = false
  for (const s of data().scheduledChanges) {
    if (s.applied) continue
    if (new Date(s.applyAt).getTime() <= now) {
      const k = kioskById(s.kioskId)
      if (k) {
        k.coinPriceCents = Math.max(0, Math.round(s.priceCents))
        k.configVersion = (k.configVersion ?? 1) + 1
        k.lastConfigUpdate = new Date().toISOString()
      }
      s.applied = true
      s.appliedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) save()
}

// ------------------------------------------------------------------ routing
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Kiosk-Key')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    // ---- Public image files ----
    if (req.method === 'GET' && path.startsWith('/files/')) {
      return serveImage(path.slice('/files/'.length), res)
    }

    // ---- Static dashboard ----
    if (req.method === 'GET' && !path.startsWith('/api/')) {
      return serveStatic(path, res)
    }

    // ---- Staff login (username + password) ----
    if (req.method === 'POST' && path === '/api/login') {
      const b = await body(req)
      const user = findUser(b.username)
      if (user && verifyPassword(b.password, user.password)) {
        return json(res, 200, { token: newToken(user.username, user.role), username: user.username, role: user.role })
      }
      return json(res, 401, { error: 'Invalid username or password' })
    }

    // ---- Kiosk ingest (per-kiosk API key) ----
    if (path.startsWith('/api/ingest/')) {
      const apiKey = req.headers['x-kiosk-key'] || bearer(req)
      const kiosk = data().kiosks.find((k) => k.apiKey === apiKey)
      if (!kiosk) return json(res, 401, { error: 'Invalid kiosk key' })

      if (req.method === 'POST' && path === '/api/ingest/heartbeat') {
        const b = await body(req)
        data().heartbeats[kiosk.id] = {
          lastSeen: new Date().toISOString(),
          hopper1: b.hopper1 ?? null,
          hopper2: b.hopper2 ?? null,
          mdbConnected: !!b.mdbConnected,
          nayaxConnected: !!b.nayaxConnected,
          appVersion: b.appVersion ?? kiosk.appVersion
        }
        // Record which config version the kiosk has actually applied (confirmation).
        if (typeof b.appliedConfigVersion === 'number') kiosk.appliedConfigVersion = b.appliedConfigVersion
        if (b.appVersion) { kiosk.appVersion = b.appVersion; kiosk.currentVersion = b.appVersion }
        // OTA status the kiosk reports (idle/checking/downloading/installing/successful/failed).
        if (typeof b.updateStatus === 'string') kiosk.updateStatus = b.updateStatus
        if (typeof b.updateError === 'string') kiosk.updateError = b.updateError
        if (b.updateStatus === 'successful') {
          kiosk.lastUpdateAt = new Date().toISOString()
          // Reached the approved version — clear the target so we don't keep nudging it.
          if (kiosk.targetVersion && b.appVersion === kiosk.targetVersion) kiosk.targetVersion = ''
        }
        // Reconcile price: adopt the kiosk's locally-set price ONLY when it is fully
        // synced (no command we pushed is still pending). This lets an on-site price
        // change flow back to the dashboard, without overwriting a price we just sent.
        if (typeof b.coinPriceCents === 'number' && b.coinPriceCents >= 0) {
          const inSync = (kiosk.appliedConfigVersion ?? 0) === (kiosk.configVersion ?? 1)
          const reported = Math.round(b.coinPriceCents)
          if (inSync && reported !== (kiosk.coinPriceCents ?? 9000)) {
            kiosk.coinPriceCents = reported
            kiosk.lastConfigUpdate = new Date().toISOString()
            // No configVersion bump — the change originated on the kiosk.
          }
        }
        save()
        logIngest(kiosk.id, 'in', 'heartbeat',
          `appliedV=${b.appliedConfigVersion ?? '?'} price=${b.coinPriceCents ?? '?'} ` +
          `hoppers=${b.hopper1?.coinCount ?? '-'}/${b.hopper2?.coinCount ?? '-'} ` +
          `mdb=${!!b.mdbConnected} nayax=${!!b.nayaxConnected} app=${b.appVersion ?? '?'}`)
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && path === '/api/ingest/sync') {
        const b = await body(req)
        const incoming = Array.isArray(b.transactions) ? b.transactions : []
        const existing = new Set(data().transactions.map((t) => `${t.kioskId}:${t.transactionId}`))
        let added = 0
        for (const t of incoming) {
          const dedupe = `${kiosk.id}:${t.transactionId}`
          if (existing.has(dedupe)) continue
          data().transactions.push({ id: nextId('transactions'), kioskId: kiosk.id, ...t })
          existing.add(dedupe)
          added++
          if (t.paymentResult === 'approved' && t.dispenseResult && t.dispenseResult !== 'success') {
            data().alerts.push({ id: nextId('alerts'), kioskId: kiosk.id, transactionId: t.transactionId, coinSelected: t.coinSelected, amount: t.amount, dispenseResult: t.dispenseResult, createdAt: t.createdAt, resolved: false })
          }
        }
        // Hopper maintenance events (empty / refill) reported by the kiosk, for
        // central stock reconciliation. Deduped by the kiosk's local event id.
        const hEvents = Array.isArray(b.hopperEvents) ? b.hopperEvents : []
        let hAdded = 0
        if (hEvents.length) {
          const seen = new Set(data().hopperEvents.filter((e) => e.kioskId === kiosk.id).map((e) => e.srcId))
          for (const e of hEvents) {
            if (seen.has(e.srcId)) continue
            data().hopperEvents.push({
              id: nextId('hopperEvents'), kioskId: kiosk.id, srcId: e.srcId,
              hopperId: e.hopperId, type: e.type, quantity: e.quantity,
              oldStock: e.oldStock, newStock: e.newStock,
              operator: e.operator || null, operatorRole: e.operatorRole || null,
              createdAt: e.createdAt || new Date().toISOString()
            })
            seen.add(e.srcId)
            hAdded++
          }
        }
        save()
        logIngest(kiosk.id, 'in', 'sync', `tx received=${incoming.length} new=${added} · hopperEvents new=${hAdded}`)
        return json(res, 200, { ok: true, received: incoming.length, added, hopperEventsAdded: hAdded })
      }

      if (req.method === 'GET' && path === '/api/ingest/config') {
        logIngest(kiosk.id, 'out', 'config',
          `v=${kiosk.configVersion ?? 1} price=${kiosk.coinPriceCents ?? 9000} ` +
          `pinV=${kiosk.adminPinVersion ?? 0} status=${kiosk.operationalStatus}`)
        return json(res, 200, {
          configVersion: kiosk.configVersion ?? 1,
          coinPriceCents: kiosk.coinPriceCents ?? 9000,
          coinImages: coinImagesFor(kiosk),
          promo: { text: kiosk.promoText || '', enabled: !!kiosk.promoEnabled },
          qr: { enabled: !!kiosk.qrEnabled, url: kiosk.qrUrl || '', caption: kiosk.qrCaption || '' },
          marketing: { ...marketingSettings(kiosk), images: marketingImagesFor(kiosk).map((m) => ({ id: m.id, url: m.url })) },
          operationalStatus: kiosk.operationalStatus,
          destination: destById(kiosk.destinationId),
          adminPin: kiosk.adminPin || '',
          adminPinVersion: kiosk.adminPinVersion ?? 0,
          coins: { '1': kiosk.coin1Enabled !== false, '2': kiosk.coin2Enabled !== false },
          operators: data().operators.map((o) => ({ id: o.id, name: o.name, pin: o.pin, role: o.role })),
          // OTA policy: feed, approved target version, and the install window.
          ota: (() => {
            const s = getSettings()
            return {
              feedUrl: s.otaFeedUrl || '',
              channel: kiosk.otaChannel || s.otaChannel || 'stable',
              targetVersion: kiosk.targetVersion || '',
              windowStart: kiosk.updateWindowStart || s.otaWindowStart || '02:00',
              windowEnd: kiosk.updateWindowEnd || s.otaWindowEnd || '04:00',
              windowEnabled: (kiosk.updateWindowEnabled ?? s.otaWindowEnabled) !== false,
              forceVersion: kiosk.otaForceVersion || 0
            }
          })()
        })
      }
      return json(res, 404, { error: 'Not found' })
    }

    // ---- Everything else requires a valid session ----
    const sess = session(req)
    if (!sess) return json(res, 401, { error: 'Unauthorized' })
    const isAdmin = sess.role === 'admin'
    const requireAdmin = () => { json(res, 403, { error: 'Admin role required' }); return false }

    // Audit trail: record admin mutations (skip GETs and the audit/backup reads).
    if (isAdmin && req.method !== 'GET') logAudit(sess, req.method, path)

    // Current user
    if (req.method === 'GET' && path === '/api/me') {
      return json(res, 200, { username: sess.username, role: sess.role })
    }

    // Audit log (admin only)
    if (req.method === 'GET' && path === '/api/audit') {
      if (!isAdmin) return requireAdmin()
      const limit = Number(url.searchParams.get('limit') || 200)
      return json(res, 200, [...data().audit].sort((a, b) => b.id - a.id).slice(0, limit))
    }

    // Full dataset backup download (admin only)
    if (req.method === 'GET' && path === '/api/backup') {
      if (!isAdmin) return requireAdmin()
      const payload = JSON.stringify(data(), null, 2)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="fleet-backup-${stamp}.json"`,
        'Cache-Control': 'no-store'
      })
      res.end(payload)
      return
    }

    // ---- User management (admin only) ----
    if (path === '/api/users' || path.startsWith('/api/users/')) {
      if (!isAdmin) return requireAdmin()
      if (req.method === 'GET' && path === '/api/users') {
        return json(res, 200, listUsers())
      }
      if (req.method === 'POST' && path === '/api/users') {
        const b = await body(req)
        if (!b.username || !b.password) return json(res, 400, { error: 'username and password required' })
        if (findUser(b.username)) return json(res, 409, { error: 'User already exists' })
        data().users.push({ username: b.username, role: b.role === 'admin' ? 'admin' : 'viewer', password: hashPassword(b.password), createdAt: new Date().toISOString() })
        save()
        return json(res, 201, { ok: true })
      }
      const um = path.match(/^\/api\/users\/([^/]+)$/)
      if (um) {
        const target = findUser(decodeURIComponent(um[1]))
        if (!target) return json(res, 404, { error: 'User not found' })
        if (req.method === 'PATCH') {
          const b = await body(req)
          if (b.role && b.role !== target.role) {
            if (target.role === 'admin' && b.role !== 'admin' && adminCount() <= 1) return json(res, 400, { error: 'Cannot demote the last admin' })
            target.role = b.role === 'admin' ? 'admin' : 'viewer'
          }
          if (b.password) target.password = hashPassword(b.password)
          save()
          return json(res, 200, { ok: true })
        }
        if (req.method === 'DELETE') {
          if (target.username === sess.username) return json(res, 400, { error: 'Cannot delete yourself' })
          if (target.role === 'admin' && adminCount() <= 1) return json(res, 400, { error: 'Cannot delete the last admin' })
          data().users = data().users.filter((u) => u.username !== target.username)
          save()
          return json(res, 200, { ok: true })
        }
      }
      return json(res, 404, { error: 'Not found' })
    }

    // ---- Operator management (admin only) — field staff who service kiosks ----
    if (path === '/api/operators' || path.startsWith('/api/operators/')) {
      if (!isAdmin) return requireAdmin()
      const ops = data().operators
      const validRole = (r) => (['office', 'operator', 'viewer'].includes(r) ? r : 'operator')
      if (req.method === 'GET' && path === '/api/operators') {
        return json(res, 200, ops.map((o) => ({ id: o.id, name: o.name, pin: o.pin, role: o.role, createdAt: o.createdAt })))
      }
      if (req.method === 'POST' && path === '/api/operators') {
        const b = await body(req)
        const name = String(b.name || '').trim()
        const pin = String(b.pin || '').trim()
        if (!name) return json(res, 400, { error: 'Name is required' })
        if (!/^\d{4,8}$/.test(pin)) return json(res, 400, { error: 'PIN must be 4–8 digits' })
        if (ops.some((o) => o.pin === pin)) return json(res, 409, { error: 'That PIN is already used by another operator' })
        const rec = { id: nextId('operators'), name, pin, role: validRole(b.role), createdAt: new Date().toISOString() }
        ops.push(rec)
        bumpAllConfigs()
        save()
        return json(res, 201, { ok: true, operator: rec })
      }
      const om = path.match(/^\/api\/operators\/(\d+)$/)
      if (om) {
        const op = ops.find((o) => o.id === Number(om[1]))
        if (!op) return json(res, 404, { error: 'Operator not found' })
        if (req.method === 'PATCH') {
          const b = await body(req)
          if (b.name !== undefined) op.name = String(b.name).trim() || op.name
          if (b.role !== undefined) op.role = validRole(b.role)
          if (b.pin !== undefined) {
            const pin = String(b.pin).trim()
            if (!/^\d{4,8}$/.test(pin)) return json(res, 400, { error: 'PIN must be 4–8 digits' })
            if (ops.some((o) => o.pin === pin && o.id !== op.id)) return json(res, 409, { error: 'That PIN is already used by another operator' })
            op.pin = pin
          }
          bumpAllConfigs()
          save()
          return json(res, 200, { ok: true })
        }
        if (req.method === 'DELETE') {
          data().operators = ops.filter((o) => o.id !== op.id)
          bumpAllConfigs()
          save()
          return json(res, 200, { ok: true })
        }
      }
      return json(res, 404, { error: 'Not found' })
    }

    // Block mutations for viewers (read-only role)
    if (!isAdmin && req.method !== 'GET') return requireAdmin()

    // List kiosks (main dashboard)
    if (req.method === 'GET' && path === '/api/kiosks') {
      return json(res, 200, data().kiosks.map(kioskSummary))
    }

    // Add kiosk -> returns api key
    if (req.method === 'POST' && path === '/api/kiosks') {
      const b = await body(req)
      if (!b.id || !b.name) return json(res, 400, { error: 'id and name required' })
      if (kioskById(b.id)) return json(res, 409, { error: 'Kiosk id already exists' })
      const kiosk = {
        id: b.id, name: b.name, location: b.location || '',
        destinationId: b.destinationId || data().destinations[0]?.id || '',
        apiKey: 'kk_' + randomBytes(16).toString('hex'),
        operationalStatus: 'active', appVersion: '-', createdAt: new Date().toISOString(),
        coinPriceCents: typeof b.coinPriceCents === 'number' ? b.coinPriceCents : 9000,
        configVersion: 1, appliedConfigVersion: 0
      }
      data().kiosks.push(kiosk)
      save()
      return json(res, 201, kiosk)
    }

    // Destinations
    if (req.method === 'GET' && path === '/api/destinations') {
      const withCounts = data().destinations.map((d) => ({ ...d, kioskCount: data().kiosks.filter((k) => k.destinationId === d.id).length }))
      return json(res, 200, withCounts)
    }
    if (req.method === 'POST' && path === '/api/destinations') {
      const b = await body(req)
      if (!b.name) return json(res, 400, { error: 'name required' })
      const id = (b.id || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      if (!id) return json(res, 400, { error: 'invalid id' })
      if (destById(id)) return json(res, 409, { error: 'Destination id already exists' })
      data().destinations.push({ id, name: b.name, coins: b.coins || [{ slot: 1, label: 'Coin 1', priceCents: 9000 }, { slot: 2, label: 'Coin 2', priceCents: 9000 }] })
      save()
      return json(res, 201, { id, name: b.name })
    }
    const dm = path.match(/^\/api\/destinations\/([^/]+)$/)
    if (dm) {
      const dest = destById(decodeURIComponent(dm[1]))
      if (!dest) return json(res, 404, { error: 'Destination not found' })
      if (req.method === 'PATCH') {
        const b = await body(req)
        if (b.name) dest.name = b.name
        if (Array.isArray(b.coins)) dest.coins = b.coins
        save()
        return json(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        const inUse = data().kiosks.filter((k) => k.destinationId === dest.id).length
        if (inUse) return json(res, 400, { error: `In use by ${inUse} kiosk(s) — reassign them first` })
        data().destinations = data().destinations.filter((d) => d.id !== dest.id)
        save()
        return json(res, 200, { ok: true })
      }
    }

    // Cancel a scheduled price change
    if (req.method === 'POST' && path === '/api/schedules/cancel') {
      const b = await body(req)
      data().scheduledChanges = data().scheduledChanges.filter((s) => !(s.id === b.id && !s.applied))
      save()
      return json(res, 200, { ok: true })
    }

    // ---- Alert settings (thresholds + webhook) ----
    if (req.method === 'GET' && path === '/api/settings') {
      return json(res, 200, getSettings())
    }
    if (req.method === 'PUT' && path === '/api/settings') {
      const b = await body(req)
      const next = { ...getSettings() }
      if (typeof b.lowCoinThreshold === 'number') next.lowCoinThreshold = Math.max(0, Math.round(b.lowCoinThreshold))
      if (typeof b.offlineMinutes === 'number') next.offlineMinutes = Math.max(1, Math.round(b.offlineMinutes))
      if (typeof b.webhookUrl === 'string') next.webhookUrl = b.webhookUrl.trim()
      // OTA fleet-wide settings — a change here must reach every kiosk, so bump all configs.
      const beforeOta = JSON.stringify([next.otaFeedUrl, next.otaChannel, next.otaWindowStart, next.otaWindowEnd, next.otaWindowEnabled])
      if (typeof b.otaFeedUrl === 'string') next.otaFeedUrl = b.otaFeedUrl.trim()
      if (typeof b.otaChannel === 'string') next.otaChannel = b.otaChannel.trim() || 'stable'
      if (typeof b.otaWindowStart === 'string') next.otaWindowStart = b.otaWindowStart.trim()
      if (typeof b.otaWindowEnd === 'string') next.otaWindowEnd = b.otaWindowEnd.trim()
      if (typeof b.otaWindowEnabled === 'boolean') next.otaWindowEnabled = b.otaWindowEnabled
      const afterOta = JSON.stringify([next.otaFeedUrl, next.otaChannel, next.otaWindowStart, next.otaWindowEnd, next.otaWindowEnabled])
      data().settings = next
      if (beforeOta !== afterOta) bumpAllConfigs()
      save()
      return json(res, 200, next)
    }

    // ================= OTA: software updates =================
    // Release registry (versions you can deploy).
    if (path === '/api/releases' || path.startsWith('/api/releases/')) {
      if (!isAdmin) return requireAdmin()
      if (req.method === 'GET' && path === '/api/releases') {
        return json(res, 200, [...data().releases].sort((a, b) => b.id - a.id))
      }
      if (req.method === 'POST' && path === '/api/releases') {
        const b = await body(req)
        const version = String(b.version || '').trim()
        if (!/^\d+\.\d+\.\d+/.test(version)) return json(res, 400, { error: 'A version like 1.20.0 is required' })
        const channel = (String(b.channel || 'stable').trim()) || 'stable'
        if (data().releases.some((r) => r.version === version && r.channel === channel)) return json(res, 409, { error: 'That version is already registered on this channel' })
        if (b.isDefault) data().releases.forEach((r) => { if (r.channel === channel) r.isDefault = false })
        const rel = { id: nextId('releases'), version, channel, notes: String(b.notes || ''), isDefault: !!b.isDefault, createdAt: new Date().toISOString(), createdBy: sess.username }
        data().releases.push(rel); save()
        return json(res, 201, rel)
      }
      const rm = path.match(/^\/api\/releases\/(\d+)$/)
      if (rm) {
        const id = Number(rm[1])
        const rel = data().releases.find((r) => r.id === id)
        if (!rel) return json(res, 404, { error: 'Release not found' })
        if (req.method === 'DELETE') { data().releases = data().releases.filter((r) => r.id !== id); save(); return json(res, 200, { ok: true }) }
        if (req.method === 'PATCH') {
          const b = await body(req)
          if (b.isDefault) { data().releases.forEach((r) => { if (r.channel === rel.channel) r.isDefault = false }); rel.isDefault = true }
          if (typeof b.notes === 'string') rel.notes = b.notes
          save(); return json(res, 200, rel)
        }
      }
      return json(res, 404, { error: 'Not found' })
    }

    // Deploy a version to one / a group (tag or destination) / all.
    if (req.method === 'POST' && path === '/api/ota/deploy') {
      if (!isAdmin) return requireAdmin()
      const b = await body(req)
      const version = String(b.version || '').trim()
      if (!version) return json(res, 400, { error: 'version required' })
      const targets = otaTargets(b)
      if (!targets.length) return json(res, 400, { error: 'No matching kiosks' })
      for (const k of targets) {
        k.previousVersion = k.currentVersion || k.appVersion || ''
        k.targetVersion = version
        k.updateStatus = 'pending'
        bumpConfig(k)
      }
      save()
      return json(res, 200, { ok: true, deployed: targets.length, version })
    }

    // Roll a kiosk/group back to its previous version (or a specified one).
    if (req.method === 'POST' && path === '/api/ota/rollback') {
      if (!isAdmin) return requireAdmin()
      const b = await body(req)
      const targets = otaTargets(b)
      if (!targets.length) return json(res, 400, { error: 'No matching kiosks' })
      let n = 0
      for (const k of targets) {
        const to = (String(b.version || '').trim()) || k.previousVersion
        if (!to) continue
        k.targetVersion = to
        k.updateStatus = 'pending'
        bumpConfig(k); n++
      }
      save()
      return json(res, 200, { ok: true, rolledBack: n })
    }

    // "Update now": bump a one-shot force flag so the kiosk updates on its next
    // sync, ignoring the time window (still never mid-sale).
    if (req.method === 'POST' && path === '/api/ota/update-now') {
      if (!isAdmin) return requireAdmin()
      const b = await body(req)
      const targets = otaTargets(b)
      if (!targets.length) return json(res, 400, { error: 'No matching kiosks' })
      for (const k of targets) { k.otaForceVersion = (k.otaForceVersion || 0) + 1; bumpConfig(k) }
      save()
      return json(res, 200, { ok: true, triggered: targets.length })
    }

    // Per-kiosk update-window override (or clear to fall back to the fleet default).
    if (req.method === 'POST' && path === '/api/ota/window') {
      if (!isAdmin) return requireAdmin()
      const b = await body(req)
      const targets = otaTargets(b)
      if (!targets.length) return json(res, 400, { error: 'No matching kiosks' })
      for (const k of targets) {
        if (b.clear) { delete k.updateWindowStart; delete k.updateWindowEnd; delete k.updateWindowEnabled }
        else {
          if (typeof b.start === 'string') k.updateWindowStart = b.start.trim()
          if (typeof b.end === 'string') k.updateWindowEnd = b.end.trim()
          if (typeof b.enabled === 'boolean') k.updateWindowEnabled = b.enabled
        }
        bumpConfig(k)
      }
      save()
      return json(res, 200, { ok: true, updated: targets.length })
    }

    // ---- System alerts (offline / low-coin) ----
    if (req.method === 'GET' && path === '/api/system-alerts') {
      const open = data().systemAlerts.filter((a) => !a.resolved)
        .map((a) => ({ ...a, kioskName: kioskById(a.kioskId)?.name || a.kioskId }))
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      return json(res, 200, open)
    }
    if (req.method === 'POST' && path === '/api/system-alerts/ack') {
      const b = await body(req)
      const a = data().systemAlerts.find((x) => x.id === b.id && !x.resolved)
      if (a) { a.resolved = true; a.resolvedAt = new Date().toISOString(); save() }
      return json(res, 200, { ok: true })
    }

    // ---- Coin images (per-kiosk: each kiosk has its own Coin 1 + Coin 2) ----
    // List images, optionally filtered by kiosk + slot (for version history).
    if (req.method === 'GET' && path === '/api/images') {
      const kioskId = url.searchParams.get('kioskId')
      const slotQ = url.searchParams.get('slot')
      let list = [...data().images].sort((a, b) => b.id - a.id)
      if (kioskId) list = list.filter((i) => i.kioskId === kioskId)
      if (slotQ) list = list.filter((i) => i.slot === Number(slotQ))
      return json(res, 200, list.map((i) => ({ id: i.id, kioskId: i.kioskId, slot: i.slot, name: i.name, mime: i.mime, url: '/files/' + i.filename, uploadedAt: i.uploadedAt, uploadedBy: i.uploadedBy })))
    }
    // Upload an image FOR a specific kiosk + slot, and apply it to that kiosk.
    if (req.method === 'POST' && path === '/api/images') {
      const b = await body(req)
      const kiosk = kioskById(b.kioskId)
      if (!kiosk) return json(res, 400, { error: 'A valid kioskId is required' })
      const mime = b.mime || ''
      const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : null
      if (!ext || !b.dataBase64) return json(res, 400, { error: 'PNG or JPEG image required' })
      const slot = b.slot === 2 ? 2 : 1
      const id = nextId('images')
      const filename = `${kiosk.id}_coin${slot}_v${id}.${ext}`
      if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true })
      writeFileSync(join(IMAGES_DIR, filename), Buffer.from(b.dataBase64, 'base64'))
      const rec = { id, kioskId: kiosk.id, slot, name: b.name || filename, filename, mime, uploadedAt: new Date().toISOString(), uploadedBy: sess.username }
      data().images.push(rec)
      // Uploading publishes it to that kiosk's slot immediately.
      kiosk.coinImages = { ...(kiosk.coinImages || {}), [slot]: id }
      kiosk.configVersion = (kiosk.configVersion ?? 1) + 1
      kiosk.lastConfigUpdate = new Date().toISOString()
      save()
      return json(res, 201, { id: rec.id, kioskId: rec.kioskId, slot: rec.slot, name: rec.name, url: '/files/' + filename })
    }
    // Re-assign an existing image version to its kiosk's slot (revert).
    if (req.method === 'POST' && path === '/api/images/assign') {
      const b = await body(req)
      const img = imageById(b.imageId)
      if (!img) return json(res, 404, { error: 'Image not found' })
      const kiosk = kioskById(b.kioskId || img.kioskId)
      if (!kiosk) return json(res, 404, { error: 'Kiosk not found' })
      kiosk.coinImages = { ...(kiosk.coinImages || {}), [img.slot]: img.id }
      kiosk.configVersion = (kiosk.configVersion ?? 1) + 1
      kiosk.lastConfigUpdate = new Date().toISOString()
      save()
      return json(res, 200, { ok: true, kioskId: kiosk.id, slot: img.slot })
    }

    // ---- Marketing images + settings (per kiosk) ----
    if (req.method === 'GET' && path === '/api/marketing') {
      const k = kioskById(url.searchParams.get('kioskId'))
      if (!k) return json(res, 400, { error: 'valid kioskId required' })
      return json(res, 200, { settings: marketingSettings(k), images: marketingImagesFor(k) })
    }
    if (req.method === 'POST' && path === '/api/marketing/image') {
      const b = await body(req)
      const k = kioskById(b.kioskId)
      if (!k) return json(res, 400, { error: 'valid kioskId required' })
      const mime = b.mime || ''
      const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : null
      if (!ext || !b.dataBase64) return json(res, 400, { error: 'PNG or JPEG image required' })
      const id = nextId('marketingImages')
      const filename = `mkt_${k.id}_${id}.${ext}`
      if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true })
      writeFileSync(join(IMAGES_DIR, filename), Buffer.from(b.dataBase64, 'base64'))
      data().marketingImages.push({ id, kioskId: k.id, name: b.name || filename, filename, mime, uploadedAt: new Date().toISOString(), uploadedBy: sess.username })
      bumpConfig(k)
      save()
      return json(res, 201, { id, url: '/files/' + filename })
    }
    if (req.method === 'POST' && path === '/api/marketing/remove') {
      const b = await body(req)
      const m = data().marketingImages.find((x) => x.id === b.imageId)
      if (!m) return json(res, 404, { error: 'Image not found' })
      try { const f = join(IMAGES_DIR, m.filename); if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
      data().marketingImages = data().marketingImages.filter((x) => x.id !== m.id)
      const k = kioskById(m.kioskId); if (k) bumpConfig(k)
      save()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/api/marketing/settings') {
      const b = await body(req)
      const k = kioskById(b.kioskId)
      if (!k) return json(res, 400, { error: 'valid kioskId required' })
      const s = marketingSettings(k)
      if (b.enabled !== undefined) s.enabled = !!b.enabled
      if (b.slideSeconds !== undefined) s.slideSeconds = Math.max(2, Math.round(Number(b.slideSeconds) || 10))
      if (b.idleSeconds !== undefined) s.idleSeconds = Math.max(5, Math.round(Number(b.idleSeconds) || 60))
      if (b.activeStart !== undefined) s.activeStart = String(b.activeStart)
      if (b.activeEnd !== undefined) s.activeEnd = String(b.activeEnd)
      k.marketing = s
      bumpConfig(k)
      save()
      return json(res, 200, s)
    }

    // Global report
    if (req.method === 'GET' && path === '/api/reports/global') {
      const range = customRange(url)
      const period = range ? 'custom' : (url.searchParams.get('period') || 'all')
      const salesOf = (id) => range ? salesBetween(id, range.from, range.to) : salesFor(id, period)
      const kiosks = data().kiosks
      const byLocation = {}
      const perKiosk = []
      let totalSales = 0, totalRevenue = 0, totalCoins = 0
      for (const k of kiosks) {
        const s = salesOf(k.id)
        totalSales += s.totalSales
        totalRevenue += s.totalRevenue
        const dest = destById(k.destinationId)?.name || k.destinationId
        byLocation[dest] = byLocation[dest] || { sales: 0, revenue: 0 }
        byLocation[dest].sales += s.totalSales
        byLocation[dest].revenue += s.totalRevenue
        const hb = data().heartbeats[k.id]
        if (hb) totalCoins += (hb.hopper1?.coinCount || 0) + (hb.hopper2?.coinCount || 0)
        perKiosk.push({ id: k.id, name: k.name, location: k.location, destination: dest, online: isOnline(k.id), sales: s.totalSales, revenue: s.totalRevenue, coin1Sales: s.coin1Sales, coin2Sales: s.coin2Sales })
      }
      return json(res, 200, {
        period,
        from: url.searchParams.get('from') || null,
        to: url.searchParams.get('to') || null,
        totalSales,
        totalRevenue,
        totalTransactions: data().transactions.length,
        coinsInHoppers: totalCoins,
        kiosksOnline: kiosks.filter((k) => isOnline(k.id)).length,
        kiosksTotal: kiosks.length,
        openAlerts: data().alerts.filter((a) => !a.resolved).length,
        systemAlerts: data().systemAlerts.filter((a) => !a.resolved).length,
        byLocation,
        perKiosk
      })
    }

    // Daily sales/revenue time series (fleet-wide) — last N days or a date range
    if (req.method === 'GET' && path === '/api/reports/timeseries') {
      const days = Math.min(180, Math.max(1, Number(url.searchParams.get('days') || 30)))
      return json(res, 200, timeseries(null, days, url.searchParams.get('from'), url.searchParams.get('to')))
    }

    // Kiosk-scoped routes: /api/kiosks/:id/...
    const m = path.match(/^\/api\/kiosks\/([^/]+)(\/(\w+))?$/)
    if (m) {
      const kiosk = kioskById(m[1])
      if (!kiosk) return json(res, 404, { error: 'Kiosk not found' })
      const sub = m[3]

      if (req.method === 'PATCH' && !sub) {
        const b = await body(req)
        if (b.operationalStatus) kiosk.operationalStatus = b.operationalStatus
        if (b.name) kiosk.name = b.name
        if (b.location !== undefined) kiosk.location = b.location
        if (b.destinationId) kiosk.destinationId = b.destinationId
        if (Array.isArray(b.tags)) kiosk.tags = b.tags.map((t) => String(t).trim()).filter(Boolean)
        // A pricing change bumps the kiosk's config version; the kiosk applies it
        // and confirms via the appliedConfigVersion it reports in its heartbeat.
        if (typeof b.coinPriceCents === 'number' && b.coinPriceCents !== kiosk.coinPriceCents) {
          kiosk.coinPriceCents = Math.max(0, Math.round(b.coinPriceCents))
          kiosk.configVersion = (kiosk.configVersion ?? 1) + 1
          kiosk.lastConfigUpdate = new Date().toISOString()
        }
        // Per-coin availability — enable/disable each coin remotely (e.g. when a
        // hopper is out of stock). Bumps config so the kiosk hides/shows it.
        for (const [field, slot] of [['coin1Enabled', 1], ['coin2Enabled', 2]]) {
          if (b[field] !== undefined) {
            const val = !!b[field]
            if (val !== (kiosk[field] !== false)) {
              kiosk[field] = val
              bumpConfig(kiosk)
            }
          }
        }
        // Admin PIN override — push a 4–8 digit PIN to the kiosk, or '' to leave
        // the kiosk on its own locally-set PIN. Bumps config version when changed.
        if (b.adminPin !== undefined) {
          const newPin = String(b.adminPin).trim()
          if (newPin === '' || /^\d{4,8}$/.test(newPin)) {
            if (newPin !== (kiosk.adminPin || '')) {
              kiosk.adminPin = newPin
              // One-shot push: bump a dedicated PIN version so the kiosk applies it
              // exactly once and never re-applies it on unrelated config syncs.
              kiosk.adminPinVersion = (kiosk.adminPinVersion ?? 0) + 1
              bumpConfig(kiosk)
            }
          }
        }
        // Promotional message — bump config version when it changes so the kiosk picks it up.
        if (b.promoText !== undefined || b.promoEnabled !== undefined) {
          const newText = b.promoText !== undefined ? String(b.promoText).slice(0, 280) : (kiosk.promoText || '')
          const newEnabled = b.promoEnabled !== undefined ? !!b.promoEnabled : !!kiosk.promoEnabled
          if (newText !== (kiosk.promoText || '') || newEnabled !== !!kiosk.promoEnabled) {
            kiosk.promoText = newText
            kiosk.promoEnabled = newEnabled
            kiosk.configVersion = (kiosk.configVersion ?? 1) + 1
            kiosk.lastConfigUpdate = new Date().toISOString()
          }
        }
        // QR code (home-screen, bottom-right)
        if (b.qrUrl !== undefined || b.qrEnabled !== undefined || b.qrCaption !== undefined) {
          const url = b.qrUrl !== undefined ? String(b.qrUrl).slice(0, 500) : (kiosk.qrUrl || '')
          const enabled = b.qrEnabled !== undefined ? !!b.qrEnabled : !!kiosk.qrEnabled
          const caption = b.qrCaption !== undefined ? String(b.qrCaption).slice(0, 60) : (kiosk.qrCaption || '')
          if (url !== (kiosk.qrUrl || '') || enabled !== !!kiosk.qrEnabled || caption !== (kiosk.qrCaption || '')) {
            kiosk.qrUrl = url
            kiosk.qrEnabled = enabled
            kiosk.qrCaption = caption
            kiosk.configVersion = (kiosk.configVersion ?? 1) + 1
            kiosk.lastConfigUpdate = new Date().toISOString()
          }
        }
        save()
        return json(res, 200, kiosk)
      }

      if (req.method === 'GET' && !sub) {
        const hb = data().heartbeats[kiosk.id] || {}
        return json(res, 200, {
          ...kiosk,
          destination: destById(kiosk.destinationId),
          online: isOnline(kiosk.id),
          synced: (kiosk.configVersion ?? 1) === (kiosk.appliedConfigVersion ?? 0),
          health: hb
        })
      }

      // Delete a kiosk profile and all data tied to it.
      if (req.method === 'DELETE' && !sub) {
        const d = data()
        // remove its image files from disk
        for (const img of [...d.images, ...d.marketingImages].filter((i) => i.kioskId === kiosk.id)) {
          try { const f = join(IMAGES_DIR, img.filename); if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
        }
        d.kiosks = d.kiosks.filter((k) => k.id !== kiosk.id)
        d.images = d.images.filter((i) => i.kioskId !== kiosk.id)
        d.marketingImages = d.marketingImages.filter((i) => i.kioskId !== kiosk.id)
        d.transactions = d.transactions.filter((t) => t.kioskId !== kiosk.id)
        d.alerts = d.alerts.filter((a) => a.kioskId !== kiosk.id)
        d.maintenance = d.maintenance.filter((x) => x.kioskId !== kiosk.id)
        d.refills = d.refills.filter((x) => x.kioskId !== kiosk.id)
        d.systemAlerts = d.systemAlerts.filter((x) => x.kioskId !== kiosk.id)
        delete d.heartbeats[kiosk.id]
        save()
        return json(res, 200, { ok: true })
      }

      // Inventory: hopper levels, days-to-empty, and cash reconciliation.
      if (req.method === 'GET' && sub === 'inventory') {
        const r = customRange(url)
        const { from, to } = r || periodBounds(url.searchParams.get('period') || 'month')
        return json(res, 200, {
          hoppers: hopperInventory(kiosk),
          reconciliation: { from, to, coins: reconcile(kiosk, from, to) },
          maintenance: data().hopperEvents
            .filter((e) => e.kioskId === kiosk.id)
            .sort((a, b) => b.id - a.id)
            .slice(0, 100)
        })
      }

      // (Dashboard "log refill" was retired — refills are now recorded on the
      // kiosk and synced up as hopper maintenance events.)

      // Schedule a future price change
      if (req.method === 'POST' && sub === 'schedule') {
        const b = await body(req)
        const priceCents = Math.max(0, Math.round(Number(b.priceCents) || 0))
        if (!b.applyAt || isNaN(new Date(b.applyAt).getTime())) return json(res, 400, { error: 'valid applyAt required' })
        const rec = { id: nextId('scheduledChanges'), kioskId: kiosk.id, priceCents, applyAt: new Date(b.applyAt).toISOString(), applied: false, by: sess.username, createdAt: new Date().toISOString() }
        data().scheduledChanges.push(rec)
        save()
        return json(res, 201, rec)
      }
      if (req.method === 'GET' && sub === 'schedules') {
        return json(res, 200, data().scheduledChanges.filter((s) => s.kioskId === kiosk.id)
          .sort((a, b2) => a.applyAt.localeCompare(b2.applyAt)))
      }

      // Regenerate (rotate) the kiosk's API key — invalidates the old one.
      if (req.method === 'POST' && sub === 'regenerate') {
        kiosk.apiKey = 'kk_' + randomBytes(16).toString('hex')
        save()
        return json(res, 200, { apiKey: kiosk.apiKey })
      }
      if (req.method === 'GET' && sub === 'transactions') {
        const range = customRange(url)
        let rows = data().transactions.filter((t) => t.kioskId === kiosk.id)
        if (range) rows = rows.filter((t) => norm(t.createdAt) >= range.from && norm(t.createdAt) <= range.to)
        rows = rows.sort((a, b2) => norm(b2.createdAt).localeCompare(norm(a.createdAt))).slice(0, range ? 2000 : 200)
        return json(res, 200, rows)
      }
      if (req.method === 'GET' && sub === 'sales') {
        const range = customRange(url)
        return json(res, 200, range ? salesBetween(kiosk.id, range.from, range.to) : salesFor(kiosk.id, url.searchParams.get('period') || 'today'))
      }
      if (req.method === 'GET' && sub === 'timeseries') {
        const days = Math.min(180, Math.max(1, Number(url.searchParams.get('days') || 30)))
        return json(res, 200, timeseries(kiosk.id, days, url.searchParams.get('from'), url.searchParams.get('to')))
      }
      if (req.method === 'GET' && sub === 'alerts') {
        return json(res, 200, data().alerts.filter((a) => a.kioskId === kiosk.id && !a.resolved))
      }
      if (req.method === 'GET' && sub === 'maintenance') {
        return json(res, 200, data().maintenance.filter((x) => x.kioskId === kiosk.id))
      }
      if (req.method === 'POST' && sub === 'maintenance') {
        const b = await body(req)
        const rec = { id: nextId('maintenance'), kioskId: kiosk.id, note: b.note || '', by: sess.username, createdAt: new Date().toISOString() }
        data().maintenance.push(rec)
        save()
        return json(res, 201, rec)
      }
    }

    // Resolve an alert
    if (req.method === 'POST' && path === '/api/alerts/resolve') {
      const b = await body(req)
      const a = data().alerts.find((x) => x.transactionId === b.transactionId && !x.resolved)
      if (a) { a.resolved = true; save() }
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'Not found' })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
})

// ------------------------------------------------------------------ static
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
function serveStatic(path, res) {
  const rel = path === '/' ? '/index.html' : path
  const file = join(ROOT, 'public', rel)
  if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) {
    res.writeHead(404); res.end('Not found'); return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
}

function serveImage(name, res) {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '')
  const file = join(IMAGES_DIR, safe)
  if (!file.startsWith(IMAGES_DIR) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' })
  res.end(readFileSync(file))
}

// Fleet health monitoring + scheduled changes — run on boot and every 60s.
const tick = () => { applyDueSchedules(); monitorFleet() }
tick()
setInterval(tick, 60_000)

server.listen(PORT, '0.0.0.0', () => {
  console.log('[fleet] Central Admin Web Application running:')
  console.log(`        • http://localhost:${PORT}`)
  console.log(`[fleet] sign in as "${ADMIN_USER}" (default admin)`)
  if (ADMIN_PASSWORD === 'fleet-admin') console.log('[fleet] WARNING: default password. Set FLEET_ADMIN_PASSWORD (and change it in the Users screen).')
})
