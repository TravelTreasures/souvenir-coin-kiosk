/**
 * Tiny JSON-file data store for the fleet server.
 *
 * Loads the whole dataset into memory on start and writes it back to
 * data/fleet.json on each change (debounced). Zero dependencies. For a large
 * production fleet, swap this module for PostgreSQL — the rest of the server
 * only talks to the helper functions below.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(ROOT, 'data')
const DATA_FILE = join(DATA_DIR, 'fleet.json')

const EMPTY = {
  users: [], // { username, role:'admin'|'viewer', password:'salt:hash', createdAt }
  operators: [], // { id, name, pin, role:'office'|'operator'|'viewer', createdAt } — field staff who service kiosks
  images: [], // { id, slot, name, filename, mime, uploadedAt, uploadedBy }
  marketingImages: [], // { id, kioskId, name, filename, mime, uploadedAt, uploadedBy }
  systemAlerts: [], // { id, kioskId, type, message, createdAt, resolved }
  refills: [], // { id, kioskId, slot, added, newCount, by, createdAt }
  hopperEvents: [], // { id, kioskId, srcId, hopperId, type:'empty'|'refill', quantity, oldStock, newStock, operator, createdAt }
  scheduledChanges: [], // { id, kioskId, priceCents, applyAt, applied, by, createdAt }
  audit: [], // { id, at, user, role, method, path }
  settings: {}, // { lowCoinThreshold, offlineMinutes, webhookUrl }
  destinations: [], // { id, name, coins:[{slot,label,priceCents}] }
  kiosks: [], // { id, name, location, destinationId, apiKey, operationalStatus, appVersion, createdAt }
  heartbeats: {}, // kioskId -> { lastSeen, hopper1, hopper2, mdbConnected, nayaxConnected, appVersion }
  transactions: [], // { id, kioskId, transactionId, amount, coinSelected, paymentResult, dispenseResult, createdAt }
  alerts: [], // { id, kioskId, transactionId, coinSelected, amount, dispenseResult, createdAt, resolved }
  maintenance: [], // { id, kioskId, note, by, createdAt }
  releases: [], // { id, version, channel, notes, isDefault, createdAt, createdBy } — OTA build registry
  nayaxLogs: {}, // kioskId -> { at, entries:[{at,dir,hex,event,note}] } — reader serial trace (diagnostics)
  txArchive: {} // kioskId -> { 'YYYY-MM': { totalSales, totalRevenue, coin1/2/comboSales, coin1/2/comboRevenue, monthStart, monthEnd } } — rolled-up old sales
}

let db = structuredClone(EMPTY)
let saveTimer = null

export function load() {
  try {
    if (existsSync(DATA_FILE)) {
      db = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(DATA_FILE, 'utf8')) }
    }
  } catch (err) {
    console.error('[store] failed to load, starting empty:', err.message)
    db = structuredClone(EMPTY)
  }
  return db
}

/**
 * Write the dataset to disk NOW.
 *  • Compact JSON (no indentation): roughly half the bytes, faster to write.
 *  • Atomic: written to a temp file, then renamed over the real one — so a crash
 *    or power cut mid-write can never leave fleet.json half-written (it holds
 *    every kiosk, key and sale).
 */
function writeNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  saveDeadline = 0
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const tmp = DATA_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(db), 'utf8')
    renameSync(tmp, DATA_FILE)
  } catch (err) {
    console.error('[store] save failed:', err.message)
  }
}

let saveDeadline = 0 // when the pending write is due (ms epoch); 0 = none pending

function schedule(ms) {
  const due = Date.now() + ms
  // Never push an already-scheduled write further away; only pull it closer.
  if (saveTimer && saveDeadline && saveDeadline <= due) return
  if (saveTimer) clearTimeout(saveTimer)
  saveDeadline = due
  saveTimer = setTimeout(writeNow, ms)
}

/** Persist soon (50 ms) — for real changes: sales, refills, settings, users. */
export function save() {
  schedule(50)
}

/**
 * Persist lazily (within 5 s) — for routine kiosk chatter such as heartbeats and
 * the Nayax log. Every kiosk sends a heartbeat every 20 s; rewriting the whole
 * file for each one meant a full rewrite about once a second with 20 kiosks.
 * Batched like this it is at most one write every 5 s, however many kiosks.
 */
export function saveSoon() {
  schedule(5000)
}

/** Write any pending change immediately (used on shutdown). */
export function flush() {
  if (saveTimer) writeNow()
}

// systemd stops the service with SIGTERM (restart / reboot): write pending data
// first so a lazily-batched heartbeat or sale is never lost.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { flush(); process.exit(0) })
}

export function data() {
  return db
}

export function nextId(collection) {
  const arr = db[collection]
  return arr.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1
}
