/**
 * Network health — diagnose and repair this computer's own network connection.
 *
 * WHY: on real kiosks, after the network was away for a few hours and came
 * back, Ubuntu did not bring the connection back by itself. The evidence from
 * a kiosk (Admin → System, v1.21.36):
 *
 *     "connected but no address from the router
 *      (enp1s0 connected (externally), wlp2s0 disconnected)"
 *
 * "connected (externally)" means Ubuntu's NetworkManager is no longer running
 * its own connection on the wired port — the port is up, but nobody is asking
 * the router for an address. Only a reboot cured it. A kiosk on unstable Wi-Fi
 * or mobile data cannot depend on a person rebooting it.
 *
 * So while the fleet server is unreachable this module:
 *   1. looks at the network the way a technician would (adapter? address?
 *      router answering? internet beyond the router?);
 *   2. when the fault is on THIS computer, repairs it in steps of increasing
 *      force — re-activate the wired/Wi-Fi connection, then switch networking
 *      off and on, then try every saved connection, then create a fresh one.
 *
 * It NEVER restarts the computer (the owner's decision): if no repair works,
 * the kiosk stays offline — still selling — and the log says why.
 *
 * Everything it sees and does is written to a small log, shown in
 * Admin → System and sent to Fleet Admin (kiosk → Network Log) once back online.
 *
 * It never touches the hoppers or card reader either. Linux only; a no-op elsewhere.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface NetLogEntry { at: string; msg: string }
type Kind = 'adapter_unplugged' | 'adapter_down' | 'no_address' | 'router_silent' | 'no_internet' | 'internet_ok' | 'unknown'
interface Dev { dev: string; type: string; state: string }
interface Diagnosis { kind: Kind; summary: string; devices: Dev[] }

const IS_LINUX = process.platform === 'linux'
const MAX_LOG = 300
let log: NetLogEntry[] = []
let loaded = false
let offlineSince = 0
let lastCheckAt = 0
let repairs = 0
let nextRepairAt = 0
let busy = false
let summary = ''
let lastKind: Kind | '' = ''
let detailsLogged = false

const logFile = (): string => join(app.getPath('userData'), 'network-log.json')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(logFile())) {
      const j = JSON.parse(readFileSync(logFile(), 'utf8'))
      if (Array.isArray(j)) log = j.slice(-MAX_LOG)
    }
  } catch { /* a damaged log is not worth stopping for */ }
}

function note(msg: string): void {
  load()
  log.push({ at: new Date().toISOString(), msg: msg.slice(0, 300) })
  if (log.length > MAX_LOG) log = log.slice(-MAX_LOG)
  console.log(`[network] ${msg}`)
  try {
    const tmp = logFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(log))
    renameSync(tmp, logFile())
  } catch { /* disk trouble must not break syncing */ }
}

/** Run a system command; never throws, always resolves with what it printed. */
function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: (String(stdout || '') + (err ? ' ' + String(stderr || err.message || '') : '')).trim() })
      })
    } catch (e) {
      resolve({ ok: false, out: (e as Error)?.message || 'could not run' })
    }
  })
}
const short = (s: string, n = 140): string => s.replace(/\s+/g, ' ').trim().slice(0, n)
const pingOk = async (ip: string): Promise<boolean> => (await run('ping', ['-c', '1', '-W', '3', ip], 6000)).ok

async function listDevices(): Promise<{ ok: boolean; raw: string; devices: Dev[] }> {
  const d = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device'])
  const devices = d.out.split('\n').map((l) => l.split(':')).filter((p) => p.length >= 3 && (p[1] === 'ethernet' || p[1] === 'wifi'))
    .map((p) => ({ dev: p[0], type: p[1], state: p.slice(2).join(':') }))
  return { ok: d.ok, raw: d.out, devices }
}
/** Really connected = NetworkManager is running its own connection on it. */
const reallyConnected = (state: string): boolean => state === 'connected'
/** A cable / radio is present (so a connection is possible at all). */
const hasCarrier = (state: string): boolean => state !== 'unavailable' && state !== 'unmanaged'
const hasIpv4 = async (dev: string): Promise<boolean> => /inet \d/.test((await run('ip', ['-4', '-o', 'addr', 'show', 'dev', dev, 'scope', 'global'])).out)

