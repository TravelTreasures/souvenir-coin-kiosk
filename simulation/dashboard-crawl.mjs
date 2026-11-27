// Dashboard crawl: load the REAL Fleet Admin page in a headless browser engine
// (jsdom), sign in, and open EVERY page and EVERY kiosk tab as admin, viewer and
// operator. Any script error, blank tab or button wired to a missing function
// fails the run. (A plain syntax check cannot catch those — twice a mangled
// line left tabs blank and only a real render would have shown it.)
// Usage: SRV_DIR=<copy of fleet-admin without data/> JSDOM=<path to jsdom> node dashboard-crawl.mjs
import { spawn } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { JSDOM, VirtualConsole } = require(process.env.JSDOM || 'jsdom')
const SRV_DIR = process.env.SRV_DIR
const PORT = 9595, B = `http://127.0.0.1:${PORT}`
let srv
const start = () => new Promise((r) => { srv = spawn('node', ['server.js'], { cwd: SRV_DIR, env: { ...process.env, FLEET_PORT: PORT, FLEET_ADMIN_PASSWORD: 'sim-pass', FLEET_LOG_INGEST: '0' } }); srv.stdout.on('data', (d) => { if (String(d).includes('running')) setTimeout(r, 300) }); srv.stderr.on('data', (d) => console.log('SRV-ERR', String(d).slice(0, 300))) })
const stop = () => new Promise((r) => { srv.on('exit', r); srv.kill('SIGTERM') })
const J = (o) => JSON.stringify(o)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pad = (n) => String(n).padStart(2, '0')
const ts = (off = 0) => { const d = new Date(Date.now() + off * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
const results = []; let fails = 0
const ok = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); if (!cond) { fails++; console.log('FAIL', name, info) } }

