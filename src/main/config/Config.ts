/**
 * Kiosk configuration store.
 *
 * Stored as a JSON file in the Electron userData directory so it persists and
 * is available even if the SQLite native module fails to load. Holds the coin
 * price plus the fleet-sync settings (central server URL, this kiosk's API key,
 * and bookkeeping for what config/transactions have been synced).
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export type OperatorRole = 'office' | 'operator' | 'viewer'
export interface KioskOperator {
  id: number
  name: string
  pin: string
  role: OperatorRole
}

export interface KioskConfig {
  /** Price per coin, in cents. Same for all coins. Pushed from the fleet server. */
  coinPriceCents: number

  /**
   * Seconds the kiosk waits at product selection / payment for the customer to act
   * before it auto-cancels the pending Nayax transaction and returns to idle.
   */
  transactionTimeoutSeconds?: number

  /** Name of the operator doing hopper maintenance (remembered for the audit log). */
  maintenanceOperator?: string

  /** Operator accounts (name + PIN + role) synced from the fleet server. */
  operators?: KioskOperator[]

  /** PIN that unlocks the on-screen Admin panel. Default '1234' — change on site. */
  adminPin?: string
  /**
   * Highest fleet "PIN push" version this kiosk has already applied. The central
   * PIN is a one-shot command: it's only applied when the server's adminPinVersion
   * is higher than this, so an unrelated config sync (e.g. a price change) never
   * overwrites a PIN the operator set locally on the kiosk.
   */
  appliedAdminPinVersion?: number

  // ---- Fleet sync ----
  /** This kiosk's id as registered in the fleet server. */
  kioskId?: string
  /** Central fleet server base URL, e.g. https://fleet.example.com */
  fleetUrl?: string
  /** Per-kiosk API key issued by the fleet server. */
  fleetApiKey?: string
  /** Highest fleet config version this kiosk has applied (confirmation). */
  appliedConfigVersion: number
  /** Highest local transaction id already pushed to the fleet server. */
  lastSyncedTxId: number
  /** Highest local hopper-event id already pushed to the fleet server. */
  lastSyncedHopperEventId?: number
  /** Last sync outcome, for showing connection health in Admin → System. */
  fleetStatus?: { state: 'ok' | 'auth_failed' | 'error' | 'offline'; at: string; code?: number }

  /** Per-coin availability, pushed from the fleet server. A disabled coin is
   *  hidden on the kiosk so customers can't buy it (e.g. its hopper is empty). */
  coinsEnabled?: { '1': boolean; '2': boolean }

  /** Operational status pushed from the fleet server: 'active' = normal, anything
   *  else ('maintenance' | 'out_of_service') takes the kiosk offline to customers
   *  (an "unavailable" screen; Admin still reachable). */
  operationalStatus?: string

  // ---- Combo Sale (both coins as one product) ----
  /** Fleet master switch: is the combo offered at all. */
  comboEnabled?: boolean
  /** Fleet combo price (cents). Used unless a permitted kiosk override applies. */
  comboPriceCents?: number
  /** Fleet permission: may this kiosk set its own combo price. */
  comboAllowKioskOverride?: boolean
  /** Kiosk-local combo price override (cents) — only honoured if allowed by fleet. */
  comboPriceCentsLocal?: number
  /** Kiosk-local enable flag. Can only turn the combo OFF; it can never force it
   *  ON when the fleet has it disabled. Undefined = follow the fleet. */
  comboEnabledLocal?: boolean

  // ---- Remote coin images (downloaded from the fleet server) ----
  /** Per-slot coin image as a data URL, applied from the fleet config. */
  coinImages?: { '1'?: string; '2'?: string }
  /** Per-slot fleet image id currently applied (to detect changes). */
  coinImageIds?: { '1'?: number; '2'?: number }

  // ---- Promotional banner (pushed from the fleet server) ----
  promoText?: string
  promoEnabled?: boolean

  // ---- QR code (home-screen, pushed from the fleet server) ----
  qrEnabled?: boolean
  qrUrl?: string
  qrCaption?: string

  // ---- Marketing slideshow (pushed from the fleet server) ----
  marketing?: {
    enabled: boolean
    slideSeconds: number
    idleSeconds: number
    activeStart: string
    activeEnd: string
  }
  /** Marketing images as data URLs, in order. */
  marketingImages?: string[]
  /** Fleet marketing image ids currently applied (to detect changes). */
  marketingImageIds?: number[]

  // ---- OTA software updates (policy pushed from the fleet server) ----
  /** Release feed base URL electron-updater reads (generic provider). */
  otaFeedUrl?: string
  /** Release channel, e.g. 'stable' | 'beta'. */
  otaChannel?: string
  /** Version this kiosk is approved to run (deployed from the dashboard).
   *  Empty = take the latest build on the channel feed. */
  otaTargetVersion?: string
  /** Allowed install window, kiosk-local 24h time, e.g. '02:00'. */
  otaWindowStart?: string
  otaWindowEnd?: string
  /** When false, updates may install at any idle moment (window ignored). */
  otaWindowEnabled?: boolean
  /** One-shot "install now" nonce from the server: when higher than
   *  otaForceVersionApplied, the kiosk checks/updates immediately, ignoring the window. */
  otaForceVersion?: number
  otaForceVersionApplied?: number
  /** Last OTA state reported back to the server. */
  otaStatus?: 'idle' | 'checking' | 'pending' | 'downloading' | 'installing' | 'successful' | 'failed'
  otaError?: string
  /** Version running before the last applied update (rollback bookkeeping). */
  otaPreviousVersion?: string
  otaLastUpdateAt?: string
}