async function diagnose(): Promise<Diagnosis> {
  const { ok, raw, devices } = await listDevices()
  if (!ok && !devices.length) return { kind: 'unknown', summary: `could not read the network state (${short(raw, 80)})`, devices }
  const list = devices.map((x) => `${x.dev} ${x.state}`).join(', ') || 'no network adapter found'
  if (devices.length > 0 && devices.every((x) => !hasCarrier(x.state))) {
    // No cable / radio off: nothing software can do about a missing cable.
    return { kind: 'adapter_unplugged', summary: `no cable / no Wi-Fi signal (${list})`, devices }
  }
  const addr = await run('ip', ['-4', '-o', 'addr', 'show', 'scope', 'global'])
  const hasAddr = /inet \d/.test(addr.out)
  const route = await run('ip', ['-4', 'route', 'show', 'default'])
  const gw = (/default via (\d+\.\d+\.\d+\.\d+)/.exec(route.out) || [])[1]
  if (!hasAddr || !gw) {
    const anyUp = devices.some((x) => x.state.startsWith('connected'))
    return anyUp
      ? { kind: 'no_address', summary: `${!hasAddr ? 'no address from the router' : 'no route to the router'} (${list})`, devices }
      : { kind: 'adapter_down', summary: `network adapter is not connected (${list})`, devices }
  }
  if (!(await pingOk(gw))) return { kind: 'router_silent', summary: `the router (${gw}) does not answer (${list})`, devices }
  if (!(await pingOk('1.1.1.1')) && !(await pingOk('8.8.8.8'))) return { kind: 'no_internet', summary: `router ${gw} answers but there is no internet beyond it`, devices }
  return { kind: 'internet_ok', summary: 'internet is reachable from this computer', devices }
}

/** Saved connection profiles: name + type ('802-3-ethernet' | '802-11-wireless' | …). */
async function profiles(): Promise<Array<{ name: string; type: string }>> {
  const p = await run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'])
  return p.out.split('\n').map((l) => { const i = l.lastIndexOf(':'); return i > 0 ? { name: l.slice(0, i).replace(/\\:/g, ':'), type: l.slice(i + 1) } : { name: '', type: '' } }).filter((x) => x.name)
}

/** Write down, once per outage, the facts a technician would want to see. */
async function logDetails(): Promise<void> {
  if (detailsLogged) return
  detailsLogged = true
  const pr = await profiles()
  note(`saved connections: ${pr.map((x) => `${x.name} [${x.type.replace('802-3-', '').replace('802-11-', '')}]`).join(', ') || 'none'}`)
  const j = await run('journalctl', ['-u', 'NetworkManager', '-n', '12', '--no-pager', '-o', 'cat'], 8000)
  if (j.ok && j.out) for (const line of j.out.split('\n').slice(-12)) note(`NM: ${short(line, 220)}`)
}

/** Bring ONE adapter back: re-activate, then every saved profile, then a new one. */
async function reviveDevice(d: Dev): Promise<boolean> {
  const wired = d.type === 'ethernet'
  const pr = await profiles()
  const mine = pr.filter((x) => x.type === (wired ? '802-3-ethernet' : '802-11-wireless'))
  // Wi-Fi with nothing saved was never set up on this kiosk — leave it alone.
  if (!wired && !mine.length) return false
  note(`${d.dev} is "${d.state}" — re-activating its connection`)
  await run('nmcli', ['device', 'set', d.dev, 'managed', 'yes'])
  await run('nmcli', ['device', 'disconnect', d.dev], 20000)
  const c = await run('nmcli', ['device', 'connect', d.dev], 60000)
  note(`connect ${d.dev}: ${c.ok ? 'activated' : short(c.out)}`)
  await sleep(5000)
  if (await hasIpv4(d.dev)) return true
  for (const p of mine) {
    const u = await run('nmcli', ['connection', 'up', p.name, 'ifname', d.dev], 60000)
    note(`"${p.name}" on ${d.dev}: ${u.ok ? 'activated' : short(u.out)}`)
    await sleep(5000)
    if (await hasIpv4(d.dev)) return true
  }
  if (wired) {
    // Nothing saved works — make a clean wired connection (automatic address).
    const name = `kiosk-wired-${d.dev}`
    if (!mine.some((x) => x.name === name)) {
      const a = await run('nmcli', ['connection', 'add', 'type', 'ethernet', 'ifname', d.dev, 'con-name', name, 'autoconnect', 'yes', 'connection.autoconnect-retries', '0', 'ipv4.method', 'auto'], 20000)
      note(`new connection ${name}: ${a.ok ? 'created' : short(a.out)}`)
      const u = await run('nmcli', ['connection', 'up', name, 'ifname', d.dev], 60000)
      note(`"${name}" on ${d.dev}: ${u.ok ? 'activated' : short(u.out)}`)
      await sleep(5000)
      if (await hasIpv4(d.dev)) return true
    }
  }
  return false
}

