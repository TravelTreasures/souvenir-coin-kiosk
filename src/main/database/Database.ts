/**
 * SQLite Database Layer
 * Uses better-sqlite3 for synchronous, embedded storage.
 * DB file is stored in the Electron userData directory.
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'

export type DispenseResult = 'success' | 'empty' | 'jam' | 'comm_failure' | 'unknown_error'

export interface Transaction {
  id?: number
  transactionId: string
  amount: number
  coinSelected: 1 | 2
  paymentResult: string
  dispenseResult: DispenseResult | null
  nayaxAuthCode: string | null
  nayaxCardType: string | null
  alertSent: number // 0 | 1
  createdAt: string
}

export interface HopperEvent {
  id?: number
  hopperId: 1 | 2
  type: 'empty' | 'refill'
  quantity: number
  oldStock: number
  newStock: number
  reason: string | null
  operator: string | null
  operatorRole?: string | null
  createdAt?: string
}

export interface SalesReport {
  totalSales: number
  totalRevenue: number
  coin1Sales: number
  coin2Sales: number
  coin1Revenue: number
  coin2Revenue: number
  periodStart: string
  periodEnd: string
}

// ------------------------------------------------------------------
// Singleton DB instance
//
// The database is best-effort: if the native module fails to load (e.g.
// better-sqlite3 built for the wrong CPU architecture), the kiosk must
// still take payments and dispense coins. In that case persistence is
// disabled and operations degrade gracefully instead of crashing.
// ------------------------------------------------------------------
let db: Database.Database | null = null
let dbUnavailable = false

export function isDBAvailable(): boolean {
  return getDB() !== null
}

export function getDB(): Database.Database | null {
  if (db) return db
  if (dbUnavailable) return null
  try {
    const dbPath = path.join(app.getPath('userData'), 'kiosk.db')
    console.log('[DB] Opening database at', dbPath)
    db = new Database(dbPath)
    initialiseSchema(db)
    return db
  } catch (err) {
    dbUnavailable = true
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DB] Database unavailable — running WITHOUT persistence:', msg)
    return null
  }
}

function initialiseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id   TEXT    NOT NULL UNIQUE,
      amount           INTEGER NOT NULL,  -- in cents
      coin_selected    INTEGER NOT NULL,  -- 1 or 2
      payment_result   TEXT    NOT NULL,
      dispense_result  TEXT,
      nayax_auth_code  TEXT,
      nayax_card_type  TEXT,
      alert_sent       INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS hopper_counts (
      hopper_id  INTEGER PRIMARY KEY,  -- 1 or 2
      coin_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      level      TEXT NOT NULL,  -- 'warn' | 'error' | 'critical'
      category   TEXT NOT NULL,  -- 'mdb' | 'nayax' | 'dispense' | 'system'
      message    TEXT NOT NULL,
      context    TEXT,           -- JSON blob
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Permanent audit of hopper emptying (maintenance dispense) and refills.
    -- These are NOT customer sales and never affect revenue/transaction totals.
    CREATE TABLE IF NOT EXISTS hopper_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      hopper_id  INTEGER NOT NULL,        -- 1 or 2
      type       TEXT    NOT NULL,        -- 'empty' | 'refill'
      quantity   INTEGER NOT NULL,        -- tokens emptied, or tokens added
      old_stock  INTEGER NOT NULL,
      new_stock  INTEGER NOT NULL,
      reason     TEXT,
      operator   TEXT,
      operator_role TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    INSERT OR IGNORE INTO hopper_counts (hopper_id, coin_count) VALUES (1, 0);
    INSERT OR IGNORE INTO hopper_counts (hopper_id, coin_count) VALUES (2, 0);
  `)
  // Migration: add operator_role to hopper_events created before it existed.
  try { db.exec('ALTER TABLE hopper_events ADD COLUMN operator_role TEXT') } catch { /* column already exists */ }
}

