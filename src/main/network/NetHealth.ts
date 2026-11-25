/**
 * Network health — diagnose and repair this computer's own network connection.
 *
 * WHY: on real kiosks, after the internet was away for a few hours and came
 * back, Ubuntu did not bring the network connection back up by itself. The app
 * kept retrying correctly, but the computer had no route to anywhere
 * ("ENETUNREACH" / "EAI_AGAIN") until someone rebooted it. A kiosk on unstable
 * Wi-Fi or mobile data cannot depend on a person rebooting it.
 *
 * So while the fleet server is unreachable this module:
 *   1. looks at the network the way a technician would (is an adapter
 *      connected? does it have an address? does the router answer? is there
 *      internet beyond the router?), and
 *   2. when the fault is on THIS computer, repairs it with the same commands
 *      the Ubuntu network menu uses (switch networking off and on, reconnect
 *      the adapter). These need no password for the logged-in kiosk user.
 *
 * Everything it sees and does is written to a small log that is shown in
 * Admin → System and sent to Fleet Admin once the kiosk is back online — so a
 * problem that happened at 3am on site can be read from the office.
 *
 * It never reboots the computer and never touches the hoppers or card reader,
 * so sales carry on while it works. Linux only; a no-op elsewhere.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface NetLogEntry { at: string; msg: string }
type Kind = 'adapter_unplugged' | 'adapter_down' | 'no_address' | 'router_silent' | 'no_internet' | 'internet_ok' | 'unknown'
interface Diagnosis { kind: Kind; summary: string; devices: Array<{ dev: string; type: string; state: string }> }

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

const logFile = (): string => join(app.getPath('userData'), 'network-log.json')

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
  log.push({ at: new Date().toISOString(), msg })
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
        resolve({ ok: !err, out: (String(stdout || '') + (err ? String(stderr || err.message || '') : '')).trim() })
      })
    } catch (e) {
      resolve({ ok: false, out: (e as Error)?.message || 'could not run' })
    }
  })
}

const pingOk = async (ip: string): Promise<boolean> => (await run('ping', ['-c', '1', '-W', '3', ip], 6000)).ok

async function diagnose(): Promise<Diagnosis> {
  const d = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device'])
  const devices = d.out.split('\n').map((l) => l.split(':')).filter((p) => p.length >= 3 && (p[1] === 'ethernet' || p[1] === 'wifi'))
    .map((p) => ({ dev: p[0], type: p[1], state: p[2] }))
  if (!d.ok && !devices.length) return { kind: 'unknown', summary: `could not read the network state (${d.out.slice(0, 80)})`, devices }
  const list = devices.map((x) => `${x.dev} ${x.state}`).join(', ') || 'no network adapter found'
  const connected = devices.filter((x) => x.state.startsWith('connected'))
  if (!connected.length) {
    // "unavailable" = no cable / radio off: nothing software can do about a missing cable.
    const allUnplugged = devices.length > 0 && devices.every((x) => x.state === 'unavailable' || x.state === 'unmanaged')
    return allUnplugged
      ? { kind: 'adapter_unplugged', summary: `no cable / no Wi-Fi signal (${list})`, devices }
      : { kind: 'adapter_down', summary: `network adapter is not connected (${list})`, devices }
  }
  const addr = await run('ip', ['-4', '-o', 'addr', 'show', 'scope', 'global'])
  const hasAddr = /inet \d/.test(addr.out)
  const route = await run('ip', ['-4', 'route', 'show', 'default'])
  const gw = (/default via (\d+\.\d+\.\d+\.\d+)/.exec(route.out) || [])[1]
  if (!hasAddr || !gw) return { kind: 'no_address', summary: `connected but ${!hasAddr ? 'no address from the router' : 'no route to the router'} (${list})`, devices }
  if (!(await pingOk(gw))) return { kind: 'router_silent', summary: `the router (${gw}) does not answer (${list})`, devices }
  if (!(await pingOk('1.1.1.1')) && !(await pingOk('8.8.8.8'))) return { kind: 'no_internet', summary: `router ${gw} answers but there is no internet beyond it`, devices }
  return { kind: 'internet_ok', summary: 'internet is reachable from this computer', devices }
}

/** Do what the Ubuntu network menu does: off/on, then reconnect each adapter. */
async function repair(diag: Diagnosis): Promise<void> {
  repairs++
  note(`repair #${repairs}: switching networking off and on`)
  await run('nmcli', ['networking', 'off'], 15000)
  await new Promise((r) => setTimeout(r, 4000))
  const on = await run('nmcli', ['networking', 'on'], 15000)
  if (!on.ok) note(`could not switch networking on: ${on.out.slice(0, 120)}`)
  await new Promise((r) => setTimeout(r, 12000))
  const after = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device'])
  for (const line of after.out.split('\n')) {
    const [dev, type, state] = line.split(':')
    if ((type !== 'ethernet' && type !== 'wifi') || !dev) continue
    if (state && !state.startsWith('connected') && state !== 'unavailable' && state !== 'unmanaged') {
      const c = await run('nmcli', ['device', 'connect', dev], 45000)
      note(`reconnect ${dev}: ${c.ok ? 'ok' : c.out.slice(0, 120)}`)
    }
  }
  void diag
}

/**
 * Called by the fleet sync every time it could NOT reach the server.
 * Cheap: does nothing unless at least a minute has passed offline, and then
 * checks at most every 2 minutes.
 */
export async function onSyncFailed(reason: string): Promise<void> {
  if (!IS_LINUX || busy) return
  const now = Date.now()
  if (!offlineSince) { offlineSince = now; repairs = 0; nextRepairAt = now + 60_000; note(`server unreachable (${reason.slice(0, 120)})`) ; return }
  if (now - offlineSince < 60_000 || now - lastCheckAt < 120_000) return
  busy = true
  lastCheckAt = now
  try {
    const diag = await diagnose()
    const mins = Math.round((now - offlineSince) / 60000)
    if (diag.summary !== summary) note(`offline ${mins} min — ${diag.summary}`)
    summary = diag.summary
    // Faults on THIS computer are repaired. A missing cable, a dead router or an
    // internet outage upstream cannot be fixed from here — but after a long
    // outage Ubuntu's own state can still be stale, so retry occasionally.
    const local = diag.kind === 'adapter_down' || diag.kind === 'no_address' || diag.kind === 'unknown'
    const stale = diag.kind === 'router_silent' || diag.kind === 'no_internet' || diag.kind === 'internet_ok'
    if (now >= nextRepairAt && (local || (stale && mins >= 10))) {
      await repair(diag)
      // Back off: 2, 4, 8 … up to 30 minutes between repairs (longer for
      // faults that are probably not ours), so a real outage is not hammered.
      const gap = Math.min(2 * 60_000 * 2 ** Math.min(repairs - 1, 4), 30 * 60_000) * (local ? 1 : 2)
      nextRepairAt = Date.now() + gap
      const again = await diagnose()
      summary = again.summary
      note(`after repair: ${again.summary}`)
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
}

/** Short plain-language state for Admin → System while offline ('' when fine). */
export function getNetSummary(): string { return offlineSince ? summary : '' }
export function getNetLog(): NetLogEntry[] { load(); return log }