// ---------------- seed a realistic fleet ----------------
await start()
let token = (await (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ username: 'admin', password: 'sim-pass' }) })).json()).token
const api = async (p, o = {}) => (await fetch(B + p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } })).json()
const kio = async (key, p, body) => (await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kiosk-Key': key }, body: J(body) })).json()
const NASTY = `O'Brien <b>"Mall"</b> & Sons`
const k1 = await api('/api/kiosks', { method: 'POST', body: J({ id: 'K1', name: NASTY, location: `Gate "A" <i>1</i>`, coinPriceCents: 200, comboPriceCents: 300 }) })
const k2 = await api('/api/kiosks', { method: 'POST', body: J({ id: 'K2', name: 'Quiet kiosk', location: 'Sim' }) })
await api('/api/kiosks', { method: 'POST', body: J({ id: 'K3', name: 'Never connected', location: 'Sim' }) })
await api('/api/kiosks/K1', { method: 'PATCH', body: J({ comboEnabled: true, coin1Name: `Lion's "Head"`, coin2Name: '<Table Mtn>', tags: ['north', `it's`] }) })
await api('/api/settings', { method: 'PUT', body: J({ lowCoinThreshold: 30, offlineMinutes: 5 }) })
const T = (id, coin, amount, pay, disp, off) => ({ transactionId: id, amount, coinSelected: coin, paymentResult: pay, dispenseResult: disp, createdAt: ts(off), nayaxCardType: 'Visa', nayaxAuthCode: 'A1' })
await kio(k1.apiKey, '/api/ingest/sync', {
  transactions: [T('TX-1', 1, 200, 'approved', 'success', -900), T('TX-2', 2, 200, 'approved', 'success', -800), T('TX-3', 3, 300, 'approved', 'success', -700), T('TX-4', 1, 200, 'approved', 'jam', -600), T('TX-5', 2, 200, 'declined', null, -500), T('TX-6', 1, 200, 'cancelled_timeout', null, -400), T('TX-7', 3, 300, 'approved', null, -300), T('TX-8', 2, 200, 'communication_error', null, -200)],
  hopperEvents: [{ srcId: 1, hopperId: 1, type: 'refill', quantity: 50, oldStock: 0, newStock: 50, operator: `Op <x> O'Neil`, operatorRole: 'office', createdAt: ts(-1000) }, { srcId: 2, hopperId: 2, type: 'empty', quantity: 3, oldStock: 10, newStock: 7, operator: 'System (failed combo)', operatorRole: 'office', createdAt: ts(-950) }]
})
await api('/api/kiosks/K1/refill', { method: 'POST', body: J({ hopper: 1, quantity: 40 }) })
await api('/api/kiosks/K1/refill', { method: 'POST', body: J({ hopper: 2, quantity: 20 }) })
let cfg = await (await fetch(B + '/api/ingest/config', { headers: { 'X-Kiosk-Key': k1.apiKey } })).json()
const hb = (o = {}) => ({ appVersion: '1.21.38', appliedConfigVersion: cfg.configVersion, appliedRefillVersion: 1, coinPriceCents: 200, mdbConnected: true, nayaxConnected: false, hopper1: { status: 'ok', coinCount: 0 }, hopper2: { status: 'jam', coinCount: 12 }, updateStatus: 'installing', updateError: '', ...o })
await kio(k1.apiKey, '/api/ingest/heartbeat', hb())
await kio(k1.apiKey, '/api/ingest/nayax-log', { entries: [{ at: new Date().toISOString(), dir: 'TX', hex: '13 00 00 C8', event: 'vend request' }, { at: new Date().toISOString(), dir: 'RX', hex: '05 00 C8', event: '<b>approved</b>' }, { at: new Date().toISOString(), dir: 'INFO', note: `it's "fine" <ok>` }] })
await kio(k1.apiKey, '/api/ingest/net-log', { entries: [{ at: new Date().toISOString(), msg: 'server unreachable (EAI_AGAIN)' }, { at: new Date().toISOString(), msg: 'repair #1' }, { at: new Date().toISOString(), msg: 'back online after 111 min (12 repairs tried) <b>' }] })
await kio(k2.apiKey, '/api/ingest/heartbeat', hb({ nayaxConnected: true, hopper1: { status: 'ok', coinCount: 200 }, hopper2: { status: 'ok', coinCount: 1 }, updateStatus: 'idle', appliedConfigVersion: 1, appliedRefillVersion: 0 }))
await api('/api/kiosks/K1/maintenance', { method: 'POST', body: J({ note: `Cleaned <hopper> & "tray" — it's fine` }) })
await api('/api/kiosks/K1/schedule', { method: 'POST', body: J({ priceCents: 500, applyAt: new Date(Date.now() + 86400000).toISOString() }) })
await api('/api/operators', { method: 'POST', body: J({ name: 'Op One', pin: '4321', role: 'operator' }) })
await api('/api/users', { method: 'POST', body: J({ username: 'view1', password: 'viewer-pass-1', role: 'viewer' }) })
await api('/api/releases', { method: 'POST', body: J({ version: '1.21.39', channel: 'stable', notes: `notes with 'quotes' <tags>` }) })
await api('/api/ota/deploy', { method: 'POST', body: J({ version: '1.21.39', kioskIds: ['K2'], all: true }) })
await api('/api/destinations', { method: 'POST', body: J({ name: `Kruger "Park" <N>` }) })
// Restart so the fleet check runs at boot and raises the hardware alerts now.
await stop(); await start()
await kio(k1.apiKey, '/api/ingest/heartbeat', hb()); await kio(k2.apiKey, '/api/ingest/heartbeat', hb({ nayaxConnected: true, hopper1: { status: 'ok', coinCount: 200 }, hopper2: { status: 'ok', coinCount: 1 }, updateStatus: 'idle', appliedConfigVersion: 1, appliedRefillVersion: 0 }))
await stop(); await start()

// ---------------- browser ----------------
const html = await (await fetch(B + '/')).text()
async function session(role, user, pass) {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => { const m = String(e?.detail?.message || e?.message || e); if (!/Not implemented|Could not load|getContext/.test(m)) errors.push(m.slice(0, 300)) })
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)))
  const dom = new JSDOM(html.replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/g, ''), {
    url: B + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, B), o)
      w.Chart = class { constructor() {} destroy() {} update() {} }
      w.XLSX = { utils: { book_new: () => ({}), json_to_sheet: () => ({}), book_append_sheet() {} }, writeFile() {} }
      w.jspdf = { jsPDF: class { text() {} setFontSize() {} autoTable() {} save() {} } }
      w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => false; w.prompt = () => null
      w.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason?.stack || e.reason).slice(0, 300)))
      w.addEventListener('error', (e) => errors.push('error: ' + String(e.error?.stack || e.message).slice(0, 300)))
    }
  })
  const w = dom.window, d = w.document
  await sleep(200)
  if (role === 'operator') { d.getElementById('opname').value = user; d.getElementById('oppin').value = pass; await w.operatorLogin() }
  else { d.getElementById('user').value = user; d.getElementById('pw').value = pass; await w.login() }
  await sleep(300)
  const open = async (label, code, sel) => {
    errors.length = 0
    let thrown = ''
    try { await w.eval(`(async()=>{${code}; await render(); await render(true)})()`) } catch (e) { thrown = String(e?.stack || e).slice(0, 400) }
    await sleep(60)
    const el = d.querySelector(sel)
    const text = (el?.textContent || '').trim()
    // every button / link on the page must call a function that exists
    const missing = new Set()
    for (const n of d.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]')) for (const attr of ['onclick', 'onchange', 'oninput', 'onsubmit']) {
      const c = n.getAttribute(attr); if (!c) continue
      for (const m of c.matchAll(/(?<![.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g)) { const f = m[1]; if (['if', 'parseInt', 'parseFloat', 'confirm', 'alert', 'event', 'String', 'Number', 'setTimeout'].includes(f)) continue; if (typeof w.eval(`typeof ${f}`) !== 'string' || w.eval(`typeof ${f}`) !== 'function') missing.add(f) }
    }
    const leak = d.querySelector('#view b, #view i') && /Mall|Gate/.test([...d.querySelectorAll('#view b, #view i')].map((x) => x.textContent).join('|')) && [...d.querySelectorAll('#view b')].some((x) => x.textContent === '"Mall"')
    ok(`${role}: ${label}`, !thrown && !errors.length && text.length > 15 && !missing.size && !leak,
      [thrown && 'threw ' + thrown, errors.length && 'errors ' + errors.join(' | '), text.length <= 15 && `blank (${JSON.stringify(text)})`, missing.size && 'missing functions: ' + [...missing].join(','), leak && 'kiosk name was rendered as HTML'].filter(Boolean).join(' ; '))
    return text
  }
  return { w, d, open, close: () => w.close() }
}

