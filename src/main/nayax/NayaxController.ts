/**
 * Nayax POS Terminal Controller
 *
 * PRODUCTION: the Nayax MDB cashless reader is driven through the Waferstar
 *   MDB-RS232 adapter (the adapter is the MDB master; we are the VMC). The
 *   adapter connects to the mini-PC over USB as a serial port (9600 8N1).
 *   Protocol/command bytes live in ./mdbCashless.ts.
 *
 *   Card-payment flow (per the MDB-RS232 manual):
 *     connect  → config (1100…) → set price range (1101FFFF0000) → enable (1401)
 *     sale     → wait for the reader's "begin session" (03…, customer taps card)
 *              → request vend (1300 price item) → wait "approved" (05…) / denied
 *     after dispensing:
 *              → confirmVend()  = vend success (1302) + session complete (1304)
 *              → cancelVend()   = vend cancel  (1301) + session complete (1304)   [refund]
 *
 * SIMULATION (dev / bench): all payment responses are controlled by the
 *   Hardware Simulator window over IPC — unchanged behaviour.
 *
 * ⚠ The production path follows the documented protocol but needs live
 *   bring-up calibration against the real reader (price scaling, reply framing,
 *   exact approval/denial codes). See ./mdbCashless.ts calibration notes.
 */

import { EventEmitter } from 'events'
import {
  CASHLESS,
  requestVend,
  vendSuccess,
  classifyReply,
  normaliseReply,
  toHex,
  type ReaderEvent
} from './mdbCashless'

export type PaymentResult = 'approved' | 'declined' | 'communication_error' | 'timeout'

export interface SaleResponse {
  result: PaymentResult
  transactionId?: string
  amount?: number
  authCode?: string
  cardType?: string
  timestamp: Date
}

interface SerialWritable {
  write(data: Buffer, cb: (err?: Error | null) => void): void
}

// ------------------------------------------------------------------
// Simulated state – set by simulator window via IPC
// ------------------------------------------------------------------
let simulatedNextResult: PaymentResult = 'approved'
let simulatedPendingResolve: ((r: SaleResponse) => void) | null = null
let simulatedTimer: ReturnType<typeof setTimeout> | null = null

function clearSimTimer(): void {
  if (simulatedTimer) {
    clearTimeout(simulatedTimer)
    simulatedTimer = null
  }
}

export function simSetPaymentResult(result: PaymentResult): void {
  simulatedNextResult = result
}