async function repair(diag: Diagnosis): Promise<void> {
  repairs++
  note(`repair #${repairs}`)
  // From the 2nd attempt, first reset networking as a whole (what the Ubuntu
  // network menu's off/on switch does).
  if (repairs >= 2) {
    note('switching networking off and on')
    await run('nmcli', ['networking', 'off'], 15000)
    await sleep(4000)
    const on = await run('nmcli', ['networking', 'on'], 15000)
    if (!on.ok) note(`could not switch networking on: ${short(on.out)}`)
    await sleep(10000)
  }
  const { devices } = repairs >= 2 ? await listDevices() : { devices: diag.devices }
  for (const d of devices) {
    if (!hasCarrier(d.state)) continue // no cable / no radio: nothing to activate
    if (reallyConnected(d.state) && (await hasIpv4(d.dev))) continue
    if (await reviveDevice(d)) { note(`${d.dev} has an address again`); break }
  }
}

/**
 * Called by the fleet sync every time it could NOT reach the server.
 * Cheap: does nothing in the first minute offline, then checks every 2 minutes.
 */
export async function onSyncFailed(reason: string): Promise<void> {
  if (!IS_LINUX || busy) return
  const now = Date.now()
  if (!offlineSince) {
    offlineSince = now; repairs = 0; nextRepairAt = now + 60_000; lastKind = ''; detailsLogged = false
    note(`server unreachable (${short(reason, 120)})`)
    return
  }
  if (now - offlineSince < 60_000 || now - lastCheckAt < 120_000) return
  busy = true
  lastCheckAt = now
  try {
    const diag = await diagnose()
    const mins = Math.round((now - offlineSince) / 60000)
    if (diag.summary !== summary) note(`offline ${mins} min — ${diag.summary}`)
    summary = diag.summary
    // The situation changed (e.g. the cable was just plugged back in): act now,
    // don't wait out a back-off earned in a different situation.
    if (diag.kind !== lastKind) { nextRepairAt = Math.min(nextRepairAt, Date.now()); lastKind = diag.kind }
    // Faults on THIS computer are repaired. A missing cable, a dead router or an
    // internet outage upstream cannot be fixed from here — but after a long
    // outage Ubuntu's own state can still be stale, so retry now and then.
    const local = diag.kind === 'adapter_down' || diag.kind === 'no_address' || diag.kind === 'unknown'
    const stale = diag.kind === 'router_silent' || diag.kind === 'no_internet' || diag.kind === 'internet_ok'
    if (local) await logDetails()
    if (Date.now() >= nextRepairAt && (local || (stale && mins >= 10))) {
      await repair(diag)
      // Back off: 2, 4, 8 … up to 30 minutes between repairs (longer for faults
      // that are probably not ours), so a real outage is not hammered.
      const gap = Math.min(2 * 60_000 * 2 ** Math.min(repairs - 1, 4), 30 * 60_000) * (local ? 1 : 2)
      nextRepairAt = Date.now() + gap
      const again = await diagnose()
      summary = again.summary
      lastKind = again.kind
      note(`after repair #${repairs}: ${again.summary}`)
    }
  } catch (e) {
    note(`network check failed: ${(e as Error)?.message || e}`)
  } finally {
    busy = false
  }
}

/** Called by the fleet sync every time it DID reach the server. */
export function onSyncOk(): void {
  if (!offlineSince) return
  const mins = Math.max(1, Math.round((Date.now() - offlineSince) / 60000))
  note(`back online after ${mins} min${repairs ? ` (${repairs} repair${repairs > 1 ? 's' : ''} tried)` : ''}`)
  offlineSince = 0
  summary = ''
  repairs = 0
  lastKind = ''
}

/** Short plain-language state for Admin → System while offline ('' when fine). */
export function getNetSummary(): string { return offlineSince ? `${summary}${repairs ? ` · ${repairs} repair${repairs > 1 ? 's' : ''} tried` : ''}` : '' }
export function getNetLog(): NetLogEntry[] { load(); return log }