// ------------------------------------------------------------------
// Transactions
// ------------------------------------------------------------------
export function insertTransaction(t: Omit<Transaction, 'id' | 'createdAt'>): Transaction {
  const db = getDB()
  if (!db) return { ...t, id: -1, createdAt: new Date().toISOString() }
  const stmt = db.prepare(`
    INSERT INTO transactions
      (transaction_id, amount, coin_selected, payment_result, dispense_result,
       nayax_auth_code, nayax_card_type, alert_sent)
    VALUES
      (@transactionId, @amount, @coinSelected, @paymentResult, @dispenseResult,
       @nayaxAuthCode, @nayaxCardType, @alertSent)
  `)
  const info = stmt.run(t)
  return { ...t, id: info.lastInsertRowid as number, createdAt: new Date().toISOString() }
}

export function updateDispenseResult(
  transactionId: string,
  dispenseResult: DispenseResult,
  alertSent = 0
): void {
  const db = getDB()
  if (!db) return
  db
    .prepare(
      `UPDATE transactions
       SET dispense_result = ?, alert_sent = ?
       WHERE transaction_id = ?`
    )
    .run(dispenseResult, alertSent, transactionId)
}

export function getTransactions(limit = 200, offset = 0): Transaction[] {
  const db = getDB()
  if (!db) return []
  return db
    .prepare(
      `SELECT id,
              transaction_id AS transactionId,
              amount,
              coin_selected  AS coinSelected,
              payment_result AS paymentResult,
              dispense_result AS dispenseResult,
              nayax_auth_code AS nayaxAuthCode,
              nayax_card_type AS nayaxCardType,
              alert_sent      AS alertSent,
              created_at      AS createdAt
       FROM transactions
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Transaction[]
}

/** Transactions with id greater than `sinceId` (for pushing to the fleet server). */
export function getTransactionsSince(sinceId: number, limit = 500): Transaction[] {
  const db = getDB()
  if (!db) return []
  return db
    .prepare(
      `SELECT id,
              transaction_id AS transactionId,
              amount,
              coin_selected  AS coinSelected,
              payment_result AS paymentResult,
              dispense_result AS dispenseResult,
              nayax_auth_code AS nayaxAuthCode,
              nayax_card_type AS nayaxCardType,
              alert_sent      AS alertSent,
              created_at      AS createdAt
       FROM transactions
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(sinceId, limit) as Transaction[]
}

// ------------------------------------------------------------------
// Sales Reports
// ------------------------------------------------------------------
export function getSalesReport(from: string, to: string): SalesReport {
  const db = getDB()
  if (!db) {
    return {
      totalSales: 0, totalRevenue: 0,
      coin1Sales: 0, coin2Sales: 0,
      coin1Revenue: 0, coin2Revenue: 0,
      periodStart: from, periodEnd: to
    }
  }
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                  AS totalSales,
         COALESCE(SUM(amount), 0)                  AS totalRevenue,
         COALESCE(SUM(CASE WHEN coin_selected=1 THEN 1 ELSE 0 END), 0) AS coin1Sales,
         COALESCE(SUM(CASE WHEN coin_selected=2 THEN 1 ELSE 0 END), 0) AS coin2Sales,
         COALESCE(SUM(CASE WHEN coin_selected=1 THEN amount ELSE 0 END), 0) AS coin1Revenue,
         COALESCE(SUM(CASE WHEN coin_selected=2 THEN amount ELSE 0 END), 0) AS coin2Revenue
       FROM transactions
       WHERE payment_result = 'approved'
         AND dispense_result = 'success'
         AND created_at BETWEEN ? AND ?`
    )
    .get(from, to) as {
    totalSales: number
    totalRevenue: number
    coin1Sales: number
    coin2Sales: number
    coin1Revenue: number
    coin2Revenue: number
  }

  return {
    ...row,
    periodStart: from,
    periodEnd: to
  }
}

// ------------------------------------------------------------------
// Hopper counts
// ------------------------------------------------------------------
export function getHopperCount(hopperId: 1 | 2): number {
  const db = getDB()
  if (!db) return 0
  const row = db
    .prepare('SELECT coin_count FROM hopper_counts WHERE hopper_id = ?')
    .get(hopperId) as { coin_count: number } | undefined
  return row?.coin_count ?? 0
}

export function setHopperCount(hopperId: 1 | 2, count: number): void {
  const db = getDB()
  if (!db) return
  db
    .prepare(
      `UPDATE hopper_counts
       SET coin_count = ?, updated_at = datetime('now','localtime')
       WHERE hopper_id = ?`
    )
    .run(count, hopperId)
}

// ------------------------------------------------------------------
// Hopper maintenance audit (empty / refill) — NOT customer sales
// ------------------------------------------------------------------
export function insertHopperEvent(e: Omit<HopperEvent, 'id' | 'createdAt'>): void {
  const db = getDB()
  if (!db) {
    console.log(`[hopper-event] ${e.type} hopper ${e.hopperId}: qty ${e.quantity}, ${e.oldStock}→${e.newStock} (not persisted — DB unavailable)`)
    return
  }
  db
    .prepare(
      `INSERT INTO hopper_events (hopper_id, type, quantity, old_stock, new_stock, reason, operator, operator_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.hopperId, e.type, e.quantity, e.oldStock, e.newStock, e.reason ?? null, e.operator ?? null, e.operatorRole ?? null)
}

export function getHopperEvents(limit = 100): HopperEvent[] {
  return queryHopperEvents('ORDER BY id DESC LIMIT ?', [limit])
}

/** Events newer than the given id (ascending) — for pushing to the fleet server. */
export function getHopperEventsSince(sinceId: number, limit = 200): HopperEvent[] {
  return queryHopperEvents('WHERE id > ? ORDER BY id ASC LIMIT ?', [sinceId, limit])
}

function queryHopperEvents(clause: string, params: unknown[]): HopperEvent[] {
  const db = getDB()
  if (!db) return []
  const rows = db
    .prepare(
      `SELECT id, hopper_id, type, quantity, old_stock, new_stock, reason, operator, operator_role, created_at
       FROM hopper_events ${clause}`
    )
    .all(...params) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    hopperId: r.hopper_id as 1 | 2,
    type: r.type as 'empty' | 'refill',
    quantity: r.quantity as number,
    oldStock: r.old_stock as number,
    newStock: r.new_stock as number,
    reason: (r.reason as string) ?? null,
    operator: (r.operator as string) ?? null,
    operatorRole: (r.operator_role as string) ?? null,
    createdAt: r.created_at as string
  }))
}