// ---- admin: every page, every tab, for a busy kiosk, a quiet one and one that never connected
let s = await session('admin', 'admin', 'sim-pass')
for (const page of ['fleet', 'monitoring', 'global', 'pricing', 'images', 'destinations', 'updates', 'operators', 'users', 'audit']) await s.open(`page "${page}"`, `view={name:'${page}'}`, '#view')
const TABS = ['overview', 'sales', 'inventory', 'refill', 'marketing', 'alerts', 'maintenance', 'transactions', 'nayaxlog', 'netlog']
const texts = {}
for (const id of ['K1', 'K2', 'K3']) for (const t of TABS) texts[id + t] = await s.open(`kiosk ${id} tab "${t}"`, `view={name:'kiosk',id:'${id}'};kioskTab='${t}'`, '#ktab')
// content spot-checks on the busy kiosk
ok('admin: Sales tab shows total coins dispensed', /Total coins dispensed:\s*4/.test(texts.K1sales), texts.K1sales.slice(0, 160))
ok('admin: Alerts tab lists hardware + payment alerts', /Hopper empty/i.test(texts.K1alerts) && /TX-4/.test(texts.K1alerts) && /not confirmed/i.test(texts.K1alerts), texts.K1alerts.slice(0, 200))
ok('admin: Inventory tab shows reconciliation and the maintenance log', /Combo/.test(texts.K1inventory) && /Refill/.test(texts.K1inventory), texts.K1inventory.slice(0, 160))
ok('admin: Refill tab shows the refill log', /Refill log/.test(texts.K1refill) && /\+50/.test(texts.K1refill), texts.K1refill.slice(0, 160))
ok('admin: Network Log tab shows entries', /back online after 111 min/.test(texts.K1netlog))
ok('admin: Nayax Log tab shows entries', /vend request/.test(texts.K1nayaxlog))
await s.open('kiosk K1 overview again', `view={name:'kiosk',id:'K1'};kioskTab='overview'`, '#ktab')
ok('admin: awkward names show as text, exactly as typed', s.d.querySelector('.ptitle')?.textContent === NASTY, s.d.querySelector('.ptitle')?.textContent)
const upd = await s.open('page "updates" (status wording)', `view={name:'updates'}`, '#view')
ok('admin: Updates page shows pending for a kiosk not yet on target', /pending/i.test(upd) && /Any time \(when idle\)|only/.test(upd), upd.slice(-300))
await s.open('fleet (signal bars)', `view={name:'fleet'}`, '#view')
ok('admin: every kiosk card shows connection bars with a label', s.d.querySelectorAll('.kcard .sig .sigbars i').length === s.d.querySelectorAll('.kcard').length * 4 && [...s.d.querySelectorAll('.kcard .siglbl')].every((x) => x.textContent.length > 2), [...s.d.querySelectorAll('.kcard .siglbl')].map((x) => x.textContent).join(','))
ok('admin: never-connected kiosk shows 0 bars', [...s.d.querySelectorAll('.kcard')].some((c) => /Never connected/.test(c.textContent) && c.querySelectorAll('.sigbars i.f').length === 0))
await s.open('kiosk K1 overview (signal bars)', `view={name:'kiosk',id:'K1'};kioskTab='overview'`, '#ktab')
ok('admin: kiosk page header shows connection bars', s.d.querySelectorAll('#view .kstat .sigbars i').length === 4)
// reports with a custom range and each period
for (const p of ['today', 'week', 'month', 'all']) await s.open(`reports period "${p}"`, `view={name:'global'};if(typeof gPeriod!=='undefined')gPeriod='${p}'`, '#view')
s.close()