export function simTriggerPayment(): void {
  if (!simulatedPendingResolve) return

  const resolve = simulatedPendingResolve
  simulatedPendingResolve = null
  clearSimTimer()

  // The simulator UI keeps the selected response highlighted, so the result
  // is "sticky" — it stays on whatever was chosen until the user changes it.
  const result = simulatedNextResult

  resolve({
    result,
    timestamp: new Date(),
    transactionId: result === 'approved' ? `SIM-${Date.now()}` : undefined,
    authCode: result === 'approved' ? 'AUTH123' : undefined,
    cardType: result === 'approved' ? 'Contactless' : undefined
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------
// NayaxController
// ------------------------------------------------------------------
export class NayaxController extends EventEmitter {
  private serialPath: string | null
  private isSimulated: boolean
  private connected = false
  private saleInProgress = false

  // production serial + reader state
  private port: SerialWritable | null = null
  private inbox: { event: ReaderEvent; bytes: number[] }[] = []
  private waiter: { pred: (e: ReaderEvent) => boolean; resolve: (m: { event: ReaderEvent; bytes: number[] } | null) => void; timer: ReturnType<typeof setTimeout> } | null = null
  private sessionOpen = false

  // Timeout waiting for payment (ms)
  static readonly PAYMENT_TIMEOUT_MS = 120_000 // 2 minutes
  static readonly APPROVAL_TIMEOUT_MS = 60_000 // after a card is presented

  constructor(serialPath: string | null = null, simulated = true) {
    super()
    this.serialPath = serialPath
    this.isSimulated = simulated
  }

  async connect(): Promise<void> {
    if (this.isSimulated) {
      console.log('[Nayax] Running in simulation mode')
      this.connected = true
      return
    }

    // PRODUCTION: open the serial port to the Waferstar MDB-RS232 adapter.
    const { SerialPort } = await import('serialport')
    const port = new SerialPort({
      path: this.serialPath!,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    })

    await new Promise<void>((resolve, reject) => {
      port.on('open', () => resolve())
      port.on('error', (err) => {
        console.error('[Nayax] Serial error:', err.message)
        this.emit('error', { type: 'serial', message: err.message })
        reject(err)
      })
    })

    port.on('data', (d: Buffer) => this.onData(d))
    this.port = port
    this.connected = true
    console.log(`[Nayax] MDB-RS232 serial port ${this.serialPath} opened`)

    // Initialise the cashless reader: config → price range → enable.
    try {
      await this.sendCmd(CASHLESS.CONFIG)
      await delay(150)
      await this.sendCmd(CASHLESS.SET_PRICE_RANGE)
      await delay(150)
      await this.sendCmd(CASHLESS.ENABLE)
      console.log('[Nayax] card reader configured and enabled')
    } catch (e) {
      console.error('[Nayax] reader init failed:', (e as Error).message)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  isSaleInProgress(): boolean {
    return this.saleInProgress
  }

  // ------------------------------------------------------------------
  // Request a sale – resolves when the terminal responds
  // ------------------------------------------------------------------
  async requestSale(amountCents: number, timeoutMs?: number): Promise<SaleResponse> {
    if (!this.connected) {
      return { result: 'communication_error', timestamp: new Date() }
    }
    if (this.isSimulated) {
      return this.simulatedSale(amountCents, timeoutMs)
    }
    if (this.saleInProgress) {
      return { result: 'communication_error', timestamp: new Date() }
    }
    return this.productionSale(amountCents, timeoutMs)
  }

  private async productionSale(amountCents: number, timeoutMs?: number): Promise<SaleResponse> {
    this.saleInProgress = true
    this.inbox = [] // clear stale reader events before a new sale
    try {
      await this.sendCmd(CASHLESS.ENABLE)

      // 1. Wait for the customer to present a card (reader "begin session").
      const began = await this.waitFor(
        (e) => e === 'begin_session',
        timeoutMs && timeoutMs > 0 ? timeoutMs : NayaxController.PAYMENT_TIMEOUT_MS
      )
      if (!began) {
        await this.safe(() => this.sendCmd(CASHLESS.CANCEL_READER))
        return { result: 'timeout', timestamp: new Date() }
      }

      // 2. Ask the reader to authorise the price.
      await this.sendCmd(requestVend(amountCents, 1))

      // 3. Wait for approval / denial.
      const resp = await this.waitFor(
        (e) => e === 'approved' || e === 'denied' || e === 'ended',
        NayaxController.APPROVAL_TIMEOUT_MS
      )
      if (!resp) {
        await this.safe(() => this.cancelVend())
        return { result: 'timeout', timestamp: new Date() }
      }
      if (resp.event === 'approved') {
        this.sessionOpen = true // funds reserved; finalise with confirmVend/cancelVend
        return {
          result: 'approved',
          transactionId: `NAYAX-${Date.now()}`,
          amount: amountCents,
          cardType: 'Contactless',
          timestamp: new Date()
        }
      }
      // denied or session ended without approval
      await this.safe(() => this.endSession())
      return { result: 'declined', timestamp: new Date() }
    } catch (e) {
      console.error('[Nayax] sale error:', (e as Error).message)
      return { result: 'communication_error', timestamp: new Date() }
    } finally {
      this.saleInProgress = false
    }
  }

  /** Finalise an approved sale AFTER the coin was dispensed (captures the charge). */
  async confirmVend(item = 1): Promise<void> {
    if (this.isSimulated || !this.sessionOpen) return
    await this.safe(async () => {
      await this.sendCmd(vendSuccess(item))
      await delay(80)
      await this.sendCmd(CASHLESS.SESSION_COMPLETE)
    })
    this.sessionOpen = false
  }

  /** Cancel an approved sale because the coin could NOT be dispensed (refund). */
  async cancelVend(): Promise<void> {
    if (this.isSimulated || !this.sessionOpen) return
    await this.safe(async () => {
      await this.sendCmd(CASHLESS.VEND_CANCEL)
      await delay(80)
      await this.sendCmd(CASHLESS.SESSION_COMPLETE)
    })
    this.sessionOpen = false
  }

  // ------------------------------------------------------------------
  // Cancel / reset an in-progress sale (customer walked away / timeout).
  // ------------------------------------------------------------------
  async cancelSale(): Promise<boolean> {
    if (this.isSimulated) {
      if (simulatedPendingResolve) {
        const resolve = simulatedPendingResolve
        simulatedPendingResolve = null
        clearSimTimer()
        resolve({ result: 'declined', timestamp: new Date() })
        console.log('[Nayax] CANCEL/reset sent — terminal returned to idle (simulated, acknowledged)')
      } else {
        console.log('[Nayax] CANCEL/reset requested — no active sale, terminal already idle')
      }
      this.saleInProgress = false
      return true
    }
    // PRODUCTION: cancel any vend and close the session so the reader goes idle.
    await this.safe(async () => {
      await this.sendCmd(CASHLESS.VEND_CANCEL)
      await delay(80)
      await this.sendCmd(CASHLESS.SESSION_COMPLETE)
      await delay(80)
      await this.sendCmd(CASHLESS.CANCEL_READER)
    })
    this.sessionOpen = false
    this.saleInProgress = false
    console.log('[Nayax] CANCEL/reset sent to reader')
    return true
  }

  // ------------------------------------------------------------------
  // Production serial helpers
  // ------------------------------------------------------------------
  private onData(buf: Buffer): void {
    const bytes = normaliseReply(buf)
    if (bytes.length === 0) return
    const event = classifyReply(bytes)
    console.log(`[Nayax] RX ${toHex(bytes)} (${event})`)
    this.inbox.push({ event, bytes })
    if (this.inbox.length > 30) this.inbox.shift()
    this.flushWaiter()
  }

  private flushWaiter(): void {
    if (!this.waiter) return
    const i = this.inbox.findIndex((m) => this.waiter!.pred(m.event))
    if (i >= 0) {
      const [m] = this.inbox.splice(i, 1)
      const w = this.waiter
      this.waiter = null
      clearTimeout(w.timer)
      w.resolve(m)
    }
  }

  private waitFor(
    pred: (e: ReaderEvent) => boolean,
    timeoutMs: number
  ): Promise<{ event: ReaderEvent; bytes: number[] } | null> {
    const i = this.inbox.findIndex((m) => pred(m.event))
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0])
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.resolve === resolve) this.waiter = null
        resolve(null)
      }, timeoutMs)
      this.waiter = { pred, resolve, timer }
    })
  }

  private async sendCmd(bytes: readonly number[]): Promise<void> {
    if (!this.port) throw new Error('Nayax serial port not open')
    console.log(`[Nayax] TX ${toHex(bytes)}`)
    await new Promise<void>((resolve, reject) =>
      this.port!.write(Buffer.from([...bytes]), (err) => (err ? reject(err) : resolve()))
    )
  }

  private async endSession(): Promise<void> {
    await this.sendCmd(CASHLESS.SESSION_COMPLETE)
    this.sessionOpen = false
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (e) {
      console.error('[Nayax] command failed:', (e as Error).message)
    }
  }

  // ------------------------------------------------------------------
  // Simulated sale
  // ------------------------------------------------------------------
  private simulatedSale(_amountCents: number, timeoutMs?: number): Promise<SaleResponse> {
    if (simulatedPendingResolve) {
      const stale = simulatedPendingResolve
      simulatedPendingResolve = null
      clearSimTimer()
      stale({ result: 'timeout', timestamp: new Date() })
    }

    return new Promise((resolve) => {
      simulatedPendingResolve = resolve
      clearSimTimer()
      simulatedTimer = setTimeout(
        () => {
          if (simulatedPendingResolve === resolve) {
            simulatedPendingResolve = null
            simulatedTimer = null
            console.log('[Nayax] sale timed out — no card presented, terminal reset to idle')
            resolve({ result: 'timeout', timestamp: new Date() })
          }
        },
        timeoutMs && timeoutMs > 0 ? timeoutMs : NayaxController.PAYMENT_TIMEOUT_MS
      )
    })
  }
}
