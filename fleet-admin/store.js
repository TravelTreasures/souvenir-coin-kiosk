/**
 * Tiny JSON-file data store for the fleet server.
 *
 * Loads the whole dataset into memory on start and writes it back to
 * data/fleet.json on each change (debounced). Zero dependencies. For a large
 * production fleet, swap this module for PostgreSQL — the rest of the server
 * only talks to the helper functions below.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
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
  releases: [] // { id, version, channel, notes, isDefault, createdAt, createdBy } — OTA build registry
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

export function save() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8')
    } catch (err) {
      console.error('[store] save failed:', err.message)
    }
  }, 50)
}

export function data() {
  return db
}

export function nextId(collection) {
  const arr = db[collection]
  return arr.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1
}
