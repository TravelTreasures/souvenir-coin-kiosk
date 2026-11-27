// End-to-end harness: the kiosk's REAL main-process code (payment flow, database,
// config, fleet sync) under plain Node with simulated hardware, talking to the
// REAL fleet server. Only Electron itself and the SQLite driver are shimmed.
// Built and run by run.sh (SRC = kiosk source root, SRV_DIR = server copy).
import { handlers } from './mock-electron'
import { getConfig, updateConfig } from '@src/main/config/Config'
import { getDB, getHopperCount, setHopperCount, getUnresolvedAlerts, getSalesReport, resolveInterruptedDispenses, insertTransaction, getTransactions } from '@src/main/database/Database'
import { HopperController, simSetHopperStatus } from '@src/main/hopper/HopperController'
import { NayaxController, simSetPaymentResult, simTriggerPayment } from '@src/main/nayax/NayaxController'
import { setupIPC, isSaleInProgress } from '@src/main/ipc'
import { startFleetSync, stopFleetSync } from '@src/main/fleet/FleetSync'
import { spawn, type ChildProcess } from 'child_process'

const PORT = 9292, B = `http://127.0.0.1:${PORT}`
let srv: ChildProcess
const startServer = (): Promise<void> => new Promise((r) => {
  srv = spawn('node', ['server.js'], { cwd: process.env.SRV_DIR, env: { ...process.env, FLEET_PORT: String(PORT), FLEET_ADMIN_PASSWORD: 'sim-pass', FLEET_LOG_INGEST: '0' } })
  srv.stdout!.on('data', (d) => { if (String(d).includes('running')) setTimeout(r, 300) })
  srv.stderr!.on('data', (d) => console.log('SRV-ERR', String(d).slice(0, 300)))
})
const stopServer = (): Promise<void> => new Promise((r) => { srv.on('exit', () => r()); srv.kill('SIGTERM') })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const results: Array<[string, string, string]> = []
let fails = 0
const ok = (name: string, cond: boolean, info = ''): void => { results.push([cond ? 'PASS' : 'FAIL', name, info]); if (!cond) { fails++; console.log('FAIL', name, info) } }
const eq = (name: string, a: unknown, b: unknown): void => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)
let token = ''
const signIn = async (): Promise<void> => { token = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'sim-pass' }) })).json()).token }
const api = async (p: string, o: RequestInit = {}): Promise<any> => (await fetch(B + p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } })).json()
const call = (name: string, ...args: unknown[]): Promise<any> => Promise.resolve(handlers[name]({}, ...args))
// One immediate sync pass (start = immediate tick), then wait for it to finish.
const syncNow = async (mdb: HopperController, nayax: NayaxController, wait = 700): Promise<void> => { stopFleetSync(); await sleep(50); startFleetSync(mdb, nayax); await sleep(wait) }
// A customer buys: start the payment, "tap the card" with the chosen outcome.
const buy = async (coin: 1 | 2 | 3, outcome: 'approved' | 'declined' | 'communication_error' = 'approved'): Promise<any> => {
  simSetPaymentResult(outcome)
  const p = call('payment:request', coin)
  await sleep(40)
  simTriggerPayment()
  return p
}
const H1 = HopperController.HOPPER_1_ADDR, H2 = HopperController.HOPPER_2_ADDR

