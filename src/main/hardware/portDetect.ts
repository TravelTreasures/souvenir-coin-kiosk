/**
 * Serial-port auto-detection
 * --------------------------
 * The kiosk has two USB serial adapters: the ccTalk interface for the hoppers
 * and the MDB-RS232 box for the Nayax reader. Linux names them /dev/ttyUSB0 and
 * /dev/ttyUSB1 in the order it happens to detect them — and that order is NOT
 * fixed. It can differ between a cold power-up and a plain reboot (when both
 * adapters are already powered), or when the adapters are plugged into different
 * USB sockets on a new kiosk. If the names swap, the app talks ccTalk to the
 * card reader and MDB to the hoppers: the ports "open" fine, but the hoppers
 * never answer and stay offline until the whole kiosk is power-cycled.
 *
 * So instead of trusting the names, we ASK: each candidate port is opened and
 * sent a ccTalk "simple poll" for hopper address 3 and 4. Only the real hopper
 * interface can return a valid, checksummed ccTalk ACK, so whichever port answers
 * is the hopper bus and the other one is the Nayax.
 */

import { readdirSync, realpathSync } from 'fs'
import { CctalkBus, CMD, ACK } from '../hopper/cctalk'

const HOPPER_ADDRS = [3, 4]
const PROBE_TIMEOUT_MS = 350

export interface PortAssignment {
  hopper: string
  nayax: string
  /** Human-readable result, shown in Admin → Diagnostics. */
  note: string
  /** True when a hopper actually answered on `hopper`. */
  verified: boolean
}

/** USB serial adapters present on this machine (Linux only), in name order. */
export function listUsbSerialPorts(): string[] {
  if (process.platform !== 'linux') return []
  try {
    return readdirSync('/dev')
      .filter((n) => /^tty(USB|ACM)\d+$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((n) => `/dev/${n}`)
  } catch {
    return []
  }
}

/** Follow a symlink such as /dev/serial/by-id/… to the real /dev/ttyUSBn name. */
function realPort(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Open `path`, poll for a hopper, close it again. Never throws. `error` is set
 *  when the port could not even be opened (missing, busy, or no permission). */
async function hopperAnswersOn(path: string): Promise<{ found: boolean; error?: string }> {
  // Everything is inside the try, including loading the serial driver and
  // creating the port object, so a failure is REPORTED, never thrown.
  let port: { isOpen: boolean; close: (cb: () => void) => void; open: (cb: (err?: Error | null) => void) => void; on: (ev: 'error', cb: () => void) => void } | null = null
  const close = (): Promise<void> => new Promise((r) => (port && port.isOpen ? port.close(() => r()) : r()))
  try {
    const { SerialPort } = await import('serialport')
    const sp = new SerialPort({ path, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false })
    port = sp as unknown as typeof port
    await new Promise<void>((resolve, reject) => sp.open((err) => (err ? reject(err) : resolve())))
    sp.on('error', () => undefined) // never let a late serial error crash the app
    const bus = new CctalkBus(sp)
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const addr of HOPPER_ADDRS) {
        try {
          const reply = await bus.send(addr, CMD.SIMPLE_POLL, [], PROBE_TIMEOUT_MS)
          if (reply.header === ACK) return { found: true }
        } catch {
          /* no answer from this address on this port — keep trying */
        }
      }
    }
    return { found: false }
  } catch (e) {
    // Could not open (missing / busy / no permission) — not usable as the hopper port.
    return { found: false, error: ((e as Error)?.message || 'could not open').split('\n')[0] }
  } finally {
    await close()
    await new Promise((r) => setTimeout(r, 150)) // let the OS release the port
  }
}

/**
 * Work out which port is which. `current` (the configured or last-known ports)
 * is only a STARTING POINT: it is tried first, and it is the fallback when
 * nothing answers (e.g. the hoppers are still powering up). A port that was
 * fixed in the kiosk's start-up settings is therefore corrected automatically
 * when the adapters have swapped names, instead of leaving the kiosk offline.
 */
export async function detectPorts(current: { hopper: string; nayax: string }): Promise<PortAssignment> {
  const candidates = listUsbSerialPorts()
  if (candidates.length === 0) {
    return { ...current, verified: false, note: 'No USB serial adapters found — check the USB cables' }
  }
  const curHopper = realPort(current.hopper)
  const curNayax = realPort(current.nayax)
  // Try the currently-assigned hopper port first so the normal case is fastest.
  const ordered = [...candidates].sort((a, b) => Number(b === curHopper) - Number(a === curHopper))
  const problems: string[] = []
  for (const path of ordered) {
    const r = await hopperAnswersOn(path)
    if (r.found) {
      const others = candidates.filter((c) => c !== path)
      const nayax = others.includes(curNayax) ? curNayax : others[0] ?? current.nayax
      const moved = path !== curHopper ? ' (corrected automatically)' : ''
      return { hopper: path, nayax, verified: true, note: `Hoppers found on ${path} · card reader on ${nayax}${moved}` }
    }
    if (r.error) problems.push(`${path}: ${r.error}`)
  }
  return {
    ...current,
    verified: false,
    note:
      `No hopper answered on ${candidates.join(', ')} — check hopper power and the ccTalk cable` +
      (problems.length ? ` · could not open ${problems.join('; ')}` : '')
  }
}
