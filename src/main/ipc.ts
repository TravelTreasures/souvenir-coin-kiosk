/**
 * IPC Handlers
 * Wires the renderer (React UI) and simulator window to the
 * MDB controller, Nayax controller, and database layer.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { HopperController, simSetHopperStatus, simSetHopperCoinCount } from './hopper/HopperController'
import {
  NayaxController,
  simSetPaymentResult,
  simTriggerPayment
} from './nayax/NayaxController'
import {
  insertTransaction,
  updateDispenseResult,
  getTransactions,
  getSalesReport,
  setHopperCount,
  insertHopperEvent,
  getHopperEvents,
  logError,
  getUnresolvedAlerts,
  resolveAlert
} from './database/Database'
import { getPriceCents, setPriceCents, getConfig, updateConfig, getAdminPin, verifyAdminPin, changeAdminPin, getTransactionTimeoutSeconds, setTransactionTimeoutSeconds, getCoinsEnabled, getOperators } from './config/Config'
import type { OperatorRole } from './config/Config'
import { startFleetSync, stopFleetSync } from './fleet/FleetSync'
import { v4 as uuidv4 } from 'uuid'

// Set while a purchase is being processed (payment + dispense). The OTA updater
// reads this so it never installs an update mid-sale — updates only run when the
// kiosk is idle on the Home screen.
let saleInProgress = false
export function isSaleInProgress(): boolean {
  return saleInProgress
}

// ------------------------------------------------------------------
// Setup – call once from main/index.ts
// ------------------------------------------------------------------
export function setupIPC(mdb: HopperController, nayax: NayaxController): void {
  // The operator authenticated on the Admin panel (via PIN). Held here so
  // maintenance actions are automatically stamped with who did them + their role.
  let currentOperator: { name: string; role: OperatorRole } | null = null
  const activeOperator = (): { name: string; role: OperatorRole } => currentOperator ?? { name: 'Admin', role: 'office' }
  const canMaintain = (): boolean => ['operator', 'office'].includes(activeOperator().role)
  const canConfig = (): boolean => activeOperator().role === 'office'

  // ----------------------------------------------------------------
  // Payment
  // ----------------------------------------------------------------
  ipcMain.handle('payment:request', async (_event, coinSelected: 1 | 2) => {
    saleInProgress = true
    try {
    const priceCents = getPriceCents()
    const hopperAddress =
      coinSelected === 1 ? HopperController.HOPPER_1_ADDR : HopperController.HOPPER_2_ADDR

    // STOCK CHECK BEFORE PAYMENT: never charge a card for an empty hopper.
    // If the selected coin is out of stock, stop here and ask the customer to
    // choose another — no Nayax transaction is initiated.
    if (mdb.getCoinCount(hopperAddress) <= 0) {
      logError('warn', 'dispense', 'Coin unavailable — hopper empty; payment not initiated', { coinSelected })
      return { status: 'out_of_stock', errorCode: 'HOPPER_EMPTY' }
    }

    try {
      const timeoutMs = getTransactionTimeoutSeconds() * 1000
      const saleResponse = await nayax.requestSale(priceCents, timeoutMs)

      if (saleResponse.result === 'approved') {
        // Generate a local transaction ID if Nayax didn't provide one
        const transactionId = saleResponse.transactionId ?? `LOCAL-${uuidv4()}`

        // Record the approved payment immediately
        insertTransaction({
          transactionId,
          amount: priceCents,
          coinSelected,
          paymentResult: 'approved',
          dispenseResult: null,           // will update after dispense attempt
          nayaxAuthCode: saleResponse.authCode ?? null,
          nayaxCardType: saleResponse.cardType ?? null,
          alertSent: 0
        })

        // Attempt to dispense (stock was already verified above).
        const dispenseResult = await mdb.dispense(hopperAddress, 1)

        if (dispenseResult.success) {
          updateDispenseResult(transactionId, 'success')
          // Sync coin count to DB
          const newCount = mdb.getCoinCount(hopperAddress)
          setHopperCount(coinSelected, newCount)
          // Coin delivered — finalise the card charge (vend success + session end).
          await nayax.confirmVend().catch(() => undefined)
          return { status: 'dispensed', transactionId }
        } else {
          // Payment taken but dispense failed – CRITICAL
          const errorCode = dispenseResult.error ?? 'unknown_error'
          const COMM_FAILURES = [
            'CCTALK_COMM_FAILURE',
            'HOPPER_COMM_FAILURE',
            'HOPPER_OFFLINE',
            'HOPPER_NOT_CONNECTED',
            'HOPPER_NOT_INITIALISED'
          ]
          const dispenseCode =
            errorCode === 'HOPPER_EMPTY'
              ? 'empty'
              : errorCode === 'HOPPER_JAM'
                ? 'jam'
                : COMM_FAILURES.includes(errorCode)
                  ? 'comm_failure'
                  : 'unknown_error'

          updateDispenseResult(transactionId, dispenseCode, 0)
          logError('critical', 'dispense', 'Payment approved but coin not dispensed', {
            transactionId,
            coinSelected,
            error: errorCode
          })

          // Coin was NOT delivered — cancel the vend so the card is not charged
          // (reader refund), instead of capturing money for nothing.
          await nayax.cancelVend().catch(() => undefined)

          return { status: 'dispense_failed', errorCode, transactionId }
        }
      } else if (saleResponse.result === 'declined') {
        // Declined or cancelled by the customer. Record it, reset the terminal
        // so it leaves the failed-payment state, and return the kiosk to idle.
        insertTransaction({
          transactionId: saleResponse.transactionId ?? `DECLINED-${uuidv4()}`,
          amount: priceCents,
          coinSelected,
          paymentResult: 'declined',
          dispenseResult: null,
          nayaxAuthCode: null,
          nayaxCardType: null,
          alertSent: 0
        })
        const ack = await nayax.cancelSale()
        logError('warn', 'nayax', `Payment declined/cancelled — transaction reset, terminal cancel ${ack ? 'acknowledged' : 'sent (ack pending SDK)'}, returning to idle`, { coinSelected })
        return { status: 'declined' }
      } else if (saleResponse.result === 'timeout') {
        // Customer never presented a card (walked away). No payment was taken,
        // so we don't record a sale — just reset the terminal and return to idle.
        await nayax.cancelSale()
        logError('warn', 'nayax', 'Payment timed out — no card presented; transaction cancelled, terminal reset to idle', { coinSelected })
        return { status: 'timeout' }
      } else {
        // communication_error — record it, reset the terminal, return to idle.
        insertTransaction({
          transactionId: `COMMERR-${uuidv4()}`,
          amount: priceCents,
          coinSelected,
          paymentResult: 'communication_error',
          dispenseResult: null,
          nayaxAuthCode: null,
          nayaxCardType: null,
          alertSent: 0
        })
        const ack = await nayax.cancelSale()
        logError('warn', 'nayax', `Payment communication error — transaction reset, terminal cancel ${ack ? 'acknowledged' : 'sent (ack pending SDK)'}, returning to idle`, { coinSelected })
        return { status: 'communication_error' }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logError('error', 'nayax', 'Unexpected payment error', { message: msg })
      // Make sure the terminal is reset to idle even on an unexpected failure.
      try { await nayax.cancelSale() } catch { /* ignore */ }
      return { status: 'communication_error' }
    }
    } finally {
      saleInProgress = false
    }
  })

  ipcMain.handle('payment:cancel', async () => {
    await nayax.cancelSale()
    return { ok: true }
  })

  // Customer walked away at product selection / payment before completing.
  // Cancel/reset the Nayax terminal and log it so nothing stays pending.
  ipcMain.handle('payment:abandon', async (_event, reason = 'timeout') => {
    const ack = await nayax.cancelSale()
    logError('warn', 'nayax', `Transaction abandoned (${reason}) — Nayax cancel ${ack ? 'acknowledged' : 'not acknowledged (production SDK pending)'}, kiosk reset to idle`, { reason })
    console.log(`[payment] abandoned (${reason}) — Nayax reset, ack=${ack}`)
    return { ok: true, ack }
  })

  // ----------------------------------------------------------------
  // MDB / Hopper
  // ----------------------------------------------------------------
  ipcMain.handle('mdb:status', async (_event, address: number) => {
    return mdb.getHopperStatus(address)
  })

  ipcMain.handle('mdb:isConnected', () => mdb.isConnected())

  // ----------------------------------------------------------------
  // Admin – hopper counts
  // ----------------------------------------------------------------
  // Read the live MDB controller counts — the SAME source reported to the Fleet
  // Admin in the heartbeat — so the kiosk's Admin panel and the dashboard always
  // show identical hopper numbers.
  ipcMain.handle('admin:getHopperCounts', () => {
    return {
      hopper1: mdb.getCoinCount(HopperController.HOPPER_1_ADDR),
      hopper2: mdb.getCoinCount(HopperController.HOPPER_2_ADDR)
    }
  })

  ipcMain.handle('admin:setHopperCount', (_event, hopperId: 1 | 2, count: number) => {
    if (!canMaintain()) return { ok: false, error: 'Your role cannot perform maintenance.' }
    setHopperCount(hopperId, count)
    const address = hopperId === 1 ? HopperController.HOPPER_1_ADDR : HopperController.HOPPER_2_ADDR
    simSetHopperCoinCount(address, count)
    return { ok: true }
  })

  // ----------------------------------------------------------------
  // Hopper maintenance: empty (non-sale dispense), refill, audit history
  // ----------------------------------------------------------------
  // Empty a hopper by dispensing tokens. This is MAINTENANCE, not a sale:
  // it never records a transaction or affects sales/revenue totals.
  ipcMain.handle('maintenance:emptyHopper', async (_event, hopperId: 1 | 2, quantity: number | 'all') => {
    if (!canMaintain()) return { ok: false, error: 'Your role cannot perform maintenance.' }
    const op = activeOperator()
    const address = hopperId === 1 ? HopperController.HOPPER_1_ADDR : HopperController.HOPPER_2_ADDR
    const before = mdb.getCoinCount(address)
    const want = quantity === 'all' ? before : Math.max(0, Math.min(Math.round(Number(quantity)), 5, before))
    let dispensed = 0
    if (want > 0) {
      const r = await mdb.dispense(address, want)
      dispensed = r.success ? (r.coinsDispensed ?? want) : 0
    }
    const after = mdb.getCoinCount(address)
    setHopperCount(hopperId, after)
    insertHopperEvent({ hopperId, type: 'empty', quantity: dispensed, oldStock: before, newStock: after, reason: 'Hopper empty for refill', operator: op.name, operatorRole: op.role })
    console.log(`[maintenance] ${op.name} (${op.role}) emptied hopper ${hopperId}: dispensed ${dispensed}, ${before}→${after}`)
    return { ok: true, dispensed, oldStock: before, newStock: after }
  })

  // Refill: operator enters how many tokens they loaded; stock becomes old + added.
  ipcMain.handle('maintenance:refillHopper', (_event, hopperId: 1 | 2, tokensAdded: number) => {
    if (!canMaintain()) return { ok: false, error: 'Your role cannot perform maintenance.' }
    const op = activeOperator()
    const address = hopperId === 1 ? HopperController.HOPPER_1_ADDR : HopperController.HOPPER_2_ADDR
    const before = mdb.getCoinCount(address)
    const added = Math.max(0, Math.round(Number(tokensAdded)))
    const after = before + added
    simSetHopperCoinCount(address, after)
    setHopperCount(hopperId, after)
    insertHopperEvent({ hopperId, type: 'refill', quantity: added, oldStock: before, newStock: after, reason: 'Refill', operator: op.name, operatorRole: op.role })
    console.log(`[maintenance] ${op.name} (${op.role}) refilled hopper ${hopperId}: +${added}, ${before}→${after}`)
    return { ok: true, oldStock: before, added, newStock: after }
  })

  ipcMain.handle('maintenance:getHopperEvents', () => getHopperEvents(100))

  // ----------------------------------------------------------------
  // Admin – reports & logs
  // ----------------------------------------------------------------
  ipcMain.handle('admin:getTransactions', (_event, limit = 200, offset = 0) => {
    return getTransactions(limit, offset)
  })

  ipcMain.handle(
    'admin:getSalesReport',
    (_event, period: 'today' | 'week' | 'month' | 'all') => {
      // Transactions are stored with datetime('now','localtime'), so the
      // report bounds must also be in LOCAL time (not UTC) to match.
      const pad = (n: number): string => String(n).padStart(2, '0')
      const toLocalSql = (d: Date): string =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

      const now = new Date()
      const to = toLocalSql(now)
      let from: string

      if (period === 'today') {
        const start = new Date(now)
        start.setHours(0, 0, 0, 0)
        from = toLocalSql(start)
      } else if (period === 'week') {
        const start = new Date(now)
        start.setDate(start.getDate() - 7)
        from = toLocalSql(start)
      } else if (period === 'month') {
        const start = new Date(now)
        start.setMonth(start.getMonth() - 1)
        from = toLocalSql(start)
      } else {
        from = '1970-01-01 00:00:00'
      }

      return getSalesReport(from, to)
    }
  )

  // ----------------------------------------------------------------
  // Config (coin price)
  // ----------------------------------------------------------------
  ipcMain.handle('config:get', () => getConfig())

  ipcMain.handle('config:setPrice', (_event, cents: number) => {
    if (!canConfig()) return { ok: false, error: 'Only Office role can change configuration.' }
    return setPriceCents(cents)
  })

  // Inactivity timeout (seconds) before the kiosk auto-cancels and returns to idle.
  ipcMain.handle('config:getTransactionTimeout', () => getTransactionTimeoutSeconds())
  ipcMain.handle('config:setTransactionTimeout', (_event, seconds: number) => {
    if (!canConfig()) return { ok: false, error: 'Only Office role can change configuration.' }
    setTransactionTimeoutSeconds(seconds)
    return { ok: true, seconds: getTransactionTimeoutSeconds() }
  })

  // Which coins are available (pushed from the fleet server). Default both.
  ipcMain.handle('config:getCoinsEnabled', () => getCoinsEnabled())

  // Remote coin images (data URLs) downloaded from the fleet server, or null
  // per slot to use the bundled default.
  ipcMain.handle('config:getCoinImages', () => {
    const imgs = getConfig().coinImages || {}
    return { 1: imgs['1'] ?? null, 2: imgs['2'] ?? null }
  })

  // Promotional banner pushed from the fleet server.
  ipcMain.handle('config:getPromo', () => {
    const c = getConfig()
    return { text: c.promoText ?? '', enabled: !!c.promoEnabled }
  })

  // QR code config for the home screen.
  ipcMain.handle('config:getQR', () => {
    const c = getConfig()
    return { enabled: !!c.qrEnabled, url: c.qrUrl ?? '', caption: c.qrCaption ?? '' }
  })

  // Marketing slideshow config + images (data URLs).
  ipcMain.handle('config:getMarketing', () => {
    const c = getConfig()
    const m = c.marketing || { enabled: false, slideSeconds: 10, idleSeconds: 60, activeStart: '', activeEnd: '' }
    const result = { ...m, images: c.marketingImages || [] }
    return result
  })

  // ----------------------------------------------------------------
  // Fleet sync settings
  // ----------------------------------------------------------------
  ipcMain.handle('fleet:get', () => {
    const c = getConfig()
    return {
      kioskId: c.kioskId ?? '',
      fleetUrl: c.fleetUrl ?? '',
      fleetApiKey: c.fleetApiKey ?? '',
      appliedConfigVersion: c.appliedConfigVersion,
      lastSyncedTxId: c.lastSyncedTxId,
      enabled: !!(c.fleetUrl && c.fleetApiKey),
      status: c.fleetStatus ?? null
    }
  })

  ipcMain.handle('fleet:set', (_event, s: { kioskId?: string; fleetUrl?: string; fleetApiKey?: string }) => {
    if (!canConfig()) return { ok: false, error: 'Only Office role can change configuration.' }
    updateConfig({ kioskId: s.kioskId, fleetUrl: s.fleetUrl, fleetApiKey: s.fleetApiKey })
    // Restart the sync client so new settings take effect immediately.
    stopFleetSync()
    startFleetSync(mdb, nayax)
    return { ok: true }
  })

  // ----------------------------------------------------------------
  // Admin PIN (unlocks the on-screen Admin panel)
  // ----------------------------------------------------------------
  // Length only — the PIN itself never leaves the main process.
  ipcMain.handle('admin:getPinLength', () => getAdminPin().length)

  // PIN verification with a brute-force lockout. State lives in the main
  // process (resets on app restart) so it can't be bypassed by the UI.
  // A PIN can be the device Admin PIN (→ full "Office" access, offline master)
  // or an operator's PIN synced from the fleet (→ that operator + their role).
  // The authenticated operator is held here and stamped on maintenance actions.
  const PIN_MAX_ATTEMPTS = 5
  const PIN_LOCK_MS = 30_000
  let pinFails = 0
  let pinLockedUntil = 0

  ipcMain.handle('admin:verifyPin', (_event, pin: string) => {
    const now = Date.now()
    if (now < pinLockedUntil) {
      return { ok: false, locked: true, retryInMs: pinLockedUntil - now }
    }
    const entered = String(pin ?? '')
    // Device Admin PIN → Office (master / offline fallback).
    if (verifyAdminPin(entered)) {
      pinFails = 0
      currentOperator = { name: 'Admin', role: 'office' }
      return { ok: true, operator: currentOperator }
    }
    // Operator PIN synced from the fleet.
    const op = getOperators().find((o) => o.pin === entered)
    if (op) {
      pinFails = 0
      currentOperator = { name: op.name, role: op.role }
      return { ok: true, operator: currentOperator }
    }
    pinFails++
    if (pinFails >= PIN_MAX_ATTEMPTS) {
      pinFails = 0
      pinLockedUntil = now + PIN_LOCK_MS
      return { ok: false, locked: true, retryInMs: PIN_LOCK_MS }
    }
    return { ok: false, locked: false, remaining: PIN_MAX_ATTEMPTS - pinFails }
  })

  // Who is currently signed in on the Admin panel (null if none).
  ipcMain.handle('admin:getOperator', () => currentOperator)
  // Clear the session when the panel closes.
  ipcMain.handle('admin:signOut', () => { currentOperator = null; return { ok: true } })
  ipcMain.handle('admin:setPin', (_event, current: string, next: string) => {
    if (!canConfig()) return { ok: false, error: 'Only Office role can change configuration.' }
    return changeAdminPin(String(current ?? ''), String(next ?? ''))
  })

  ipcMain.handle('admin:getAlerts', () => getUnresolvedAlerts())

  ipcMain.handle('admin:resolveAlert', (_event, transactionId: string) => {
    resolveAlert(transactionId)
    return { ok: true }
  })

  // ----------------------------------------------------------------
  // System status
  // ----------------------------------------------------------------
  ipcMain.handle('system:getStatus', async () => {
    const [h1, h2] = await Promise.all([
      mdb.getHopperStatus(HopperController.HOPPER_1_ADDR),
      mdb.getHopperStatus(HopperController.HOPPER_2_ADDR)
    ])
    return {
      mdbConnected: mdb.isConnected(),
      nayaxConnected: nayax.isConnected(),
      hopper1: h1,
      hopper2: h2
    }
  })

  // ----------------------------------------------------------------
  // Simulator IPC (only active in dev)
  // ----------------------------------------------------------------
  ipcMain.on('sim:setPaymentResult', (_event, result: string) => {
    simSetPaymentResult(result as 'approved' | 'declined' | 'communication_error')
  })

  ipcMain.on('sim:triggerPayment', () => {
    simTriggerPayment()
  })

  ipcMain.on('sim:setHopperStatus', (_event, address: number, status: string) => {
    simSetHopperStatus(address, status as 'ok' | 'empty' | 'jam' | 'offline')
  })

  ipcMain.on('sim:setHopperCoinCount', (_event, address: number, count: number) => {
    simSetHopperCoinCount(address, count)
  })

  // Forward hopper events from MDB controller to all renderer windows
  mdb.on('hopper:status', (data) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('hopper:status', data)
    })
  })
}