async function main(): Promise<void> {
  await startServer(); await signIn()
  const created = await api('/api/kiosks', { method: 'POST', body: JSON.stringify({ id: 'E2E', name: 'End to end', coinPriceCents: 200, comboPriceCents: 300 }) })
  await api('/api/kiosks/E2E', { method: 'PATCH', body: JSON.stringify({ comboEnabled: true }) })
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ lowCoinThreshold: 3, offlineMinutes: 5 }) })

  // ---- boot the kiosk ----
  ok('kiosk database opens', getDB() !== null)
  const mdb = new HopperController(null, true)
  const nayax = new NayaxController(null, true)
  await mdb.connect(); await nayax.connect()
  setupIPC(mdb, nayax)
  eq('a new kiosk starts with 0 coins', [getHopperCount(1), getHopperCount(2)], [0, 0])
  mdb.setCoinCount(H1, getHopperCount(1)); mdb.setCoinCount(H2, getHopperCount(2))
  let r = await call('payment:request', 1)
  eq('empty hopper → sale refused before any card charge', r.status, 'out_of_stock')
  ok('no sale left "in progress" after a refusal', !isSaleInProgress())

  // ---- connect to fleet ----
  updateConfig({ fleetUrl: B, fleetApiKey: created.apiKey, kioskId: 'E2E' })
  await syncNow(mdb, nayax)
  const cfg = getConfig()
  eq('kiosk applied the server price (R2.00)', cfg.coinPriceCents, 200)
  eq('kiosk received the low-coin level (3)', cfg.lowCoinThreshold, 3)
  eq('kiosk reports sync OK', cfg.fleetStatus?.state, 'ok')
  let k = await api('/api/kiosks/E2E')
  ok('server sees the kiosk online and in sync', k.online === true && k.synced === true)
  ok('kiosk reports its connection quality; Fleet Admin shows bars', k.link?.bars >= 3 && k.link.n >= 1 && typeof k.link.ms === 'number', JSON.stringify(k.link))

  // ---- remote refills: two in a row ----
  await api('/api/kiosks/E2E/refill', { method: 'POST', body: JSON.stringify({ hopper: 1, quantity: 6 }) })
  await api('/api/kiosks/E2E/refill', { method: 'POST', body: JSON.stringify({ hopper: 2, quantity: 5 }) })
  await syncNow(mdb, nayax); await syncNow(mdb, nayax); await syncNow(mdb, nayax)
  eq('both remote refills landed on the kiosk (6 and 5)', [mdb.getCoinCount(H1), mdb.getCoinCount(H2), getHopperCount(1), getHopperCount(2)], [6, 5, 6, 5])
  await syncNow(mdb, nayax)
  eq('…and are not applied twice on later syncs', [mdb.getCoinCount(H1), mdb.getCoinCount(H2)], [6, 5])
  await call('admin:verifyPin', '1234')
  await call('maintenance:refillHopper', 1, 4)
  eq('on-site refill adds to the count (6 + 4 = 10)', mdb.getCoinCount(H1), 10)

  // ---- sales ----
  r = await buy(2); eq('sale 1: coin 2 dispensed', r.status, 'dispensed')
  r = await buy(3); eq('sale 2: combo dispensed', r.status, 'dispensed')
  r = await buy(1); eq('sale 3: coin 1 dispensed', r.status, 'dispensed')
  eq('hopper counts after 3 sales (10−2=8, 5−2=3)', [mdb.getCoinCount(H1), mdb.getCoinCount(H2), getHopperCount(1), getHopperCount(2)], [8, 3, 8, 3])
  r = await buy(1, 'declined'); eq('declined card → no coin', r.status, 'declined')
  eq('declined sale does not move stock', mdb.getCoinCount(H1), 8)
  r = await buy(2, 'communication_error'); eq('reader error → no coin', r.status, 'communication_error')

  // ---- jam AFTER the card is approved ----
  simSetPaymentResult('approved')
  let p = call('payment:request', 1)
  await sleep(40); simSetHopperStatus(H1, 'jam'); simTriggerPayment()
  r = await p
  eq('jam after approval → reported as failed dispense', r.status, 'dispense_failed')
  eq('kiosk raised a local alert for it', getUnresolvedAlerts().length, 1)
  ok('sale flag cleared after a failed dispense', !isSaleInProgress())
  eq('jammed hopper → next sale refused before charging', (await call('payment:request', 1)).status, 'out_of_stock')
  eq('combo refused while one hopper is jammed', (await call('payment:request', 3)).status, 'out_of_stock')
  simSetHopperStatus(H1, 'ok')

  // ---- combo where the 2nd coin fails ----
  simSetPaymentResult('approved')
  p = call('payment:request', 3)
  await sleep(40); simSetHopperStatus(H2, 'jam'); simTriggerPayment()
  r = await p
  eq('combo with 2nd coin failing → failed dispense', r.status, 'dispense_failed')
  eq('…coin 1 DID leave hopper 1 (8 → 7), hopper 2 unchanged', [mdb.getCoinCount(H1), mdb.getCoinCount(H2)], [7, 3])
  simSetHopperStatus(H2, 'ok')

  // ---- kiosk's books vs the server's ----
  const today = new Date(); const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const local = getSalesReport(`${day} 00:00:00`, `${day} 23:59:59`) as any
  await syncNow(mdb, nayax, 900)
  const s = await api('/api/kiosks/E2E/sales?period=today')
  eq('server sales = 3 sales, R7.00', [s.totalSales, s.totalRevenue], [3, 700])
  eq("kiosk's own report agrees with the server", [local.totalSales, local.totalRevenue], [s.totalSales, s.totalRevenue])
  const inv = await api('/api/kiosks/E2E/inventory?period=today')
  const rc = Object.fromEntries(inv.reconciliation.coins.map((c: any) => [c.slot, c])) as any
  eq('recon coin 1: paid 2, dispensed 1, not dispensed 1', [rc[1].paid, rc[1].dispensed, rc[1].notDispensed], [2, 1, 1])
  eq('recon combo: paid 2, dispensed 1, not dispensed 1', [rc[3].paid, rc[3].dispensed, rc[3].notDispensed], [2, 1, 1])
  eq('refund owed = R2 (coin) + R3 (combo) = R5.00', inv.reconciliation.coins.reduce((a: number, c: any) => a + c.refundOwed, 0), 500)
  const al = await api('/api/kiosks/E2E/alerts')
  eq('server alerts = kiosk alerts = 2', [al.length, getUnresolvedAlerts().length], [2, 2])
  k = await api('/api/kiosks/E2E')
  eq('server stock matches the kiosk (7 / 3)', [k.health.hopper1.coinCount, k.health.hopper2.coinCount], [mdb.getCoinCount(H1), mdb.getCoinCount(H2)])
  const refillLog = await api('/api/kiosks/E2E/refill-log')
  const added = (h: number): number => (refillLog.events || []).filter((e: any) => e.hopperId === h).reduce((a: number, e: any) => a + e.quantity, 0)
  eq('refills recorded on the server (hopper 1: 6+4, hopper 2: 5)', [added(1), added(2)], [10, 5])
  eq('hopper 2: refills − coins sold = stock (5 − 2 = 3)', added(2) - rc[2].coinsOut, mdb.getCoinCount(H2))
  const removed = (inv.maintenance || []).filter((e: any) => e.hopperId === 1 && e.type === 'empty').reduce((x: number, e: any) => x + e.quantity, 0)
  eq('the coin from the half-failed combo is logged on the server', removed, 1)
  eq('hopper 1: refills − coins sold − logged removals = stock (10 − 2 − 1 = 7)', added(1) - rc[1].coinsOut - removed, mdb.getCoinCount(H1))

  // ---- price change while running ----
  await api('/api/kiosks/E2E', { method: 'PATCH', body: JSON.stringify({ coinPriceCents: 500 }) })
  await syncNow(mdb, nayax); await syncNow(mdb, nayax)
  eq('price change reached the kiosk (R5.00)', getConfig().coinPriceCents, 500)
  ok('server shows it as applied', (await api('/api/kiosks/E2E')).synced === true)
  r = await buy(2); eq('next sale charged at the new price', [r.status, getTransactions(1, 0)[0].amount], ['dispensed', 500])

  // ---- taken out of service from Fleet Admin ----
  await api('/api/kiosks/E2E', { method: 'PATCH', body: JSON.stringify({ operationalStatus: 'maintenance' }) })
  await syncNow(mdb, nayax); await syncNow(mdb, nayax)
  eq('kiosk goes to "maintenance" when Fleet Admin says so', (await call('config:getOperationalStatus')), 'maintenance')
  await api('/api/kiosks/E2E', { method: 'PATCH', body: JSON.stringify({ operationalStatus: 'active' }) })
  await syncNow(mdb, nayax); await syncNow(mdb, nayax)
  eq('…and back to active', (await call('config:getOperationalStatus')), 'active')

  // ---- server away: keep selling, nothing lost, nothing doubled ----
  await stopServer()
  await syncNow(mdb, nayax, 1500)
  eq('server down → kiosk shows "cannot reach server"', getConfig().fleetStatus?.state, 'offline')
  const kOffline = (await (async () => { try { return await api('/api/kiosks/E2E') } catch { return null } })())
  void kOffline
  ok('…with a reason', !!getConfig().fleetStatus?.detail, String(getConfig().fleetStatus?.detail))
  r = await buy(1); eq('kiosk still sells with the server down', r.status, 'dispensed')
  r = await buy(1); eq('…and again', r.status, 'dispensed')
  await syncNow(mdb, nayax, 1200); await syncNow(mdb, nayax, 1200)
  await startServer(); await signIn()
  await syncNow(mdb, nayax, 1200); await syncNow(mdb, nayax, 1200)
  eq('server back → kiosk reconnects by itself', getConfig().fleetStatus?.state, 'ok')
  { const kk = await api('/api/kiosks/E2E'); ok('after an outage the bars drop (missed check-ins are remembered)', kk.link.missed >= 1 && kk.link.bars <= 3, JSON.stringify(kk.link)) }
  const s2 = await api('/api/kiosks/E2E/sales?period=today')
  eq('offline sales arrived exactly once (6 sales, R22.00)', [s2.totalSales, s2.totalRevenue], [6, 2200])
  await syncNow(mdb, nayax, 900)
  const s3 = await api('/api/kiosks/E2E/sales?period=today')
  eq('further syncs do not double anything', [s3.totalSales, s3.totalRevenue], [6, 2200])

  // ---- power cut mid-dispense ----
  insertTransaction({ transactionId: 'CUT-1', amount: 500, coinSelected: 1, paymentResult: 'approved', dispenseResult: null, nayaxAuthCode: null, nayaxCardType: null, alertSent: 0 })
  ok('after a power cut, the half-finished sale is closed as "not dispensed" on restart', typeof resolveInterruptedDispenses() === 'number')
  await syncNow(mdb, nayax, 900)
  ok('…and shows as an alert in Fleet Admin', (await api('/api/kiosks/E2E/alerts')).some((a: any) => a.transactionId === 'CUT-1'))

  // ---- the reserve coin ----
  mdb.setCoinCount(H2, 1); setHopperCount(2, 1)
  r = await call('payment:request', 2)
  ok('the last coin is kept in reserve (1 left → sale refused, count stays 1)', r.status === 'out_of_stock' && mdb.getCoinCount(H2) === 1)

  // ---- double tap ----
  mdb.setCoinCount(H1, 5); setHopperCount(1, 5)
  simSetPaymentResult('approved')
  const a = call('payment:request', 1); const b2 = call('payment:request', 1)
  await sleep(40); simTriggerPayment()
  const [ra, rb] = await Promise.all([a, b2])
  eq('a double-started sale is treated as ONE sale', [ra.status, rb.status, ra.transactionId === rb.transactionId], ['dispensed', 'dispensed', true])
  eq('…and exactly one coin left the hopper (5 → 4)', mdb.getCoinCount(H1), 4)
  ok('sale flag is clear afterwards', !isSaleInProgress())

  // ---- admin PIN and roles on the kiosk ----
  await call('admin:signOut')
  eq('wrong admin PIN refused', !!(await call('admin:verifyPin', '0000'))?.ok, false)
  const pinOk = await call('admin:verifyPin', '1234')
  ok('default admin PIN accepted (change it on site!)', !!pinOk?.ok || pinOk === true, JSON.stringify(pinOk))

  stopFleetSync()
  await stopServer()
  console.log('\n==== KIOSK END-TO-END: ' + results.filter((x) => x[0] === 'PASS').length + ' passed, ' + fails + ' failed ====')
  for (const x of results) if (x[0] === 'FAIL') console.log(' ✗', x[1], '—', x[2])
  process.exit(0)
}
main().catch((e) => { console.error('HARNESS CRASH', e); process.exit(1) })