const DEFAULTS: KioskConfig = {
  coinPriceCents: 9000, // R90.00
  transactionTimeoutSeconds: 45,
  adminPin: '1234',
  appliedAdminPinVersion: 0,
  appliedConfigVersion: 0,
  lastSyncedTxId: 0,
  // OTA defaults: overnight window 02:00–04:00 local, enabled, stable channel.
  otaChannel: 'stable',
  otaWindowStart: '02:00',
  otaWindowEnd: '04:00',
  otaWindowEnabled: true,
  otaForceVersionApplied: 0,
  otaStatus: 'idle'
}

let cached: KioskConfig | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'kiosk-config.json')
}

export function getConfig(): KioskConfig {
  if (cached) return cached
  let result: KioskConfig = { ...DEFAULTS }
  try {
    const p = configPath()
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf8'))
      result = { ...DEFAULTS, ...data }
    }
  } catch (err) {
    console.error('[config] could not read config, using defaults:', err)
  }
  cached = result
  return result
}

function writeConfig(next: KioskConfig): KioskConfig {
  cached = next
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[config] could not persist config:', err)
  }
  return next
}

/** Merge a partial update into the config and persist it. */
export function updateConfig(patch: Partial<KioskConfig>): KioskConfig {
  return writeConfig({ ...getConfig(), ...patch })
}

/** Record the current OTA state so the next heartbeat reports it to the fleet server. */
export function setOtaStatus(
  status: NonNullable<KioskConfig['otaStatus']>,
  error?: string
): KioskConfig {
  return updateConfig({ otaStatus: status, otaError: error ?? '' })
}

export function getPriceCents(): number {
  const price = getConfig().coinPriceCents
  return Number.isFinite(price) && price > 0 ? price : DEFAULTS.coinPriceCents
}

export function setPriceCents(cents: number): KioskConfig {
  return updateConfig({ coinPriceCents: Math.max(0, Math.round(cents)) })
}

/** Operator accounts synced from the fleet server (empty if none/not synced). */
export function getOperators(): KioskOperator[] {
  const ops = getConfig().operators
  return Array.isArray(ops) ? ops : []
}

/** Fleet operational status: 'active' (default) means the kiosk serves customers;
 *  'maintenance' / 'out_of_service' take it offline (unavailable screen). */
export function getOperationalStatus(): string {
  const s = getConfig().operationalStatus
  return typeof s === 'string' && s ? s : 'active'
}

/** Which coins are currently available (default both). */
export function getCoinsEnabled(): { '1': boolean; '2': boolean } {
  const c = getConfig().coinsEnabled
  return { '1': c ? c['1'] !== false : true, '2': c ? c['2'] !== false : true }
}

/**
 * Resolved Combo Sale configuration for this kiosk.
 *  - enabled:   combo offered now (fleet master ON, and not turned off locally)
 *  - priceCents: the ACTIVE combo price — a permitted kiosk override wins,
 *               otherwise the fleet price
 *  - allowOverride: whether the kiosk is permitted to set its own combo price
 *  - fleetPriceCents / localPriceCents: the two underlying values (for Admin UI)
 */
export function getComboConfig(): {
  enabled: boolean
  priceCents: number
  allowOverride: boolean
  fleetPriceCents: number
  localPriceCents: number | null
} {
  const c = getConfig()
  const fleetPrice = typeof c.comboPriceCents === 'number' ? c.comboPriceCents : 0
  const localPrice = typeof c.comboPriceCentsLocal === 'number' ? c.comboPriceCentsLocal : null
  const allowOverride = c.comboAllowKioskOverride === true
  const priceCents = allowOverride && localPrice !== null ? localPrice : fleetPrice
  const enabled = c.comboEnabled === true && c.comboEnabledLocal !== false
  return { enabled, priceCents, allowOverride, fleetPriceCents: fleetPrice, localPriceCents: localPrice }
}

/** Set the kiosk-local combo price override (cents). Only takes effect when the
 *  fleet permits overrides; otherwise it is stored but ignored by getComboConfig. */
export function setComboLocalPrice(cents: number): KioskConfig {
  return updateConfig({ comboPriceCentsLocal: Math.max(0, Math.round(cents)) })
}

/** Turn the combo on/off locally. Passing true clears the local-off flag (follow
 *  the fleet); passing false forces it off on this kiosk regardless of fleet. */
export function setComboEnabledLocal(on: boolean): KioskConfig {
  return updateConfig({ comboEnabledLocal: on ? undefined : false })
}

/** Inactivity timeout (seconds) for product selection / payment. Clamped 10–300s. */
export function getTransactionTimeoutSeconds(): number {
  const s = getConfig().transactionTimeoutSeconds
  return typeof s === 'number' && s >= 10 && s <= 300 ? s : 45
}

export function setTransactionTimeoutSeconds(seconds: number): KioskConfig {
  return updateConfig({ transactionTimeoutSeconds: Math.max(10, Math.min(300, Math.round(seconds))) })
}

/** The current admin PIN (falls back to the default if unset). */
export function getAdminPin(): string {
  const pin = getConfig().adminPin
  return typeof pin === 'string' && pin.length >= 4 ? pin : DEFAULTS.adminPin!
}

/** True if the supplied PIN matches the configured admin PIN. */
export function verifyAdminPin(pin: string): boolean {
  return typeof pin === 'string' && pin === getAdminPin()
}

/**
 * Change the admin PIN. Requires the current PIN. New PIN must be 4–8 digits.
 * Returns { ok } or { ok:false, error } so the UI can show a reason.
 */
export function changeAdminPin(current: string, next: string): { ok: boolean; error?: string } {
  if (!verifyAdminPin(current)) return { ok: false, error: 'Current PIN is incorrect.' }
  if (!/^\d{4,8}$/.test(next)) return { ok: false, error: 'New PIN must be 4 to 8 digits.' }
  updateConfig({ adminPin: next })
  return { ok: true }
}
