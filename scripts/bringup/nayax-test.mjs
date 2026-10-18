#!/usr/bin/env node
/*
 * Nayax card-reader bring-up test (MDB cashless via the Waferstar MDB-RS232 box).
 * Configures + enables the reader, waits for a card tap, requests a test vend,
 * shows the approval — then CANCELS the vend so NO money is captured.
 * Prints every byte sent/received so you can confirm wiring + calibrate.
 *
 * Run on the mini-PC from ~/kiosk-app (after `npm install`):
 *   node scripts/bringup/nayax-test.mjs [port] [priceCents]
 * Example:
 *   node scripts/bringup/nayax-test.mjs /dev/ttyUSB1 100     # test ~R1.00
 *
 * Notes:
 *  - The Nayax reader must be registered/active on Nayax's own server, or it
 *    won't start a session. Confirm with your Nayax contact.
 *  - This test does NOT keep any money: after approval it sends "vend cancel".
 *  - Find the real port with `ls /dev/serial/by-id/`. Permission error? run once:
 *    sudo usermod -aG dialout $USER  (then log out and back in).
 */
import { SerialPort } from 'serialport'

const PORT = process.argv[2] || process.env.NAYAX_PORT || '/dev/ttyUSB1'
const PRICE = Number(process.argv[3] || 100) // minor units (cents) — calibrate if mis-charged

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ').toUpperCase()
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff]

// replies may be raw bytes OR ASCII-hex text — normalise both to raw bytes
function norm(buf) {
  const a = [...buf]
  const isHex =
    a.length > 0 &&
    a.length % 2 === 0 &&
    a.every((b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102))
  if (isHex) {
    const s = buf.toString('ascii')
    const o = []
    for (let i = 0; i < s.length; i += 2) o.push(parseInt(s.slice(i, i + 2), 16))
    return o
  }
  return a
}

const port = new SerialPort({ path: PORT, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' })
let last = null
port.on('data', (d) => {
  const n = norm(d)
  if (!n.length) return
  last = { bytes: n, first: n[0] }
  console.log('  RX', hex(d), '=>', hex(n))
})

const tx = (bytes, label) =>
  new Promise((res, rej) => {
    console.log('  TX', hex(bytes), label ? '(' + label + ')' : '')
    port.write(Buffer.from(bytes), (e) => (e ? rej(e) : res()))
  })

function waitFirst(first, timeout) {
  return new Promise((res) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (last && last.first === first) {
        clearInterval(iv)
        const l = last
        last = null
        res(l)
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv)
        res(null)
      }
    }, 50)
  })
}

;(async () => {
  console.log(`\nNayax reader test — port ${PORT}, test price ${PRICE} (minor units)\n`)
  await new Promise((res, rej) => {
    port.on('open', res)
    port.on('error', rej)
  }).catch((e) => {
    console.log('❌ could not open port:', e.message)
    process.exit(1)
  })
  try {
    console.log('1) Config reader...')
    await tx([0x11, 0x00, 0x01, 0x00, 0x00, 0x00], 'config')
    await delay(300)
    console.log('2) Set price range...')
    await tx([0x11, 0x01, 0xff, 0xff, 0x00, 0x00], 'price range')
    await delay(300)
    console.log('3) Enable reader...')
    await tx([0x14, 0x01], 'enable')
    await delay(300)

    console.log('\n>>> TAP A CARD on the reader now (waiting up to 60s)...\n')
    const began = await waitFirst(0x03, 60000)
    if (!began) {
      console.log('❌ No card session seen (expected a reply starting 03).')
      console.log('   Checks: right port? reader powered (24V)? reader active on Nayax server?')
      return
    }
    console.log('   -> card detected (begin session) ✓')

    console.log('4) Request vend...')
    await tx([0x13, 0x00, ...u16(PRICE), ...u16(1)], 'request vend')
    const appr = await waitFirst(0x05, 60000)
    if (appr) console.log('   -> VEND APPROVED ✓  (the card WOULD be charged on a real sale)')
    else console.log('   -> no approval (expected a reply starting 05). May be declined — see RX log.')

    console.log('5) TEST MODE: cancelling the vend so NO money is captured...')
    await tx([0x13, 0x01], 'vend cancel')
    await delay(200)
    await tx([0x13, 0x04], 'session complete')
    await delay(300)

    console.log('\n✅ RESULT: reader communication works. No charge was captured.')
    console.log('   (For a REAL charge test, send 13 02 00 01 "vend success" instead of the cancel.)')
  } catch (e) {
    console.log('\n❌ FAILED:', e.message)
  } finally {
    await delay(300)
    port.close(() => process.exit(0))
  }
})()
