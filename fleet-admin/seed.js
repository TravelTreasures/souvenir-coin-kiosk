/**
 * Seeds demo destinations, kiosks, heartbeats, transactions and alerts so the
 * dashboards are populated on first run. Safe to run repeatedly: it only seeds
 * when the store has no kiosks. Run via `npm run seed` or automatically by the
 * server on first start.
 */
import { randomBytes } from 'crypto'
import { load, save, data } from './store.js'

function key() {
  return 'kk_' + randomBytes(16).toString('hex')
}

function isoDaysAgo(days, hour = 12) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, Math.floor(Math.random() * 60), 0, 0)
  return d.toISOString().replace('T', ' ').substring(0, 19)
}

export function seedIfEmpty() {
  load()
  const db = data()
  if (db.kiosks.length > 0) return false

  const coins = (a, b) => [
    { slot: 1, label: a, priceCents: 9000 },
    { slot: 2, label: b, priceCents: 9000 }
  ]

  db.destinations = [
    { id: 'cape-town', name: 'Cape Town', coins: coins('Big Five', 'Cape Peninsula') },
    { id: 'kruger', name: 'Kruger National Park', coins: coins('Big Five', 'Leopard') },
    { id: 'jhb-airport', name: 'OR Tambo Airport', coins: coins('Big Five', 'Cape Peninsula') }
  ]

  // Per-site price: V&A Waterfront is R100, the rest R90 (matches the spec example).
  const k = (id, name, location, destinationId, status, ver, days, priceCents) => ({
    id, name, location, destinationId, apiKey: key(),
    operationalStatus: status, appVersion: ver, createdAt: isoDaysAgo(days),
    coinPriceCents: priceCents, configVersion: 1, appliedConfigVersion: 1
  })
  db.kiosks = [
    k('kiosk-001', 'V&A Waterfront — Gate 2', 'Cape Town, V&A Waterfront', 'cape-town', 'active', '1.5.1', 40, 10000),
    k('kiosk-002', 'Table Mountain Lower Cableway', 'Cape Town, Tafelberg Rd', 'cape-town', 'active', '1.5.1', 35, 9000),
    k('kiosk-003', 'Kruger — Skukuza Rest Camp', 'Kruger National Park, Skukuza', 'kruger', 'maintenance', '1.5.0', 20, 9000),
    k('kiosk-004', 'OR Tambo — Intl Arrivals', 'Johannesburg, OR Tambo', 'jhb-airport', 'active', '1.5.1', 15, 9000),
    k('kiosk-005', 'OR Tambo — Domestic', 'Johannesburg, OR Tambo', 'jhb-airport', 'out_of_service', '1.4.1', 10, 9000)
  ]

  const now = Date.now()
  const minsAgo = (m) => new Date(now - m * 60000).toISOString()
  db.heartbeats = {
    'kiosk-001': { lastSeen: minsAgo(0.5), hopper1: { status: 'ok', coinCount: 412 }, hopper2: { status: 'ok', coinCount: 388 }, mdbConnected: true, nayaxConnected: true, appVersion: '1.5.1' },
    'kiosk-002': { lastSeen: minsAgo(1), hopper1: { status: 'ok', coinCount: 96 }, hopper2: { status: 'empty', coinCount: 0 }, mdbConnected: true, nayaxConnected: true, appVersion: '1.5.1' },
    'kiosk-003': { lastSeen: minsAgo(180), hopper1: { status: 'ok', coinCount: 500 }, hopper2: { status: 'ok', coinCount: 500 }, mdbConnected: true, nayaxConnected: false, appVersion: '1.5.0' },
    'kiosk-004': { lastSeen: minsAgo(0.3), hopper1: { status: 'ok', coinCount: 230 }, hopper2: { status: 'jam', coinCount: 145 }, mdbConnected: true, nayaxConnected: true, appVersion: '1.5.1' },
    'kiosk-005': { lastSeen: minsAgo(2880), hopper1: { status: 'offline', coinCount: 0 }, hopper2: { status: 'offline', coinCount: 0 }, mdbConnected: false, nayaxConnected: false, appVersion: '1.4.1' }
  }

  // Transactions across the last 40 days for the active kiosks
  let tid = 1
  const tx = []
  const activeKiosks = ['kiosk-001', 'kiosk-002', 'kiosk-003', 'kiosk-004']
  for (const k of activeKiosks) {
    const count = 30 + Math.floor(Math.random() * 60)
    for (let i = 0; i < count; i++) {
      const day = Math.floor(Math.random() * 40)
      const coin = Math.random() < 0.5 ? 1 : 2
      const r = Math.random()
      let paymentResult = 'approved'
      let dispenseResult = 'success'
      if (r > 0.92) { paymentResult = 'declined'; dispenseResult = null }
      else if (r > 0.88) { paymentResult = 'approved'; dispenseResult = 'jam' } // critical alert
      tx.push({
        id: tid++,
        kioskId: k,
        transactionId: `SIM-${k}-${1000 + i}`,
        amount: 9000,
        coinSelected: coin,
        paymentResult,
        dispenseResult,
        createdAt: isoDaysAgo(day)
      })
    }
  }
  db.transactions = tx

  // Alerts = approved-but-not-dispensed
  let aid = 1
  db.alerts = tx
    .filter((t) => t.paymentResult === 'approved' && t.dispenseResult && t.dispenseResult !== 'success')
    .map((t) => ({ id: aid++, kioskId: t.kioskId, transactionId: t.transactionId, coinSelected: t.coinSelected, amount: t.amount, dispenseResult: t.dispenseResult, createdAt: t.createdAt, resolved: false }))

  db.maintenance = [
    { id: 1, kioskId: 'kiosk-003', note: 'Scheduled hopper service + firmware check', by: 'admin', createdAt: isoDaysAgo(2) },
    { id: 2, kioskId: 'kiosk-005', note: 'Reported offline — dispatched technician', by: 'admin', createdAt: isoDaysAgo(1) }
  ]

  save()
  return true
}

// Allow running directly: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const seeded = seedIfEmpty()
  console.log(seeded ? 'Seeded demo fleet data.' : 'Store already has kiosks — no seed performed.')
}
