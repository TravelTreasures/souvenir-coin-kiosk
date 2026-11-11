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
  parseAsciiHexLine,
  toHex,
  type ReaderEvent
} from './mdbCashless'
import { recordNayax } from './nayaxLog'

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
  private rxText = '' // accumulates ASCII reply text until a CR/LF line terminator
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
        // Don't emit 'error' (nothing listens → Node would abort startup). Log,
        // mark offline, and reject; index.ts catches it and the app continues
        // with the card reader simply shown as offline.
        console.error('[Nayax] Serial error:', err.message)
        this.connected = false
        reject(err)
      })
    })

    port.on('data', (d: Buffer) => this.onData(d))
    this.port = port
    this.connected = true
    console.log(`[Nayax] MDB-RS232 serial port ${this.serialPath} opened`)

    // Initialise the cashless reader: RESET → config → price range → enable.
    // The RESET (soft power-cycle) FIRST is important: if the reader is stuck in
    // a hung "Thank You"/session state from before, a plain reboot that only
    // re-sent config/enable would NOT clear it (only cutting its power would).
    // Resetting here lets a normal reboot recover a hung reader.
    try {
      await this.sendCmd(CASHLESS.RESET)
      await delay(400) // let the reader fully reset before we re-configure it
      await this.sendCmd(CASHLESS.CONFIG) // declare VMC feature level 3
      await delay(200)
      await this.sendCmd(CASHLESS.SET_PRICE_RANGE)
      await delay(200)
      // Put the reader into ALWAYS IDLE mode: no touch-screen "start button"
      // session — the customer selects the coin on OUR screen, we send the vend
      // request, and the reader waits for the tap. This removes the stray
      // "Product not chosen" hang at the protocol level.
      // NOTE: the 17 04 "Always Idle" request is ACKed by the MDB-RS232 box but the
      // Nayax reader only honours selection-first / always-idle when its OWN Nayax
      // terminal profile is set that way (a Nayax-side config). We still send it; it
      // is harmless when unsupported.
      await this.sendCmd(CASHLESS.ALWAYS_IDLE)
      await delay(300)
      await this.sendCmd(CASHLESS.ENABLE)
      console.log('[Nayax] card reader reset, configured (level 3), enabled')
      recordNayax({ dir: 'INFO', note: 'CONNECT done — reader configured + ENABLED' })
    } catch (e) {
      console.error('[Nayax] reader init failed:', (e as Error).message)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  /** Which serial port this controller uses (see hardware/portDetect.ts). */
  getSerialPath(): string | null {
    return this.serialPath
  }
  setSerialPath(path: string): void {
    this.serialPath = path
  }

  /** Close the serial port (used when the port assignment is re-detected). */
  async disconnect(): Promise<void> {
    if (this.isSimulated) return
    const port = this.port as unknown as { isOpen?: boolean; close?: (cb?: () => void) => void } | null
    this.port = null
    this.connected = false
    this.sessionOpen = false
    this.rxText = ''
    this.inbox = []
    if (port?.close && port.isOpen) await new Promise<void>((r) => port.close!(() => r()))
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
    this.saleInProgress = true // set FIRST so a tap during this sale isn't treated as stray
    recordNayax({ dir: 'INFO', note: `SALE START — coin selected on screen, requesting vend R${(amountCents / 100).toFixed(2)}` })
    try {
      // If a premature-tap (stray) session is still being dismissed, wait for it to
      // finish and let the reader settle, so our vend opens a CLEAN session instead
      // of colliding with the one that's still closing — the collision is what let a
      // tap "go through" into a charge on the 2nd/3rd attempt.
      const settleStart = Date.now()
      while (this.cancellingStray && Date.now() - settleStart < 2500) await delay(50)
      await delay(120)
      this.inbox = []
      // The customer chose the coin on OUR screen; send the vend request. The
      // reader prompts the card tap and approves. (With Always Idle configured on
      // the reader's Nayax profile, this is the clean selection-first flow.)
      await this.sendCmd(requestVend(amountCents, 1))

      // Wait for the customer to tap and the reader to approve / deny / end.
      const resp = await this.waitFor(
        (e) => e === 'approved' || e === 'denied' || e === 'ended',
        timeoutMs && timeoutMs > 0 ? timeoutMs : NayaxController.PAYMENT_TIMEOUT_MS
      )
      if (!resp) {
        // No tap in time — cancel the pending vend and return the reader to idle
        // (still enabled / always-idle, NOT disabled).
        recordNayax({ dir: 'INFO', note: 'TIMEOUT — no card tap in time, aborting vend' })
        await this.safe(() => this.abortVend())
        return { result: 'timeout', timestamp: new Date() }
      }
      if (resp.event === 'approved') {
        this.sessionOpen = true // funds reserved; finalise with confirmVend/cancelVend
        recordNayax({ dir: 'INFO', note: 'APPROVED — funds reserved, awaiting dispense result' })
        return {
          result: 'approved',
          transactionId: `NAYAX-${Date.now()}`,
          amount: amountCents,
          cardType: 'Contactless',
          timestamp: new Date()
        }
      }
      // denied or session ended without approval
      recordNayax({ dir: 'INFO', note: `DECLINED/ENDED (reader sent "${resp.event}") — closing session` })
      await this.safe(() => this.endSession())
      return { result: 'declined', timestamp: new Date() }
    } catch (e) {
      console.error('[Nayax] sale error:', (e as Error).message)
      return { result: 'communication_error', timestamp: new Date() }
    } finally {
      this.saleInProgress = false
    }
  }

  /** Abort a pending vend (no card was tapped) and return the reader to idle,
   *  keeping it enabled in always-idle mode — never disabled (no "out of order"). */
  private async abortVend(): Promise<void> {
    await this.safe(async () => {
      await this.sendCmd(CASHLESS.VEND_CANCEL)
      await delay(80)
      await this.sendCmd(CASHLESS.SESSION_COMPLETE)
      recordNayax({ dir: 'INFO', note: 'Vend aborted — reader back to ready' })
    })
    this.sessionOpen = false
  }

  /** Finalise an approved sale AFTER the coin was dispensed (captures the charge). */
  async confirmVend(item = 1): Promise<void> {
    if (this.isSimulated || !this.sessionOpen) return
    await this.safe(async () => {
      // Capture the charge, then WAIT for the reader to acknowledge it before
      // closing the session. Firing session-complete too early (before the
      // reader has processed vend-success) leaves it hung on "Thank You" with no
      // "ended" reply — the intermittent hang we were chasing.
      this.inbox = []
      await this.sendCmd(vendSuccess(item))
      await this.waitFor((e) => e === 'ack' || e === 'ended', 2500)
      this.inbox = []
      await this.sendCmd(CASHLESS.SESSION_COMPLETE)
      // Wait for the reader to confirm it closed the session. Leave it ENABLED so it
      // returns to the ready screen, not "out of order".
      await this.waitFor((e) => e === 'ended' || e === 'ack', 3000)
      recordNayax({ dir: 'INFO', note: 'Sale captured — reader back to ready' })
    })
    this.sessionOpen = false
  }

  /** Cancel an approved sale because the coin could NOT be dispensed (refund). */
  async cancelVend(): Promise<void> {
    if (this.isSimulated || !this.sessionOpen) return
    await this.safe(async () => {
      // The card was APPROVED but the coin could not be delivered. Tell the
      // reader with VEND FAILURE (13 03), the MDB command that means "approved
      // vend not delivered — refund". (This used to send VEND CANCEL, 13 01,
      // which the standard only allows BEFORE approval, so the reader was never
      // told explicitly that the vend had failed.)
      this.inbox = []
      await this.sendCmd(CASHLESS.VEND_FAILURE)
      const reply = await this.waitFor((e) => e === 'ack' || e === 'ended', 2500)
      this.inbox = []
      await this.sendCmd(CASHLESS.SESSION_COMPLETE)
      await this.waitFor((e) => e === 'ended' || e === 'ack', 3000)
      // Say exactly what the reader answered, so the Nayax Log shows whether the
      // refund instruction was acknowledged — never just assume it was.
      recordNayax({
        dir: 'INFO',
        note: reply
          ? `DISPENSE FAILED — vend failure (refund) sent, reader acknowledged (${reply.event})`
          : 'DISPENSE FAILED — vend failure (refund) sent, NO acknowledgement from reader — check this sale in Nayax'
      })
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
    // PRODUCTION: cancel any vend and close the session so the reader returns to
    // the ready screen (stays ENABLED). Do NOT send CANCEL_READER (14 02).
    await this.safe(async () => {
      await this.sendCmd(CASHLESS.VEND_CANCEL)
      await delay(80)
      await this.sendCmd(CASHLESS.SESSION_COMPLETE)
    })
    this.sessionOpen = false
    this.saleInProgress = false
    recordNayax({ dir: 'INFO', note: 'Sale cancelled/reset — reader back to ready' })
    console.log('[Nayax] CANCEL/reset sent to reader (vend-cancel + session-complete)')
    return true
  }

  // ------------------------------------------------------------------
  // Production serial helpers
  // ------------------------------------------------------------------
  private onData(buf: Buffer): void {
    // The Waferstar MDB-RS232 replies in ASCII text (hex pairs + spaces,
    // terminated by CR/LF). A single MDB reply can be split across several serial
    // reads, so accumulate and only process whole CR/LF-terminated lines.
    this.rxText += buf.toString('ascii')
    let nl: number
    while ((nl = this.rxText.search(/[\r\n]/)) >= 0) {
      const line = this.rxText.slice(0, nl)
      this.rxText = this.rxText.slice(nl + 1)
      const bytes = parseAsciiHexLine(line)
      if (bytes.length === 0) continue
      const event = classifyReply(bytes)
      console.log(`[Nayax] RX ${toHex(bytes)} (${event})`)
      recordNayax({ dir: 'RX', hex: toHex(bytes), event })
      this.inbox.push({ event, bytes })
      if (this.inbox.length > 30) this.inbox.shift()
      this.flushWaiter()
      // Safety net: a card tapped when NO sale is active (a stray tap, e.g. right
      // after a sale) opens a session the VMC will never vend into — the reader
      // then sits stuck on "Product not chosen". Cancel it at once and disable the
      // reader so it returns to idle instead of hanging.
      if (event === 'begin_session' && !this.saleInProgress) {
        void this.cancelStraySession()
      }
    }
    // Guard against an unterminated run of junk growing unbounded.
    if (this.rxText.length > 4096) this.rxText = this.rxText.slice(-512)
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
    recordNayax({ dir: 'TX', hex: toHex(bytes) })
    await new Promise<void>((resolve, reject) =>
      this.port!.write(Buffer.from([...bytes]), (err) => (err ? reject(err) : resolve()))
    )
  }

  private async endSession(): Promise<void> {
    await this.safe(() => this.sendCmd(CASHLESS.SESSION_COMPLETE))
    this.sessionOpen = false
  }

  // ------------------------------------------------------------------
  // A card was tapped when NO sale is active (stray tap). Close the empty
  // session the reader just opened and re-arm it (leave it ENABLED/ready), so
  // it returns to the idle "ready" screen instead of hanging on "Product not
  // chosen" — and WITHOUT disabling it (a disabled reader shows "Cashless out
  // of order"). Debounced so a burst of begin_session lines can't stack up.
  // ------------------------------------------------------------------
  private cancellingStray = false
  private strayPending = false
  private async cancelStraySession(): Promise<void> {
    if (this.saleInProgress) return
    // If a cancel is already running, flag that ANOTHER stray arrived so the loop
    // below re-runs for it. This is what stops rapid, repeated push-starts from
    // slipping a session through to "please select the product": every stray that
    // lands mid-cancel gets its own close, never dropped.
    if (this.cancellingStray) { this.strayPending = true; return }
    this.cancellingStray = true
    console.log('[Nayax] stray session (start button / early tap) — closing with session-complete')
    recordNayax({ dir: 'INFO', note: 'STRAY SESSION detected (reader start-button / early tap, no sale active) — closing with session-complete' })
    do {
      this.strayPending = false
      await this.safe(async () => {
        // The reader opened a bare session (no vend requested). The ONLY valid way
        // to dismiss it is SESSION_COMPLETE (13 04) — NOT vend-cancel (13 01), which
        // is out-of-sequence here. Session-complete makes the reader reply End
        // Session (10 07) and return to idle, still enabled.
        await this.sendCmd(CASHLESS.SESSION_COMPLETE)
        await this.waitFor((e) => e === 'ended', 2000)
        // Re-enable so the reader returns to the ready screen (not "out of order").
        await delay(150)
        await this.sendCmd(CASHLESS.ENABLE)
      })
      // A stray that arrived while we were closing the last one is handled on the
      // next loop pass, so none are ever skipped.
    } while (this.strayPending && !this.saleInProgress)
    this.sessionOpen = false
    this.cancellingStray = false
    recordNayax({ dir: 'INFO', note: 'STRAY SESSION(S) closed + reader re-armed to ready' })
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
