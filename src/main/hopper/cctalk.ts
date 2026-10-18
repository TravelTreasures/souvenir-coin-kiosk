/**
 * ccTalk protocol layer
 * ---------------------
 * Talks to SuzoHapp Flow Hoppers through the Multi ccTalk Interface (107-0251)
 * running in USB→ccTalk mode (appears as a USB serial port on the mini-PC).
 *
 * Frame format (ccTalk standard):
 *   [ destAddr ][ nDataBytes ][ srcAddr ][ header ][ data... ][ checksum ]
 *   - host address = 1; hopper (slave) addresses = 3 and 4 (set by DIP switches)
 *   - checksum: the 8-bit sum (mod 256) of ALL bytes incl. the checksum is 0
 *   - ACK header = 0, NAK header = 5
 *   - serial line: 9600 baud, 8 data bits, no parity, 1 stop bit
 *
 * The ccTalk bus is a half-duplex single data line, so the interface echoes
 * our transmitted bytes back to us. We ignore the echo simply by scanning the
 * receive buffer for a valid frame addressed to the host (destAddr == 1): the
 * echo of our own command is addressed to the hopper (3/4), so it is skipped.
 *
 * Commands are strictly request→response and serialized one at a time.
 */

export const HOST_ADDR = 1
export const ACK = 0
export const NAK = 5

/** ccTalk command headers used by the Flow Hopper. */
export const CMD = {
  RESET: 1,
  REQUEST_COMMS_STATUS: 2,
  TEST_HOPPER: 163,
  ENABLE_HOPPER: 164,
  REQUEST_HOPPER_STATUS: 166,
  DISPENSE_HOPPER_COINS: 167,
  REQUEST_DISPENSE_COUNT: 168,
  REQUEST_ADDRESS_MODE: 169,
  EMERGENCY_STOP: 172,
  REQUEST_PAYOUT_LEVEL: 217,
  REQUEST_SERIAL: 242,
  REQUEST_PRODUCT_CODE: 244,
  SIMPLE_POLL: 254
} as const

/** The enable code that unlocks payout (ENABLE_HOPPER data byte). */
export const ENABLE_CODE = 0xa5

export interface CctalkReply {
  header: number
  data: number[]
}

/** Minimal serial-port surface we depend on (satisfied by `serialport`). */
export interface SerialLike {
  write(data: Buffer, cb: (err?: Error | null) => void): void
  on(event: 'data', cb: (d: Buffer) => void): void
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Build a ccTalk command frame (host → device) with a correct checksum. */
export function buildFrame(dest: number, header: number, data: number[] = []): Buffer {
  const body = [dest & 0xff, data.length & 0xff, HOST_ADDR, header & 0xff, ...data.map((d) => d & 0xff)]
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0)
  const checksum = (256 - sum) & 0xff
  return Buffer.from([...body, checksum])
}

/**
 * Find the first valid reply frame addressed to the host inside `buf`.
 * Returns the parsed reply and the buffer offset just past it, or null if a
 * complete, checksum-valid host frame isn't present yet.
 */
export function extractReply(buf: Buffer): { reply: CctalkReply; end: number } | null {
  for (let i = 0; i + 5 <= buf.length; i++) {
    if (buf[i] !== HOST_ADDR) continue // skip echoed command bytes (dest = hopper)
    const n = buf[i + 1]
    const end = i + 5 + n
    // Not enough bytes for a frame at this offset. This can be a genuinely
    // incomplete reply, OR a false match on a 0x01 byte inside the echoed
    // command (the host source-address). Keep scanning rather than giving up;
    // if nothing complete is found we return null and the caller waits for more.
    if (end > buf.length) continue
    let sum = 0
    for (let j = i; j < end; j++) sum = (sum + buf[j]) & 0xff
    if (sum !== 0) continue // bad checksum here — keep scanning
    const header = buf[i + 3]
    const data = Array.from(buf.subarray(i + 4, end - 1))
    return { reply: { header, data }, end }
  }
  return null
}

/**
 * Serializes ccTalk request/response exchanges over a serial port, handling the
 * half-duplex echo and per-command timeouts.
 */
export class CctalkBus {
  private port: SerialLike
  private rx: Buffer = Buffer.alloc(0)
  private queue: Promise<unknown> = Promise.resolve()

  constructor(port: SerialLike) {
    this.port = port
    this.port.on('data', (d: Buffer) => {
      this.rx = Buffer.concat([this.rx, d])
    })
  }

  /**
   * Send a command to `dest` and wait for its reply frame. Exchanges are
   * queued so only one is ever in flight (the bus is half-duplex).
   */
  send(dest: number, header: number, data: number[] = [], timeoutMs = 150): Promise<CctalkReply> {
    const run = async (): Promise<CctalkReply> => {
      this.rx = Buffer.alloc(0) // drop any stale/echoed bytes before we transmit
      const frame = buildFrame(dest, header, data)
      await new Promise<void>((resolve, reject) =>
        this.port.write(frame, (err) => (err ? reject(err) : resolve()))
      )
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const got = extractReply(this.rx)
        if (got) {
          this.rx = Buffer.from(this.rx.subarray(got.end))
          return got.reply
        }
        await delay(3)
      }
      throw new Error(`ccTalk timeout (dest ${dest}, header ${header})`)
    }
    // chain onto the queue regardless of whether the previous call resolved
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}
