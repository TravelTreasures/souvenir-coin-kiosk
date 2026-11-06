/**
 * Nayax event logbook — a small in-memory ring buffer of the reader's serial
 * traffic (TX/RX) plus key lifecycle markers, so the exact MDB sequence can be
 * inspected remotely from Fleet Admin without a terminal on the kiosk.
 *
 * The kiosk records here; FleetSync pushes the buffer to the server each tick;
 * the dashboard shows it under the kiosk. Purely diagnostic — capped so it can
 * never grow without bound.
 */

export type NayaxLogDir = 'TX' | 'RX' | 'INFO'

export interface NayaxLogEntry {
  at: string // ISO timestamp
  dir: NayaxLogDir
  hex?: string // byte string for TX/RX
  event?: string // classified reader event for RX
  note?: string // human note for INFO markers
}

const MAX_ENTRIES = 500
const buffer: NayaxLogEntry[] = []

/** Append one entry (timestamped now). Oldest entries drop once full. */
export function recordNayax(e: Omit<NayaxLogEntry, 'at'>): void {
  buffer.push({ at: new Date().toISOString(), ...e })
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
}

/** A copy of the current buffer (oldest → newest). */
export function getNayaxLog(): NayaxLogEntry[] {
  return buffer.slice()
}

/** Number of entries currently held (used to skip pushing an unchanged buffer). */
export function nayaxLogCount(): number {
  return buffer.length
}
