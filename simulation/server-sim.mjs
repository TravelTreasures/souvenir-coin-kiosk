// Fleet Admin server simulation: the REAL server with five simulated kiosks.
// Usage: SRV_DIR=<copy of fleet-admin without data/> node server-sim.mjs
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
const SRV_DIR = process.env.SRV_DIR
const PORT = 9191, B = `http://127.0.0.1:${PORT}`
let srv
const start = () => new Promise((r) => { srv = spawn('node', ['server.js'], { cwd: SRV_DIR, env: { ...process.env, FLEET_PORT: PORT, FLEET_ADMIN_PASSWORD: 'sim-pass', FLEET_LOG_INGEST: '0' } }); srv.stdout.on('data', (d) => { if (String(d).includes('running')) setTimeout(r, 300) }); srv.stderr.on('data', (d) => console.log('SRV-ERR', String(d).slice(0, 400))) })
const stop = () => new Promise((r) => { srv.on('exit', r); srv.kill('SIGTERM') })
const results = []; let fails = 0
const ok = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); if (!cond) { fails++; console.log('FAIL', name, info) } }
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)
let token = ''
const api = async (p, o = {}, t = token, ip = '10.0.0.1') => { const r = await fetch(B + p, { ...o, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(o.headers || {}) } }); let j = null; try { j = await r.json() } catch {}; return { s: r.status, j, h: r.headers } }
const kio = async (key, p, body) => { const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Key': key }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json() } catch {}; return { s: r.status, j } }
const pad = (n) => String(n).padStart(2, '0')
const ts = (off = 0) => { const d = new Date(Date.now() + off * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hb = (o = {}) => ({ appVersion: '1.21.38', appliedConfigVersion: 1, appliedRefillVersion: 0, coinPriceCents: 200, mdbConnected: true, nayaxConnected: true, hopper1: { status: 'ok', coinCount: 200 }, hopper2: { status: 'ok', coinCount: 200 }, updateStatus: 'idle', updateError: '', ...o })
const login = (u, p, ip) => api('/api/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) }, '', ip)
const J = (o) => JSON.stringify(o)

await start()
// ---------- 1. sign-in and web safety ----------
ok('no token → 401', (await api('/api/kiosks', {}, '')).s === 401)
ok('wrong password → 401', (await login('admin', 'x', '10.9.9.9')).s === 401)
let r = await login('admin', 'sim-pass', '10.0.0.1')
ok('admin login', r.s === 200 && !!r.j.token); token = r.j.token
let last; for (let i = 0; i < 6; i++) last = await login('admin', 'bad' + i, '10.7.7.7')
ok('6 wrong tries from one address → locked (429)', last.s === 429, `status ${last.s}`)
ok('other address still can log in', (await login('admin', 'sim-pass', '10.0.0.2')).s === 200)
const page = await fetch(B + '/'); ok('dashboard page served', page.status === 200); ok('CSP header on page', !!page.headers.get('content-security-policy'))
const trav = await fetch(B + '/..%2f..%2fserver.js'); ok('encoded traversal does not leak server code', !(await trav.text()).includes('FLEET_ADMIN_PASSWORD'), `status ${trav.status}`)
const trav2 = await fetch(B + '/files/..%2ffleet.json'); ok('image folder cannot be used to read the data file', !(await trav2.text()).includes('"kiosks"'), `status ${trav2.status}`)
const dataLeak = await fetch(B + '/data/fleet.json'); ok('data file not downloadable', !(await dataLeak.text()).includes('"kiosks"'), `status ${dataLeak.status}`)
const huge = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"' + 'a'.repeat(30_000_000) + '"}' }).then((x) => x.status).catch(() => 'closed')
ok('a 30 MB request body is refused, not swallowed', huge !== 200 && huge !== 401, `status ${huge}`)
ok('server still answers after that', (await api('/api/kiosks')).s === 200)
const bad = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' }).then((x) => x.status)
ok('broken JSON does not crash the server', bad >= 400 && bad < 600 && (await api('/api/kiosks')).s === 200, `status ${bad}`)

// ---------- 2. kiosks and config ----------
const keys = {}
for (const id of ['K1', 'K2', 'K3', 'K4', 'K5']) { r = await api('/api/kiosks', { method: 'POST', body: J({ id, name: 'Kiosk ' + id, location: 'Sim', coinPriceCents: 200, comboPriceCents: 300 }) }); ok('create ' + id, r.s === 201 && !!r.j.apiKey); keys[id] = r.j.apiKey }
ok('duplicate kiosk id → 409', (await api('/api/kiosks', { method: 'POST', body: J({ id: 'K1', name: 'x' }) })).s === 409)
ok('bad kiosk key → 401', (await kio('kk_bad', '/api/ingest/config')).s === 401)
r = await kio(keys.K1, '/api/ingest/config'); ok('config pull', r.s === 200 && r.j.coinPriceCents === 200); ok('config carries lowCoinThreshold', typeof r.j.lowCoinThreshold === 'number')
const v0 = r.j.configVersion
await api('/api/kiosks/K1', { method: 'PATCH', body: J({ coinPriceCents: 250, comboEnabled: true }) })
r = await kio(keys.K1, '/api/ingest/config'); ok('price change bumps config version', r.j.configVersion > v0 && r.j.coinPriceCents === 250 && r.j.combo.enabled === true)
const v1 = r.j.configVersion
await kio(keys.K1, '/api/ingest/heartbeat', hb({ appliedConfigVersion: v0, coinPriceCents: 200 }))
r = await api('/api/kiosks/K1'); ok('pending while kiosk has not applied (price not reverted)', r.j.synced === false && r.j.coinPriceCents === 250)
await kio(keys.K1, '/api/ingest/heartbeat', hb({ appliedConfigVersion: v1, coinPriceCents: 250 }))
r = await api('/api/kiosks/K1'); ok('synced after kiosk applies', r.j.synced === true && r.j.online === true)
await kio(keys.K1, '/api/ingest/heartbeat', hb({ appliedConfigVersion: v1, coinPriceCents: 200 }))
r = await api('/api/kiosks/K1'); ok('on-site price change flows back to dashboard', r.j.coinPriceCents === 200)
r = await api('/api/kiosks/K1', { method: 'PATCH', body: J({ coinPriceCents: -500 }) }); r = await api('/api/kiosks/K1'); ok('a negative price cannot be set', r.j.coinPriceCents >= 0, `price=${r.j.coinPriceCents}`)
await api('/api/kiosks/K1', { method: 'PATCH', body: J({ coinPriceCents: 200 }) })
r = await kio(keys.K1, '/api/ingest/config'); await kio(keys.K1, '/api/ingest/heartbeat', hb({ appliedConfigVersion: r.j.configVersion }))

// ---------- 3. sales math ----------
const T = (id, coin, amount, pay, disp, off = 0) => ({ transactionId: id, amount, coinSelected: coin, paymentResult: pay, dispenseResult: disp, createdAt: ts(off) })
const batch = [T('TX-1', 2, 200, 'approved', 'success', -50), T('TX-2', 3, 300, 'approved', 'success', -40), T('TX-3', 1, 200, 'approved', 'success', -30),
  T('TX-4', 1, 200, 'approved', 'unknown_error', -25), T('TX-5', 2, 200, 'declined', null, -20), T('TX-6', 1, 200, 'cancelled_timeout', null, -15),
  T('TX-7', 3, 300, 'approved', 'hopper_empty', -10), T('TX-8', 2, 200, 'approved', null, -5)]
const ev = [{ srcId: 1, hopperId: 1, type: 'refill', quantity: 50, oldStock: 0, newStock: 50, operator: 'Sim', operatorRole: 'office', createdAt: ts(-60) }]
r = await kio(keys.K1, '/api/ingest/sync', { transactions: batch, hopperEvents: ev })
ok('sync accepted 8 tx', r.s === 200 && r.j.added === 8 && r.j.hopperEventsAdded === 1, J(r.j))
r = await kio(keys.K1, '/api/ingest/sync', { transactions: batch, hopperEvents: ev })
ok('re-sending same data adds nothing (no double counting)', r.j.added === 0 && r.j.hopperEventsAdded === 0, J(r.j))
let s = (await api('/api/kiosks/K1/sales?period=today')).j
eq('sales: totals (3 sales, R7.00)', [s.totalSales, s.totalRevenue], [3, 700])
eq('sales: per item', [s.coin1Sales, s.coin2Sales, s.comboSales, s.coin1Revenue, s.coin2Revenue, s.comboRevenue], [1, 1, 1, 200, 200, 300])
eq('sales: coins dispensed per hopper', [s.coin1Units, s.coin2Units], [2, 2])
ok('sales: parts add up to total', s.coin1Sales + s.coin2Sales + s.comboSales === s.totalSales && s.coin1Revenue + s.coin2Revenue + s.comboRevenue === s.totalRevenue)
let inv = (await api('/api/kiosks/K1/inventory?period=today')).j
let rc = Object.fromEntries(inv.reconciliation.coins.map((c) => [c.slot, c]))
eq('recon coin1: paid 2 / dispensed 1 / not dispensed 1 / refund R2', [rc[1].paid, rc[1].dispensed, rc[1].notDispensed, rc[1].refundOwed], [2, 1, 1, 200])
eq('recon coin2: paid 2 / dispensed 1 / not dispensed 1 / refund R2', [rc[2].paid, rc[2].dispensed, rc[2].notDispensed, rc[2].refundOwed], [2, 1, 1, 200])
eq('recon combo: paid 2 / dispensed 1 / not dispensed 1 / refund R3', [rc[3].paid, rc[3].dispensed, rc[3].notDispensed, rc[3].refundOwed], [2, 1, 1, 300])
const sum = (k) => inv.reconciliation.coins.reduce((a, c) => a + c[k], 0)
ok('recon: paid − refund owed = sales revenue', sum('paidRevenue') - sum('refundOwed') === s.totalRevenue)
ok('recon: dispensed count = sales count', sum('dispensed') === s.totalSales)
eq('recon: coins out per hopper match sales card', [rc[1].coinsOut, rc[2].coinsOut], [s.coin1Units, s.coin2Units])
eq('recon: refill of 50 shown on hopper 1', rc[1].refillsAdded, 50)
let al = (await api('/api/kiosks/K1/alerts')).j
ok('alerts count = reconciliation "not dispensed" (3)', al.length === sum('notDispensed'), `alerts=${al.length} notDispensed=${sum('notDispensed')}`)
await kio(keys.K1, '/api/ingest/sync', { transactions: [T('TX-8', 2, 200, 'approved', 'success', -5)], hopperEvents: [] })
s = (await api('/api/kiosks/K1/sales?period=today')).j; eq('late dispense result fills in (4 sales, R9.00)', [s.totalSales, s.totalRevenue], [4, 900])
al = (await api('/api/kiosks/K1/alerts')).j; ok('no alert left for the sale that turned out fine', !al.some((a) => a.transactionId === 'TX-8'))
await kio(keys.K1, '/api/ingest/sync', { transactions: [T('TX-9', 1, 200, 'approved', null, -3)], hopperEvents: [] })
await kio(keys.K1, '/api/ingest/sync', { transactions: [T('TX-9', 1, 200, 'approved', 'jam', -3)], hopperEvents: [] })
al = (await api('/api/kiosks/K1/alerts')).j; ok('late failure raises exactly one alert, with the real reason', al.filter((a) => a.transactionId === 'TX-9').length === 1 && al.find((a) => a.transactionId === 'TX-9')?.dispenseResult === 'jam')
await kio(keys.K1, '/api/ingest/sync', { transactions: [T('TX-4', 1, 200, 'approved', 'success', -25)], hopperEvents: [] })
inv = (await api('/api/kiosks/K1/inventory?period=today')).j
ok('a recorded failure cannot be flipped to success by a re-send', inv.reconciliation.coins.find((c) => c.slot === 1).dispensed === 1)
await api('/api/alerts/resolve', { method: 'POST', body: J({ transactionId: 'TX-4', kioskId: 'K1' }) })
al = (await api('/api/kiosks/K1/alerts')).j; ok('resolve removes the alert', !al.some((a) => a.transactionId === 'TX-4'))
await kio(keys.K1, '/api/ingest/sync', { transactions: [T('<img src=x onerror=alert(1)>', 1, 200, 'approved', 'success', -2)], hopperEvents: [] })
ok('transaction ids are cleaned of code characters', !J((await api('/api/kiosks/K1/transactions')).j).includes('<img'))
await kio(keys.K1, '/api/ingest/sync', { transactions: [{ transactionId: 'BAD-1', amount: 'abc', coinSelected: 1, paymentResult: 'approved', dispenseResult: 'success', createdAt: ts(-1) }, { transactionId: 'BAD-2', amount: -500, coinSelected: 1, paymentResult: 'approved', dispenseResult: 'success', createdAt: ts(-1) }, null, 'junk', 42], hopperEvents: [null, { srcId: 'x' }] })
s = (await api('/api/kiosks/K1/sales?period=today')).j
ok('garbage records cannot corrupt revenue', typeof s.totalRevenue === 'number' && Number.isFinite(s.totalRevenue) && s.totalRevenue >= 900, `revenue=${J(s.totalRevenue)}`)
inv = (await api('/api/kiosks/K1/inventory?period=today')).j
ok('inventory page data still valid after garbage', Array.isArray(inv.hoppers) && Array.isArray(inv.maintenance))
s = (await api('/api/kiosks/K2/sales?period=today')).j; eq('kiosk 2 unaffected by kiosk 1 sales', [s.totalSales, s.totalRevenue], [0, 0])
await kio(keys.K2, '/api/ingest/sync', { transactions: [T('TX-1', 1, 200, 'approved', 'success', -9), T('TX-4', 1, 200, 'approved', 'jam', -8)], hopperEvents: [] })
s = (await api('/api/kiosks/K2/sales?period=today')).j; eq('same transaction id on another kiosk still counted there', [s.totalSales], [1])
await api('/api/alerts/resolve', { method: 'POST', body: J({ transactionId: 'TX-7', kioskId: 'K2' }) })
al = (await api('/api/kiosks/K1/alerts')).j; ok("resolving on kiosk 2 does not close kiosk 1's alert", al.some((a) => a.transactionId === 'TX-7'))
const g = (await api('/api/reports/global?period=today')).j
const k1 = (await api('/api/kiosks/K1/sales?period=today')).j
ok('fleet report = sum of kiosks', g.totalSales === k1.totalSales + s.totalSales && g.totalRevenue === k1.totalRevenue + s.totalRevenue, J({ g: [g.totalSales, g.totalRevenue], k1: [k1.totalSales, k1.totalRevenue], k2: [s.totalSales, s.totalRevenue] }))
const list2 = (await api('/api/kiosks')).j; const c1 = list2.find((k) => k.id === 'K1')
ok('fleet card "sales today" matches Sales tab', c1.salesToday === k1.totalSales)
ok('fleet card open alerts matches Alerts tab', c1.openAlerts === al.length, `${c1.openAlerts} vs ${al.length}`)
const tsr = (await api('/api/kiosks/K1/timeseries?days=7')).j
ok('daily chart total = sales total', tsr.reduce((a, d) => a + d.sales, 0) === k1.totalSales && tsr.reduce((a, d) => a + d.revenue, 0) === k1.totalRevenue)

// ---------- 4. remote refill ----------
r = await api('/api/kiosks/K1/refill', { method: 'POST', body: J({ hopper: 2, quantity: 120 }) }); ok('remote refill accepted', r.s === 201)
r = await kio(keys.K1, '/api/ingest/config'); ok('refill command reaches kiosk', r.j.refill.quantity === 120 && r.j.refill.hopper === 2 && r.j.refill.version === 1)
await kio(keys.K1, '/api/ingest/heartbeat', hb({ appliedConfigVersion: r.j.configVersion, appliedRefillVersion: 1 }))
r = await kio(keys.K1, '/api/ingest/config'); ok('refill command cleared after kiosk confirms', r.j.refill.quantity === 0)
ok('refill of 0 rejected', (await api('/api/kiosks/K1/refill', { method: 'POST', body: J({ hopper: 1, quantity: 0 }) })).s === 400)
await api('/api/kiosks/K3/refill', { method: 'POST', body: J({ hopper: 1, quantity: 100 }) })
await api('/api/kiosks/K3/refill', { method: 'POST', body: J({ hopper: 2, quantity: 50 }) })
r = await kio(keys.K3, '/api/ingest/config'); eq('two quick refills: kiosk gets the FIRST one first', [r.j.refill.hopper, r.j.refill.quantity, r.j.refill.version], [1, 100, 1])
await kio(keys.K3, '/api/ingest/heartbeat', hb({ appliedConfigVersion: r.j.configVersion, appliedRefillVersion: 1 }))
r = await kio(keys.K3, '/api/ingest/config'); eq('…then the second one, nothing lost', [r.j.refill.hopper, r.j.refill.quantity, r.j.refill.version], [2, 50, 2])
await kio(keys.K3, '/api/ingest/heartbeat', hb({ appliedConfigVersion: r.j.configVersion, appliedRefillVersion: 2 }))
r = await kio(keys.K3, '/api/ingest/config'); ok('queue empty afterwards', r.j.refill.quantity === 0)

// ---------- 5. roles ----------
await api('/api/users', { method: 'POST', body: J({ username: 'view1', password: 'viewer-pass-1', role: 'viewer' }) })
const vt = (await login('view1', 'viewer-pass-1', '10.0.0.3')).j?.token
ok('viewer can read', (await api('/api/kiosks', {}, vt)).s === 200)
ok('viewer cannot change price', (await api('/api/kiosks/K1', { method: 'PATCH', body: J({ coinPriceCents: 1 }) }, vt)).s === 403)
ok('viewer cannot send refill', (await api('/api/kiosks/K1/refill', { method: 'POST', body: J({ hopper: 1, quantity: 5 }) }, vt)).s === 403)
ok('viewer cannot create users', (await api('/api/users', { method: 'POST', body: J({ username: 'h', password: 'hhhhhhhh', role: 'admin' }) }, vt)).s === 403)
await api('/api/alerts/resolve', { method: 'POST', body: J({ transactionId: 'TX-7' }) }, vt)
al = (await api('/api/kiosks/K1/alerts')).j; ok('viewer cannot resolve payment alerts', al.some((a) => a.transactionId === 'TX-7'))
ok('viewer cannot acknowledge system alerts', (await api('/api/system-alerts/ack', { method: 'POST', body: J({ id: 1 }) }, vt)).s === 403)
const vk = (await api('/api/kiosks/K1', {}, vt)).j; ok('viewer cannot see kiosk API key / admin PIN', !vk.apiKey && !vk.adminPin)
ok('viewer cannot download backup', (await api('/api/backup', {}, vt)).s === 403)
await api('/api/operators', { method: 'POST', body: J({ name: 'Op One', pin: '4321', role: 'operator' }) })
const vo2 = await api('/api/operators', {}, vt); ok('viewer cannot read operator PINs', vo2.s === 403 || !J(vo2.j).includes('4321'), `status ${vo2.s}`)
ok('viewer cannot deploy an update', (await api('/api/ota/deploy', { method: 'POST', body: J({ version: '9.9.9', all: true }) }, vt)).s === 403)
ok('viewer cannot regenerate a kiosk key', (await api('/api/kiosks/K1/regenerate', { method: 'POST' }, vt)).s === 403)
ok('viewer cannot delete a kiosk', (await api('/api/kiosks/K5', { method: 'DELETE' }, vt)).s === 403)
const ot = (await api('/api/operator-login', { method: 'POST', body: J({ name: 'Op One', pin: '4321' }) }, '', '10.0.0.4')).j?.token
ok('operator login', !!ot)
ok('operator can send refill', (await api('/api/kiosks/K2/refill', { method: 'POST', body: J({ hopper: 1, quantity: 10 }) }, ot)).s === 201)
ok('operator cannot read sales', (await api('/api/kiosks/K1/sales', {}, ot)).s === 403)
ok('operator cannot change price', (await api('/api/kiosks/K1', { method: 'PATCH', body: J({ coinPriceCents: 1 }) }, ot)).s === 403)
const okk = (await api('/api/kiosks/K1', {}, ot)).j; ok('operator cannot see kiosk API key / admin PIN', !okk.apiKey && !okk.adminPin)
ok('kiosk list never exposes API keys', !J((await api('/api/kiosks', {}, ot)).j).includes('kk_'))
let lastOp; for (let i = 0; i < 7; i++) lastOp = await api('/api/operator-login', { method: 'POST', body: J({ name: 'Op One', pin: '000' + i }) }, '', '10.6.6.6')
ok('operator PIN guessing is locked out', lastOp.s === 429, `status ${lastOp.s}`)
ok('a kiosk key cannot be used as a staff login', (await api('/api/kiosks', {}, keys.K1)).s === 401)
ok("one kiosk's key cannot read another kiosk's config", (await kio(keys.K2, '/api/ingest/config')).j.configVersion !== undefined && (await kio(keys.K2, '/api/ingest/config')).j.coinPriceCents === 200)

// ---------- 6. app updates ----------
await api('/api/releases', { method: 'POST', body: J({ version: '1.21.39', channel: 'stable' }) })
r = await api('/api/ota/deploy', { method: 'POST', body: J({ version: '1.21.39', kioskIds: ['K4'], all: true }) }); ok('deploy accepted', r.s === 200, `status ${r.s}`)
const see = async () => { const x = (await api('/api/kiosks')).j.find((k) => k.id === 'K4'); return [x.currentVersion, x.targetVersion, x.updateStatus, !!x.lastUpdateAt] }
await kio(keys.K4, '/api/ingest/heartbeat', hb({ updateStatus: 'successful' })); eq('update: waiting shows "pending", not the old "successful"', await see(), ['1.21.38', '1.21.39', 'pending', false])
await kio(keys.K4, '/api/ingest/heartbeat', hb({ updateStatus: 'installing' })); eq('update: installing', (await see())[2], 'installing')
await kio(keys.K4, '/api/ingest/heartbeat', hb({ appVersion: '1.21.39', updateStatus: 'installing' })); eq('update: restarted on the new version → successful + time stamped', await see(), ['1.21.39', '1.21.39', 'successful', true])
r = await kio(keys.K4, '/api/ingest/config'); ok('kiosk is told the target version', r.j.ota?.targetVersion === '1.21.39', J(r.j.ota))

// ---------- 7. hardware alerts + network log ----------
await api('/api/settings', { method: 'PUT', body: J({ lowCoinThreshold: 30, offlineMinutes: 5 }) })
r = await kio(keys.K1, '/api/ingest/config'); ok('kiosk receives the new low-coin level (30) without a config bump', r.j.lowCoinThreshold === 30)
await kio(keys.K1, '/api/ingest/heartbeat', hb({ appliedConfigVersion: 99, hopper1: { status: 'empty', coinCount: 0 }, hopper2: { status: 'ok', coinCount: 12 } }))
await kio(keys.K2, '/api/ingest/heartbeat', hb({ mdbConnected: false, hopper1: { status: 'offline', coinCount: 80 }, hopper2: { status: 'offline', coinCount: 80 } }))
await kio(keys.K3, '/api/ingest/heartbeat', hb({ nayaxConnected: false, hopper1: { status: 'ok', coinCount: 1 } }))
await kio(keys.K4, '/api/ingest/heartbeat', hb({ appVersion: '1.21.39', hopper1: { status: 'jam', coinCount: 80 }, hopper2: { status: 'ok', coinCount: 31 } }))
await kio(keys.K5, '/api/ingest/heartbeat', hb())
r = await kio(keys.K5, '/api/ingest/net-log', { entries: [{ at: new Date().toISOString(), msg: 'back online after 111 min (12 repairs tried)' }, { at: 'x', msg: '<script>alert(1)</script>'.repeat(50) }, null] })
ok('network log accepted', r.s === 200 && r.j.stored === 3, J(r.j))
r = await api('/api/kiosks/K5/net-log'); ok('network log readable in Fleet Admin, entries length-limited', r.j.entries.length === 3 && r.j.entries[1].msg.length <= 300)
ok('operator cannot read the network log', (await api('/api/kiosks/K5/net-log', {}, ot)).s === 403)
console.log('… waiting for the once-a-minute fleet check'); await sleep(63000)
let sa = (await api('/api/system-alerts')).j; const ty = (id) => sa.filter((a) => a.kioskId === id).map((a) => a.type).sort()
eq('K1 empty hopper 1 + low hopper 2', ty('K1'), ['empty_1', 'low_coin_2'])
eq('K2 bus down = one alert, not three', ty('K2'), ['hopper_bus'])
eq('K3 card reader down + hopper 1 sold out at 1 coin (reserve)', ty('K3'), ['empty_1', 'nayax'])
eq('K4 hopper 1 jam; 31 coins is above level 30', ty('K4'), ['hopper_fault_1'])
eq('K5 healthy = no alerts', ty('K5'), [])
r = await api('/api/kiosks/K1'); eq('kiosk page carries its hardware alerts', (r.j.systemAlerts || []).map((a) => a.type).sort(), ['empty_1', 'low_coin_2'])
const st = (await api('/api/reports/global?period=today')).j; ok('nav badge count = open system alerts', st.systemAlerts === sa.length)
await kio(keys.K1, '/api/ingest/heartbeat', hb({ hopper1: { status: 'ok', coinCount: 20 }, hopper2: { status: 'ok', coinCount: 200 } }))
for (const k of ['K2', 'K3', 'K5']) await kio(keys[k], '/api/ingest/heartbeat', hb())
await kio(keys.K4, '/api/ingest/heartbeat', hb({ appVersion: '1.21.39' }))
console.log('… waiting for alerts to clear'); await sleep(63000)
sa = (await api('/api/system-alerts')).j
eq('K1 empty → low after partial refill', ty('K1'), ['low_coin_1'])
eq('all other alerts cleared by themselves', [ty('K2'), ty('K3'), ty('K4'), ty('K5')], [[], [], [], []])

// ---------- 8. load + persistence ----------
const big = []; for (let i = 0; i < 6000; i++) big.push(T('LOAD-' + i, (i % 3) + 1, (i % 3) === 2 ? 300 : 200, 'approved', 'success', -100 - i))
let t0 = Date.now(); for (let i = 0; i < big.length; i += 200) await kio(keys.K5, '/api/ingest/sync', { transactions: big.slice(i, i + 200), hopperEvents: [] }); const tSync = Date.now() - t0
t0 = Date.now(); for (let i = 0; i < 20; i++) await api('/api/kiosks'); const tList = (Date.now() - t0) / 20
t0 = Date.now(); for (let i = 0; i < 20; i++) await api('/api/kiosks/K5/inventory?period=today'); const tInv = (Date.now() - t0) / 20
t0 = Date.now(); for (let i = 0; i < 50; i++) await kio(keys.K5, '/api/ingest/heartbeat', hb()); const tHb = (Date.now() - t0) / 50
t0 = Date.now(); for (let i = 0; i < 30; i++) await kio(keys.K1, '/api/ingest/sync', { transactions: [T('ONE-' + i, 1, 200, 'approved', 'success', -1)], hopperEvents: [] }); const tOne = (Date.now() - t0) / 30
console.log(`timing: 6000 tx in 30 syncs ${tSync}ms · fleet list ${tList.toFixed(1)}ms · inventory ${tInv.toFixed(1)}ms · heartbeat ${tHb.toFixed(1)}ms · single-sale sync ${tOne.toFixed(1)}ms`)
ok('fleet list stays fast with 6000+ transactions (<150ms)', tList < 150, `${tList}ms`)
ok('a single-sale sync is fast (<150ms)', tOne < 150, `${tOne}ms`)
const before = (await api('/api/kiosks/K5/sales?period=all')).j
await stop()
const disk = JSON.parse(readFileSync(SRV_DIR + '/data/fleet.json', 'utf8'))
ok('data file valid after shutdown, all transactions on disk', disk.transactions.length >= 6000, `${disk.transactions.length}`)
ok('staff passwords are not stored in readable form', !JSON.stringify(disk.users).includes('sim-pass') && !JSON.stringify(disk.users).includes('viewer-pass-1'))
await start()
token = (await login('admin', 'sim-pass', '10.0.0.1')).j.token
const after = (await api('/api/kiosks/K5/sales?period=all')).j
eq('figures identical after a server restart', [after.totalSales, after.totalRevenue], [before.totalSales, before.totalRevenue])
ok('kiosk keys still valid after restart', (await kio(keys.K1, '/api/ingest/config')).s === 200)
ok('old staff session is gone after restart (must sign in again)', (await api('/api/kiosks', {}, vt)).s === 401)
await stop()
console.log('\n==== SERVER: ' + results.filter((x) => x[0] === 'PASS').length + ' passed, ' + fails + ' failed ====')
for (const x of results) if (x[0] === 'FAIL') console.log(' ✗', x[1], '—', x[2])
