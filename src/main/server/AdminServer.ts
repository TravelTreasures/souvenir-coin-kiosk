/**
 * Embedded Admin Web Server
 *
 * A small HTTP server (Node built-in `http`, no extra dependencies) that
 * serves a password-protected web dashboard mirroring the on-device Admin
 * panel, plus a JSON API backed by the same SQLite database and controllers.
 *
 * SECURITY: this is plain HTTP. For internet access, put it behind a secure
 * tunnel that provides HTTPS (e.g. Cloudflare Tunnel) rather than exposing a
 * raw port. The dashboard requires a password (token-based session).
 *
 * Config (environment variables):
 *   ADMIN_WEB_PORT      default 8787
 *   ADMIN_WEB_PASSWORD  default 'kiosk-admin'  ← change this!
 *   ADMIN_WEB_ENABLED   set to 'false' to disable the server entirely
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { networkInterfaces } from 'os'
import type { HopperController } from '../hopper/HopperController'
import { simSetHopperCoinCount } from '../hopper/HopperController'
import type { NayaxController } from '../nayax/NayaxController'
import {
  getHopperCount,
  setHopperCount,
  getTransactions,
  getSalesReport,
  getUnresolvedAlerts,
  resolveAlert
} from '../database/Database'
import { getConfig, setPriceCents } from '../config/Config'

const PORT = Number(process.env.ADMIN_WEB_PORT ?? 8787)
const PASSWORD = process.env.ADMIN_WEB_PASSWORD ?? 'kiosk-admin'
const HOPPER_1_ADDR = 3 // ccTalk bus address of Hopper 1 (DIP switches)
const HOPPER_2_ADDR = 4 // ccTalk bus address of Hopper 2

// In-memory session tokens → expiry timestamp (ms)
const tokens = new Map<string, number>()
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours

function issueToken(): string {
  const token = randomBytes(24).toString('hex')
  tokens.set(token, Date.now() + TOKEN_TTL_MS)
  return token
}

function isValidToken(token: string | null): boolean {
  if (!token) return false
  const expiry = tokens.get(token)
  if (!expiry) return false
  if (Date.now() > expiry) {
    tokens.delete(token)
    return false
  }
  return true
}

function localSqlBounds(period: string): { from: string; to: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const fmt = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const now = new Date()
  const to = fmt(now)
  let from = '1970-01-01 00:00:00'
  if (period === 'today') {
    const s = new Date(now)
    s.setHours(0, 0, 0, 0)
    from = fmt(s)
  } else if (period === 'week') {
    const s = new Date(now)
    s.setDate(s.getDate() - 7)
    from = fmt(s)
  } else if (period === 'month') {
    const s = new Date(now)
    s.setMonth(s.getMonth() - 1)
    from = fmt(s)
  }
  return { from, to }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy() // basic flood guard
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function getLanIPs(): string[] {
  const ips: string[] = []
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
    }
  }
  return ips
}

export function startAdminServer(mdb: HopperController, nayax: NayaxController): void {
  if (process.env.ADMIN_WEB_ENABLED === 'false') {
    console.log('[web] Admin web server disabled (ADMIN_WEB_ENABLED=false)')
    return
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const path = url.pathname

    // Permissive CORS so the dashboard works through tunnels/other origins.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Serve the dashboard page
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(DASHBOARD_HTML)
      return
    }

    // Login (no auth required)
    if (req.method === 'POST' && path === '/api/login') {
      const body = (await readBody(req)) as { password?: string }
      if (body.password === PASSWORD) {
        sendJson(res, 200, { token: issueToken() })
      } else {
        sendJson(res, 401, { error: 'Invalid password' })
      }
      return
    }

    // ---- Everything below requires a valid token ----
    const auth = req.headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!isValidToken(token)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    try {
      if (req.method === 'GET' && path === '/api/hoppers') {
        sendJson(res, 200, { hopper1: getHopperCount(1), hopper2: getHopperCount(2) })
        return
      }

      if (req.method === 'POST' && path === '/api/hoppers') {
        const body = (await readBody(req)) as { hopper1?: number; hopper2?: number }
        if (typeof body.hopper1 === 'number') {
          setHopperCount(1, body.hopper1)
          simSetHopperCoinCount(HOPPER_1_ADDR, body.hopper1)
        }
        if (typeof body.hopper2 === 'number') {
          setHopperCount(2, body.hopper2)
          simSetHopperCoinCount(HOPPER_2_ADDR, body.hopper2)
        }
        sendJson(res, 200, { hopper1: getHopperCount(1), hopper2: getHopperCount(2) })
        return
      }

      if (req.method === 'GET' && path === '/api/sales') {
        const period = url.searchParams.get('period') ?? 'today'
        const { from, to } = localSqlBounds(period)
        sendJson(res, 200, getSalesReport(from, to))
        return
      }

      if (req.method === 'GET' && path === '/api/transactions') {
        const limit = Number(url.searchParams.get('limit') ?? 100)
        sendJson(res, 200, getTransactions(limit))
        return
      }

      if (req.method === 'GET' && path === '/api/alerts') {
        sendJson(res, 200, getUnresolvedAlerts())
        return
      }

      if (req.method === 'POST' && path === '/api/alerts/resolve') {
        const body = (await readBody(req)) as { transactionId?: string }
        if (body.transactionId) resolveAlert(body.transactionId)
        sendJson(res, 200, getUnresolvedAlerts())
        return
      }

      if (req.method === 'GET' && path === '/api/config') {
        sendJson(res, 200, getConfig())
        return
      }

      if (req.method === 'POST' && path === '/api/config/price') {
        const body = (await readBody(req)) as { cents?: number }
        if (typeof body.cents === 'number') setPriceCents(body.cents)
        sendJson(res, 200, getConfig())
        return
      }

      if (req.method === 'GET' && path === '/api/status') {
        const [h1, h2] = await Promise.all([
          mdb.getHopperStatus(HOPPER_1_ADDR),
          mdb.getHopperStatus(HOPPER_2_ADDR)
        ])
        sendJson(res, 200, {
          mdbConnected: mdb.isConnected(),
          nayaxConnected: nayax.isConnected(),
          hopper1: h1,
          hopper2: h2
        })
        return
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: msg })
    }
  })

  server.on('error', (err) => {
    console.error('[web] Admin web server error:', err)
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log('[web] Admin dashboard available at:')
    console.log(`      • http://localhost:${PORT}`)
    for (const ip of getLanIPs()) console.log(`      • http://${ip}:${PORT}  (LAN)`)
    if (PASSWORD === 'kiosk-admin') {
      console.log('[web] WARNING: using the default password. Set ADMIN_WEB_PASSWORD to change it.')
    }
  })
}

// ------------------------------------------------------------------
// Dashboard (single self-contained HTML page)
// ------------------------------------------------------------------
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Souvenir Coin Kiosk — Admin</title>
<style>
  :root {
    --bg:#0a1628; --panel:#132655; --panel2:#0f2044; --gold:#c9a227;
    --gold-light:#e8c04a; --white:#f5f5f5; --dim:#9fb0c8; --green:#4caf50; --red:#e53935;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--white); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:24px; }
  h1 { color:var(--gold-light); font-size:1.5rem; margin-bottom:4px; }
  .sub { color:var(--dim); font-size:.85rem; margin-bottom:24px; }
  .tabs { display:flex; flex-wrap:wrap; gap:4px; border-bottom:1px solid rgba(255,255,255,.1); margin-bottom:24px; }
  .tab { padding:10px 20px; background:none; border:none; border-bottom:2px solid transparent; color:var(--dim); cursor:pointer; font-size:.95rem; }
  .tab.active { color:var(--gold-light); border-bottom-color:var(--gold); font-weight:700; }
  .badge { margin-left:6px; background:var(--red); color:#fff; border-radius:999px; padding:1px 7px; font-size:.7rem; font-weight:700; }
  .card { background:rgba(255,255,255,.04); border:1px solid rgba(201,162,39,.15); border-radius:14px; padding:18px 22px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; max-width:560px; }
  .grid .label { color:var(--dim); font-size:.8rem; margin-bottom:6px; }
  .grid .val { font-size:1.6rem; font-weight:700; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th { text-align:left; color:var(--gold-light); padding:10px 12px; border-bottom:1px solid rgba(201,162,39,.3); }
  td { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.05); color:var(--white); }
  .dim { color:var(--dim); }
  .mono { font-family:monospace; font-size:.78rem; }
  .ok { color:var(--green); } .err { color:var(--red); }
  button.action { background:rgba(201,162,39,.15); border:1px solid var(--gold); color:var(--gold-light); padding:6px 14px; border-radius:8px; cursor:pointer; font-size:.8rem; }
  button.primary { background:linear-gradient(135deg,var(--gold),#a07d15); border:none; color:#fff; padding:12px 28px; border-radius:10px; cursor:pointer; font-weight:700; font-size:1rem; }
  input[type=number], input[type=password] { background:rgba(255,255,255,.06); border:1px solid rgba(201,162,39,.4); border-radius:10px; color:var(--white); padding:10px 14px; font-size:1rem; width:140px; }
  .row { display:flex; align-items:center; gap:14px; margin-bottom:16px; }
  .pills { display:flex; gap:8px; margin-bottom:20px; flex-wrap:wrap; }
  .pill { padding:8px 18px; border-radius:10px; border:1px solid rgba(255,255,255,.15); background:none; color:var(--dim); cursor:pointer; }
  .pill.active { border-color:var(--gold); background:rgba(201,162,39,.15); color:var(--gold-light); }
  .login { max-width:360px; margin:80px auto; text-align:center; }
  .login input { width:100%; margin:16px 0; }
  .hide { display:none; }
  .msg { color:var(--green); margin-left:12px; }
  .empty { padding:30px; text-align:center; color:var(--dim); }
  .refresh { float:right; background:none; border:1px solid rgba(201,162,39,.4); color:var(--gold-light); padding:8px 18px; border-radius:10px; cursor:pointer; }
</style>
</head>
<body>
<div class="wrap">
  <!-- Login -->
  <div id="login" class="login">
    <h1>Souvenir Coin Kiosk</h1>
    <p class="sub">Admin Dashboard</p>
    <input type="password" id="pw" placeholder="Password" onkeydown="if(event.key==='Enter')login()" />
    <div id="loginErr" class="err" style="min-height:20px"></div>
    <button class="primary" onclick="login()">Sign In</button>
  </div>

  <!-- Dashboard -->
  <div id="app" class="hide">
    <button class="refresh" onclick="loadTab()">↻ Refresh</button>
    <h1>Admin Panel</h1>
    <p class="sub">Souvenir Coin Kiosk — live data</p>
    <div class="tabs" id="tabs"></div>
    <div id="content"></div>
  </div>
</div>

<script>
  let token = null;
  let tab = 'hoppers';
  let alertCount = 0;
  const TABS = ['hoppers','sales','transactions','alerts','diagnostics','settings'];
  const LABELS = { hoppers:'Hoppers', sales:'Sales', transactions:'Transactions', alerts:'Alerts', diagnostics:'Diagnostics', settings:'Settings' };

  async function api(path, opts={}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token, ...(opts.headers||{}) }
    });
    if (res.status === 401) { token=null; showLogin(); throw new Error('unauthorized'); }
    return res.json();
  }

  function showLogin() { document.getElementById('login').classList.remove('hide'); document.getElementById('app').classList.add('hide'); }
  function showApp() { document.getElementById('login').classList.add('hide'); document.getElementById('app').classList.remove('hide'); }

  async function login() {
    const pw = document.getElementById('pw').value;
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pw}) });
    const data = await res.json();
    if (data.token) { token = data.token; showApp(); renderTabs(); loadTab(); }
    else { document.getElementById('loginErr').textContent = data.error || 'Login failed'; }
  }

  function renderTabs() {
    const el = document.getElementById('tabs');
    el.innerHTML = '';
    TABS.forEach(t => {
      const b = document.createElement('button');
      b.className = 'tab' + (t===tab?' active':'');
      b.innerHTML = LABELS[t] + (t==='alerts' && alertCount>0 ? ' <span class="badge">'+alertCount+'</span>' : '');
      b.onclick = () => { tab=t; renderTabs(); loadTab(); };
      el.appendChild(b);
    });
  }

  const rand = c => 'R'+(c/100).toFixed(2);
  const esc = s => String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  async function loadTab() {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty">Loading…</div>';
    // keep alert badge fresh
    try { const a = await api('/api/alerts'); alertCount = a.length; renderTabs(); } catch(e){ return; }

    if (tab==='hoppers') {
      const h = await api('/api/hoppers');
      c.innerHTML = \`
        <div class="card" style="max-width:480px">
          <h3 style="margin-bottom:18px">Hopper Coin Counts</h3>
          <div class="row"><label class="dim" style="width:90px">Hopper 1</label>
            <input type="number" id="h1" min="0" max="1000" value="\${h.hopper1}"> <span class="dim">/ 1000</span></div>
          <div class="row"><label class="dim" style="width:90px">Hopper 2</label>
            <input type="number" id="h2" min="0" max="1000" value="\${h.hopper2}"> <span class="dim">/ 1000</span></div>
          <button class="primary" onclick="saveHoppers()">Save / Refill</button><span id="hmsg" class="msg"></span>
        </div>\`;
    }
    else if (tab==='sales') {
      window._period = window._period || 'today';
      const periods = ['today','week','month','all'];
      const rep = await api('/api/sales?period='+window._period);
      c.innerHTML = \`
        <div class="pills">\${periods.map(p=>'<button class="pill'+(p===window._period?' active':'')+'" onclick="setPeriod(\\''+p+'\\')">'+(p==='all'?'All Time':p[0].toUpperCase()+p.slice(1))+'</button>').join('')}</div>
        <div class="grid">
          \${card('Total Sales', rep.totalSales)}\${card('Total Revenue', rand(rep.totalRevenue))}
          \${card('Coin 1 Sales', rep.coin1Sales)}\${card('Coin 1 Revenue', rand(rep.coin1Revenue))}
          \${card('Coin 2 Sales', rep.coin2Sales)}\${card('Coin 2 Revenue', rand(rep.coin2Revenue))}
        </div>\`;
    }
    else if (tab==='transactions') {
      const tx = await api('/api/transactions?limit=100');
      c.innerHTML = txTable(tx, ['Date/Time','Transaction ID','Coin','Amount','Payment','Dispense']) ;
    }
    else if (tab==='alerts') {
      const al = await api('/api/alerts');
      if (!al.length) { c.innerHTML = '<div class="card" style="color:var(--green)">✓ No outstanding alerts.</div>'; return; }
      c.innerHTML = '<h3 style="margin-bottom:14px">Payment Approved but Coin Not Dispensed</h3>' +
        '<table><thead><tr><th>Date/Time</th><th>Transaction ID</th><th>Coin</th><th>Amount</th><th>Dispense</th><th>Action</th></tr></thead><tbody>' +
        al.map(a => \`<tr><td class="dim">\${esc(a.createdAt.substring(0,19))}</td><td class="mono">\${esc(a.transactionId)}</td><td>Coin \${a.coinSelected}</td><td>\${rand(a.amount)}</td><td class="err">\${esc(a.dispenseResult||'not dispensed')}</td><td><button class="action" onclick="resolveAlert('\${esc(a.transactionId)}')">Mark Resolved</button></td></tr>\`).join('') +
        '</tbody></table>';
    }
    else if (tab==='settings') {
      const cfg = await api('/api/config');
      c.innerHTML = \`
        <div class="card" style="max-width:480px">
          <h3 style="margin-bottom:8px">Coin Price</h3>
          <p class="dim" style="font-size:.85rem;margin-bottom:16px">Price per coin (applies to both coins).</p>
          <div class="row"><span style="color:var(--gold-light);font-size:1.2rem">R</span>
            <input type="number" id="price" min="0" step="0.01" value="\${(cfg.coinPriceCents/100).toFixed(2)}">
            <button class="primary" onclick="savePrice()">Save Price</button><span id="pmsg" class="msg"></span></div>
        </div>\`;
    }
    else if (tab==='diagnostics') {
      const s = await api('/api/status');
      const dot = ok => '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:'+(ok?'var(--green)':'var(--red)')+'"></span>';
      c.innerHTML = '<div class="card" style="max-width:520px"><h3 style="margin-bottom:16px">System Status</h3>' +
        line(dot(s.mdbConnected)+'MDB Bus', s.mdbConnected?'Connected':'Offline', s.mdbConnected) +
        line(dot(s.nayaxConnected)+'Nayax Terminal', s.nayaxConnected?'Connected':'Offline', s.nayaxConnected) +
        line(dot(s.hopper1.status==='ok')+'Hopper 1', s.hopper1.status+' · '+s.hopper1.coinCount+' coins', s.hopper1.status==='ok') +
        line(dot(s.hopper2.status==='ok')+'Hopper 2', s.hopper2.status+' · '+s.hopper2.coinCount+' coins', s.hopper2.status==='ok') +
        '</div>';
    }
  }

  function card(label,val){ return '<div class="card"><div class="label">'+label+'</div><div class="val">'+val+'</div></div>'; }
  function line(left,right,ok){ return '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.06)"><span>'+left+'</span><span class="'+(ok?'ok':'err')+'">'+right+'</span></div>'; }
  function txTable(rows){
    if(!rows.length) return '<div class="empty">No transactions yet.</div>';
    return '<table><thead><tr><th>Date/Time</th><th>Transaction ID</th><th>Coin</th><th>Amount</th><th>Payment</th><th>Dispense</th></tr></thead><tbody>'+
      rows.map(t=>'<tr><td class="dim">'+esc(t.createdAt.substring(0,19))+'</td><td class="mono">'+esc(t.transactionId)+'</td><td>Coin '+t.coinSelected+'</td><td>'+rand(t.amount)+'</td><td class="'+(t.paymentResult==='approved'?'ok':'err')+'">'+esc(t.paymentResult)+'</td><td class="'+(t.dispenseResult==='success'?'ok':(t.dispenseResult?'err':'dim'))+'">'+esc(t.dispenseResult||'—')+'</td></tr>').join('')+
      '</tbody></table>';
  }

  function setPeriod(p){ window._period=p; loadTab(); }
  async function saveHoppers(){
    const h1=parseInt(document.getElementById('h1').value)||0;
    const h2=parseInt(document.getElementById('h2').value)||0;
    await api('/api/hoppers',{method:'POST',body:JSON.stringify({hopper1:h1,hopper2:h2})});
    document.getElementById('hmsg').textContent='Saved!';
    setTimeout(()=>document.getElementById('hmsg').textContent='',2000);
  }
  async function resolveAlert(id){ await api('/api/alerts/resolve',{method:'POST',body:JSON.stringify({transactionId:id})}); loadTab(); }
  async function savePrice(){
    const v=parseFloat(document.getElementById('price').value);
    if(!isFinite(v)||v<0){ document.getElementById('pmsg').textContent='Invalid'; return; }
    await api('/api/config/price',{method:'POST',body:JSON.stringify({cents:Math.round(v*100)})});
    document.getElementById('pmsg').textContent='Saved!';
    setTimeout(()=>document.getElementById('pmsg').textContent='',2000);
  }
</script>
</body>
</html>`