// ------------------------------------------------------------------
// Error logging
// ------------------------------------------------------------------
export function logError(
  level: 'warn' | 'error' | 'critical',
  category: string,
  message: string,
  context?: Record<string, unknown>
): void {
  const db = getDB()
  if (!db) {
    console.error(`[log:${level}] ${category}: ${message}`, context ?? '')
    return
  }
  db
    .prepare(
      `INSERT INTO error_log (level, category, message, context)
       VALUES (?, ?, ?, ?)`
    )
    .run(level, category, message, context ? JSON.stringify(context) : null)
}

// ------------------------------------------------------------------
// Unresolved "payment approved but no dispense" alerts
// ------------------------------------------------------------------
/** Mark a critical "approved but not dispensed" alert as resolved/reconciled. */
export function resolveAlert(transactionId: string): void {
  const db = getDB()
  if (!db) return
  db.prepare('UPDATE transactions SET alert_sent = 1 WHERE transaction_id = ?').run(transactionId)
}

export function getUnresolvedAlerts(): Transaction[] {
  const db = getDB()
  if (!db) return []
  return db
    .prepare(
      `SELECT id,
              transaction_id AS transactionId,
              amount,
              coin_selected  AS coinSelected,
              payment_result AS paymentResult,
              dispense_result AS dispenseResult,
              nayax_auth_code AS nayaxAuthCode,
              nayax_card_type AS nayaxCardType,
              alert_sent      AS alertSent,
              created_at      AS createdAt
       FROM transactions
       WHERE payment_result = 'approved'
         AND (dispense_result IS NULL OR dispense_result != 'success')
         AND alert_sent = 0`
    )
    .all() as Transaction[]
}
