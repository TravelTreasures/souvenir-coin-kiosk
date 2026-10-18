/**
 * HopperController
 * ----------------
 * Drives the two SuzoHapp ccTalk Flow Hoppers (model 18-USE_SERNR-ID) through
 * the Multi ccTalk Interface (107-0251) in USB→ccTalk mode.
 *
 * PRODUCTION: speaks ccTalk over a USB serial port (see ./cctalk.ts).
 *   - Hopper 1 is at ccTalk address 3, Hopper 2 at address 4 (set by DIP switches).
 *   - These are the USE_SERNR hoppers: the DISPENSE command is secured by the
 *     hopper's own 3-byte serial number (no cipher/encryption handshake needed),
 *     which we read once at start-up and send with every payout.
 *
 * SIMULATION (dev / bench without hardware): all responses are mocked in-memory
 * and driven by the Hardware Simulator window over IPC — unchanged behaviour.
 *
 * ccTalk hoppers have no stock counter, so the number of coins in each hopper is
 * tracked here (and mirrored in the local DB): seeded at boot, decremented per
 * coin actually paid, and set on refill. The hopper's own low-level sensor is a
 * secondary "running low" signal.
 *
 * NOTE: the class keeps the same public surface the rest of the app already
 * uses (static HOPPER_1_ADDR / HOPPER_2_ADDR, connect / isConnected /
 * getHopperStatus / getCoinCount / setCoinCount / dispense, and the
 * 'hopper:status' event), so nothing else in the app had to change.
 */

import { EventEmitter } from 'events'
import { CctalkBus, CMD, ACK, NAK, ENABLE_CODE } from './cctalk'

export type HopperStatus = 'ok' | 'empty' | 'jam' | 'offline' | 'initialising'

export interface HopperState {
  address: number
  status: HopperStatus
  coinCount: number
}

export interface DispenseResult {
  success: boolean
  coinsDispensed: number
  error?: string
}

// ccTalk bus addresses of the two hoppers (DIP switches: H1 = 3, H2 = 4).
const H1 = 3
const H2 = 4

interface HopperRuntime extends HopperState {
  serial?: number[] // 3-byte serial [LSB, mid, MSB], read at start-up
}

// Software-tracked hopper state (shared by simulation and production — the count
// is never read from the hopper, it's maintained here + in the DB).
const hoppers: Record<number, HopperRuntime> = {
  [H1]: { address: H1, status: 'ok', coinCount: 500 },
  [H2]: { address: H2, status: 'ok', coinCount: 500 }
}

// ------------------------------------------------------------------
// Count / status management (used by refill, admin, and the simulator;
// applies in BOTH production and simulation).
// ------------------------------------------------------------------
export function simSetHopperStatus(address: number, status: HopperStatus): void {
  if (hoppers[address]) hoppers[address].status = status
}

export function simSetHopperCoinCount(address: number, count: number): void {
  const h = hoppers[address]
  if (!h) return
  h.coinCount = count
  // Keep status consistent with stock: a refill clears a previous 'empty'
  // state so the hopper can dispense again; setting to 0 marks it empty.
  // A jam / offline fault is left untouched.
  if (count <= 0) {
    if (h.status !== 'jam' && h.status !== 'offline') h.status = 'empty'
  } else if (h.status === 'empty') {
    h.status = 'ok'
  }
}

