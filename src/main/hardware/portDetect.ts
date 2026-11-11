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

import { readdirSync } from 'fs'
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

/** Open `path`, poll for a hopper, close it again. Never throws. */
async function hopperAnswersOn(path: string): Promise<boolean> {
  const { SerialPort } = await import('serialport')
  const port = new SerialPort({ path, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false })
  const close = (): Promise<void> => new Promise((r) => (port.isOpen ? port.close(() => r()) : r()))
  try {
    await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())))
    port.on('error', () => undefined) // never let a late serial error crash the app
    const bus = new CctalkBus(port)
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const addr of HOPPER_ADDRS) {
        try {
          const reply = await bus.send(addr, CMD.SIMPLE_POLL, [], PROBE_TIMEOUT_MS)
          if (reply.header === ACK) return true
        } catch {
          /* no answer from this address on this port — keep trying */
        }
      }
    }
    return false
  } catch {
    return false // could not open (busy / no permission) — not our hopper port
  } finally {
    await close()
    await new Promise((r) => setTimeout(r, 150)) // let the OS release the port
  }
}

/**
 * Work out which port is which. `current` is used as the fallback when nothing
 * answers (e.g. the hoppers are still powering up), so behaviour is never worse
 * than the old fixed names.
 */
export async function detectPorts(current: { hopper: string; nayax: string }): Promise<PortAssignment> {
  const candidates = listUsbSerialPorts()
  if (candidates.length === 0) {
    return { ...current, verified: false, note: 'No USB serial adapters found' }
  }
  // Try the currently-assigned hopper port first so the normal case is fastest.
  const ordered = [...candidates].sort((a, b) => Number(b === current.hopper) - Number(a === current.hopper))
  for (const path of ordered) {
    if (await hopperAnswersOn(path)) {
      const others = candidates.filter((c) => c !== path)
      const nayax = others.includes(current.nayax) ? current.nayax : others[0] ?? current.nayax
      return { hopper: path, nayax, verified: true, note: `Hoppers found on ${path} · card reader on ${nayax}` }
    }
  }
  return {
    ...current,
    verified: false,
    note: `No hopper answered on ${candidates.join(', ')} — check hopper power and the ccTalk cable`
  }
}
