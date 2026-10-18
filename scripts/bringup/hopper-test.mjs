#!/usr/bin/env node
/*
 * Hopper bring-up test (ccTalk via the 107-0251 USB interface).
 * Polls one hopper, reads its serial number, enables it, and dispenses N coins —
 * printing every byte sent/received so you can confirm wiring + calibrate.
 *
 * Run on the mini-PC from ~/kiosk-app (after `npm install`):
 *   node scripts/bringup/hopper-test.mjs [port] [address] [coins]
 * Examples:
 *   node scripts/bringup/hopper-test.mjs /dev/ttyUSB0 3 1      # hopper 1, 1 coin
 *   node scripts/bringup/hopper-test.mjs /dev/ttyUSB0 4 1      # hopper 2, 1 coin
 *
 * Tip: find the real port with `ls /dev/serial/by-id/`. If you get a permission
 * error, add yourself to the dialout group once: sudo usermod -aG dialout $USER
 * (then log out and back in).
 */
import { SerialPort } from 'serialport'

const PORT = process.argv[2] || process.env.HOPPER_PORT || '/dev/ttyUSB0'
const ADDR = Number(process.argv[3] || 3)
const COINS = Number(process.argv[4] || 1)
const HOST = 1
const ACK = 0
const NAK = 5

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ').toUpperCase()
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function frame(dest, header, data = []) {
  const body = [dest, data.length, HOST, header, ...data]
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0)
  return Buffer.from([...body, (256 - sum) & 0xff])
}
function extract(buf) {
  for (let i = 0; i + 5 <= buf.length; i++) {
    if (buf[i] !== HOST) continue
    const n = buf[i + 1]
    const end = i + 5 + n
    if (end > buf.length) continue
    let s = 0
    for (let j = i; j < end; j++) s = (s + buf[j]) & 0xff
    if (s !== 0) continue
    return { header: buf[i + 3], data: [...buf.subarray(i + 4, end - 1)], end }
  }
  return null
}

const port = new SerialPort({ path: PORT, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' })
let rx = Buffer.alloc(0)
port.on('data', (d) => (rx = Buffer.concat([rx, d])))

function send(dest, header, data = [], timeout = 300) {
  return new Promise((resolve, reject) => {
    rx = Buffer.alloc(0)
    const f = frame(dest, header, data)
    console.log('  TX', hex(f))
    port.write(f, (e) => e && reject(e))
    const t0 = Date.now()
    const iv = setInterval(() => {
      const g = extract(rx)
      if (g) {
        clearInterval(iv)
        console.log('  RX', hex(rx.subarray(0, g.end)), '=> header', g.header, g.data.length ? 'data ' + hex(g.data) : '')
        resolve(g)
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv)
        reject(new Error('no reply (timeout)'))
      }
    }, 5)
  })
}

const C = { POLL: 254, SERIAL: 242, TEST: 163, ENABLE: 164, STATUS: 166, DISPENSE: 167 }

;(async () => {
  console.log(`\nHopper test — port ${PORT}, address ${ADDR}, dispense ${COINS} coin(s)\n`)
  await new Promise((res, rej) => {
    port.on('open', res)
    port.on('error', rej)
  }).catch((e) => {
    console.log('❌ could not open port:', e.message)
    process.exit(1)
  })
  try {
    console.log('1) Simple poll...')
    const p = await send(ADDR, C.POLL)
    if (p.header !== ACK) throw new Error('hopper did not ACK the poll')
    console.log('   -> hopper is responding ✓')

    console.log('2) Read serial number...')
    const s = await send(ADDR, C.SERIAL)
    const serial = s.data.slice(0, 3)
    const dec = (serial[0] || 0) | ((serial[1] || 0) << 8) | ((serial[2] || 0) << 16)
    console.log('   -> serial', dec)

    console.log('3) Test hopper (reads status flags)...')
    await send(ADDR, C.TEST)

    console.log('4) Enable hopper...')
    const en = await send(ADDR, C.ENABLE, [0xa5])
    if (en.header !== ACK) throw new Error('enable not ACKed')
    console.log('   -> enabled ✓')

    console.log(`5) Dispense ${COINS} coin(s)...`)
    const d = await send(ADDR, C.DISPENSE, [...serial, COINS])
    if (d.header === NAK) throw new Error('dispense rejected (NAK) — check Test flags above (PIN/opto/empty)')

    let paid = 0
    for (let i = 0; i < 40; i++) {
      await delay(200)
      const st = await send(ADDR, C.STATUS)
      const remaining = st.data[1] ?? 0
      paid = st.data[2] ?? 0
      console.log(`   ...paid ${paid}, remaining ${remaining}`)
      if (remaining === 0) break
    }
    console.log(`\n✅ RESULT: ${paid} coin(s) dispensed from hopper ${ADDR}.`)
    if (paid < COINS) console.log('⚠  fewer coins than requested — likely empty or a jam.')
  } catch (e) {
    console.log('\n❌ FAILED:', e.message)
    console.log('   Checks: right port? hopper DIP address matches? board jumpers = USB→ccTalk? power on?')
  } finally {
    port.close(() => process.exit(0))
  }
})()