interface HopperLiveStatus {
  eventCounter: number
  remaining: number
  coinsPaid: number
  coinsUnpaid: number
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class HopperController extends EventEmitter {
  private serialPath: string | null
  private isSimulated: boolean
  private connected = false
  private bus: CctalkBus | null = null

  static readonly HOPPER_1_ADDR = H1
  static readonly HOPPER_2_ADDR = H2

  constructor(serialPath: string | null = null, simulated = true) {
    super()
    this.serialPath = serialPath
    this.isSimulated = simulated
  }

  // ------------------------------------------------------------------
  // Connect
  // ------------------------------------------------------------------
  async connect(): Promise<void> {
    if (this.isSimulated) {
      console.log('[hopper] Running in simulation mode')
      this.connected = true
      for (const h of Object.values(hoppers)) this.emitStatus(h.address)
      return
    }

    // PRODUCTION: open the USB serial port to the 107-0251 ccTalk interface.
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
        console.error('[hopper] Serial error:', err.message)
        this.emit('error', { type: 'serial', message: err.message })
        reject(err)
      })
    })

    console.log(`[hopper] ccTalk serial port ${this.serialPath} opened`)
    this.bus = new CctalkBus(port)
    this.connected = true
    this.emit('connected')

    // Initialise each hopper (best-effort; a missing hopper is marked offline
    // but does not stop the others or the app).
    for (const addr of [H1, H2]) {
      await this.initHopper(addr).catch((e) => {
        console.error(`[hopper ${addr}] init failed:`, (e as Error).message)
        hoppers[addr].status = 'offline'
        this.emitStatus(addr)
      })
    }
  }

  /** Detect a hopper, read its serial number, and enable payout. */
  private async initHopper(addr: number): Promise<void> {
    const bus = this.bus!
    hoppers[addr].status = 'initialising'

    // 1. Simple poll — is the hopper on the bus?
    const poll = await bus.send(addr, CMD.SIMPLE_POLL)
    if (poll.header !== ACK) throw new Error('no ACK to simple poll')

    // 2. Serial number — required to secure the USE_SERNR dispense command.
    const ser = await bus.send(addr, CMD.REQUEST_SERIAL)
    if (ser.header !== ACK || ser.data.length < 3) throw new Error('no serial number')
    hoppers[addr].serial = ser.data.slice(0, 3) // [LSB, mid, MSB]
    console.log(`[hopper ${addr}] serial ${this.serialDecimal(hoppers[addr].serial!)}`)

    // 3. Test hopper — surface fault flags (PIN / opto) for logging.
    const test = await bus.send(addr, CMD.TEST_HOPPER)
    if (test.header === ACK && test.data.length >= 2) {
      const reg2 = test.data[1]
      if (reg2 & 0x80) {
        console.warn(
          `[hopper ${addr}] PIN mechanism is ENABLED — payout will be blocked until a PIN is entered. ` +
            `Factory-default hoppers ship with the PIN disabled.`
        )
      }
    }

    // 4. Enable payout.
    const en = await bus.send(addr, CMD.ENABLE_HOPPER, [ENABLE_CODE])
    if (en.header !== ACK) throw new Error('enable hopper not ACKed')

    hoppers[addr].status = hoppers[addr].coinCount > 0 ? 'ok' : 'empty'
    this.emitStatus(addr)
  }

  isConnected(): boolean {
    return this.connected
  }

  // ------------------------------------------------------------------
  // Status / counts
  // ------------------------------------------------------------------
  async getHopperStatus(address: number): Promise<HopperState> {
    const h = hoppers[address]
    if (!h) return { address, status: 'offline', coinCount: 0 }
    return { address: h.address, status: h.status, coinCount: h.coinCount }
  }

  getCoinCount(address: number): number {
    return hoppers[address]?.coinCount ?? 0
  }

  setCoinCount(address: number, count: number): void {
    simSetHopperCoinCount(address, count)
  }

  // ------------------------------------------------------------------
  // Dispense
  // ------------------------------------------------------------------
  async dispense(address: number, quantity = 1): Promise<DispenseResult> {
    if (!this.connected) {
      return { success: false, coinsDispensed: 0, error: 'HOPPER_NOT_CONNECTED' }
    }
    if (this.isSimulated) {
      return this.simulatedDispense(address, quantity)
    }
    return this.productionDispense(address, quantity)
  }

  private async productionDispense(address: number, quantity: number): Promise<DispenseResult> {
    const bus = this.bus
    const h = hoppers[address]
    if (!bus || !h) return { success: false, coinsDispensed: 0, error: 'UNKNOWN_HOPPER' }
    if (h.status === 'offline') return { success: false, coinsDispensed: 0, error: 'HOPPER_OFFLINE' }
    if (h.coinCount <= 0) return { success: false, coinsDispensed: 0, error: 'HOPPER_EMPTY' }
    if (!h.serial) return { success: false, coinsDispensed: 0, error: 'HOPPER_NOT_INITIALISED' }

    try {
      // Ensure the hopper is enabled (harmless if already enabled).
      await bus.send(address, CMD.ENABLE_HOPPER, [ENABLE_CODE])

      // DISPENSE (USE_SERNR): data = [serial LSB, serial mid, serial MSB, N coins].
      const resp = await bus.send(address, CMD.DISPENSE_HOPPER_COINS, [...h.serial, quantity & 0xff])
      if (resp.header === NAK) {
        await this.refreshFaultFlags(address)
        return { success: false, coinsDispensed: 0, error: 'DISPENSE_REJECTED' }
      }

      // Poll the hopper status until the payout finishes (or times out).
      const paid = await this.waitForPayout(address, quantity)

      h.coinCount = Math.max(0, h.coinCount - paid)
      if (h.coinCount <= 0) h.status = 'empty'
      this.emitStatus(address)

      if (paid < quantity) {
        // Partial payout — likely emptied or jammed mid-dispense.
        await this.refreshFaultFlags(address)
        return {
          success: paid > 0,
          coinsDispensed: paid,
          error: paid > 0 ? 'PARTIAL_PAYOUT' : 'NO_COINS_PAID'
        }
      }
      return { success: true, coinsDispensed: paid }
    } catch (e) {
      console.error(`[hopper ${address}] dispense error:`, (e as Error).message)
      h.status = 'offline'
      this.emitStatus(address)
      return { success: false, coinsDispensed: 0, error: 'CCTALK_COMM_FAILURE' }
    }
  }

  /** Poll REQUEST_HOPPER_STATUS until payout completes; returns coins paid. */
  private async waitForPayout(address: number, want: number): Promise<number> {
    const bus = this.bus!
    // Flow hopper pays ~7 coins/sec; allow generous headroom + fixed overhead.
    const deadline = Date.now() + 2000 + want * 1500
    let coinsPaid = 0
    while (Date.now() < deadline) {
      await delay(150)
      const s = this.parseLiveStatus(await bus.send(address, CMD.REQUEST_HOPPER_STATUS))
      coinsPaid = s.coinsPaid
      if (s.remaining === 0) break
    }
    return coinsPaid
  }

  private parseLiveStatus(reply: { header: number; data: number[] }): HopperLiveStatus {
    const d = reply.data
    return {
      eventCounter: d[0] ?? 0,
      remaining: d[1] ?? 0,
      coinsPaid: d[2] ?? 0,
      coinsUnpaid: d[3] ?? 0
    }
  }

  /** Read TEST_HOPPER flags and translate serious faults into a hopper status. */
  private async refreshFaultFlags(address: number): Promise<void> {
    try {
      const test = await this.bus!.send(address, CMD.TEST_HOPPER)
      if (test.header === ACK && test.data.length >= 1) {
        const reg1 = test.data[0]
        // B1 payout timeout, B5 opto blocked during payout, B2 jam cleared by reverse
        if (reg1 & 0b00100010 || reg1 & 0b00000100) hoppers[address].status = 'jam'
      }
    } catch {
      /* best-effort diagnostics only */
    }
    this.emitStatus(address)
  }

  /** Abort an in-progress payout (e.g. on transaction cancel / power concerns). */
  async emergencyStop(address: number): Promise<void> {
    if (this.isSimulated || !this.bus) return
    try {
      await this.bus.send(address, CMD.EMERGENCY_STOP)
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------
  // Simulation (dev) — unchanged behaviour
  // ------------------------------------------------------------------
  private simulatedDispense(address: number, quantity: number): DispenseResult {
    const h = hoppers[address]
    if (!h) return { success: false, coinsDispensed: 0, error: 'Unknown hopper address' }
    if (h.status === 'empty' || h.coinCount <= 0) {
      return { success: false, coinsDispensed: 0, error: 'HOPPER_EMPTY' }
    }
    if (h.status === 'jam') return { success: false, coinsDispensed: 0, error: 'HOPPER_JAM' }
    if (h.status === 'offline') return { success: false, coinsDispensed: 0, error: 'HOPPER_COMM_FAILURE' }

    h.coinCount -= quantity
    if (h.coinCount <= 0) {
      h.coinCount = 0
      h.status = 'empty'
    }
    this.emitStatus(address)
    return { success: true, coinsDispensed: quantity }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  private emitStatus(address: number): void {
    const h = hoppers[address]
    if (!h) return
    this.emit('hopper:status', { address: h.address, status: h.status, coinCount: h.coinCount })
  }

  private serialDecimal(serial: number[]): number {
    // serial bytes are little-endian: [LSB, mid, MSB]
    return (serial[0] ?? 0) | ((serial[1] ?? 0) << 8) | ((serial[2] ?? 0) << 16)
  }
}
