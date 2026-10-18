/**
 * Waferstar MDB-RS232 adapter — MDB cashless (card reader) protocol helpers
 * ------------------------------------------------------------------------
 * The adapter is the MDB master; it forwards our commands to the Nayax cashless
 * reader. We drive it as the VMC over a serial port (9600 8N1), connected to the
 * mini-PC over USB (the adapter's USB/virtual-COM version).
 *
 * We SEND raw command bytes. Replies may arrive as raw bytes OR as ASCII-hex
 * text depending on the unit — `normaliseReply` turns both into raw bytes.
 *
 * Command bytes (from the MDB-RS232 manual, "Nayax MDB cashless" section):
 *   14 01                 enable card reader
 *   14 00                 disable card reader
 *   14 02                 cancel card reader
 *   11 00 01 00 00 00      config the card reader
 *   11 01 FF FF 00 00      set max / min price
 *   13 00 PP PP II II      request vend   (PPPP = price, IIII = item)
 *   13 02 II II            vend success   (after the coin is dispensed)
 *   13 01                 vend cancel    (refund — coin was NOT dispensed)
 *   13 04                 session complete
 *   13 05 PP PP II II      cash sale
 *   15 00                 request revalue
 *   17 00                 request id
 *
 * Reader → VMC (activity / replies), identified by the first byte:
 *   03 ..                begin session  (valid card read, awaiting vend)
 *   05 ..                vend approved  (funds reserved)
 *   06 / 04 ..           vend denied / session cancel  (see notes — calibrate)
 *   07                   session ended
 *   00                   generic ACK
 *
 * ⚠ CALIBRATION NOTES (verify against the real reader during bring-up):
 *   - Price scaling: we send `amountCents` straight into the 2-byte price field.
 *     The Nayax/box scaling (scale factor + decimal places) may require dividing
 *     by a factor — adjust PRICE_DIVISOR if the reader charges the wrong amount.
 *   - Reply framing/encoding: raw vs ASCII-hex is auto-detected; the exact
 *     approval/denial first-byte codes above are from the manual's examples.
 */

/** Divisor applied to amountCents before putting it in the 2-byte price field.
 *  1 → price sent in cents (most likely). Change if the reader mis-charges. */
export const PRICE_DIVISOR = 1

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]

/** Static cashless commands (byte arrays). */
export const CASHLESS = {
  ENABLE: [0x14, 0x01],
  DISABLE: [0x14, 0x00],
  CANCEL_READER: [0x14, 0x02],
  CONFIG: [0x11, 0x00, 0x01, 0x00, 0x00, 0x00],
  SET_PRICE_RANGE: [0x11, 0x01, 0xff, 0xff, 0x00, 0x00],
  VEND_CANCEL: [0x13, 0x01],
  SESSION_COMPLETE: [0x13, 0x04],
  REQUEST_ID: [0x17, 0x00]
} as const

/** 13 00 PPPP IIII — ask the reader to authorise `priceCents` for `item`. */
export function requestVend(priceCents: number, item = 1): number[] {
  const price = Math.max(0, Math.round(priceCents / PRICE_DIVISOR)) & 0xffff
  return [0x13, 0x00, ...u16(price), ...u16(item)]
}

/** 13 02 IIII — tell the reader the goods were dispensed (capture the charge). */
export function vendSuccess(item = 1): number[] {
  return [0x13, 0x02, ...u16(item)]
}

/** First-byte classification of a reader reply. */
export type ReaderEvent = 'begin_session' | 'approved' | 'denied' | 'ended' | 'ack' | 'unknown'

export function classifyReply(bytes: number[]): ReaderEvent {
  if (bytes.length === 0) return 'unknown'
  switch (bytes[0]) {
    case 0x03:
      return 'begin_session'
    case 0x05:
      return 'approved'
    case 0x06:
      return 'denied'
    case 0x07:
      return 'ended'
    case 0x00:
      return 'ack'
    default:
      return 'unknown'
  }
}

/**
 * Normalise a received buffer to raw bytes. Some MDB-RS232 units reply with
 * ASCII-hex text ("05000A") rather than raw bytes (0x05 0x00 0x0A); if every
 * byte is an ASCII hex digit and the length is even, decode it as hex text.
 */
export function normaliseReply(buf: Buffer): number[] {
  const isHexAscii =
    buf.length > 0 &&
    buf.length % 2 === 0 &&
    [...buf].every(
      (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
    )
  if (isHexAscii) {
    const s = buf.toString('ascii')
    const out: number[] = []
    for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16))
    return out
  }
  return [...buf]
}

export const toHex = (bytes: readonly number[] | Buffer): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase()