// ---- viewer
s = await session('viewer', 'view1', 'viewer-pass-1')
for (const page of ['fleet', 'monitoring', 'global', 'pricing']) await s.open(`page "${page}"`, `view={name:'${page}'}`, '#view')
for (const t of TABS) await s.open(`kiosk K1 tab "${t}"`, `view={name:'kiosk',id:'K1'};kioskTab='${t}'`, '#ktab')
ok('viewer: page never contains a kiosk API key', !s.d.documentElement.innerHTML.includes('kk_'))
ok('viewer: no admin-only menu items', !/Users|Operators|Audit|Updates/.test(s.d.getElementById('nav').textContent), s.d.getElementById('nav').textContent)
s.close()

// ---- operator (refill only)
s = await session('operator', 'Op One', '4321')
await s.open('fleet list', `view={name:'fleet'}`, '#view')
const opRefill = await s.open('kiosk K1 refill tab', `view={name:'kiosk',id:'K1'};kioskTab='refill'`, '#ktab')
ok('operator: lands on Refill and sees only that tab', /Refill/.test(opRefill) && s.d.querySelectorAll('.tabs .tab').length === 1, `tabs=${s.d.querySelectorAll('.tabs .tab').length}`)
ok('operator: page never contains a kiosk API key', !s.d.documentElement.innerHTML.includes('kk_'))
s.close()

await stop()
console.log('\n==== DASHBOARD: ' + results.filter((x) => x[0] === 'PASS').length + ' passed, ' + fails + ' failed ====')
for (const x of results) if (x[0] === 'FAIL') console.log(' ✗', x[1], '—', x[2])
process.exit(0)
