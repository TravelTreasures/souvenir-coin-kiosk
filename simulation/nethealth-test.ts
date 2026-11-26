// Network self-repair against a fake Ubuntu network (fakebin/ on PATH).
// arg: "curable" = the stuck "connected (externally)" state, cured by re-activating
//      "stuck"   = nothing works (must keep retrying and NEVER restart the PC)
import './mock-electron'
import { onSyncFailed, onSyncOk, getNetSummary, getNetLog } from '@src/main/network/NetHealth'
const real = Date.now; let skew = 0; Date.now = () => real() + skew
async function main() {
  const mode = process.argv[2]
  await onSyncFailed('EAI_AGAIN; direct route (remembered address) also failed: ENETUNREACH')
  if (mode === 'curable') { skew += 70_000; await onSyncFailed('ENETUNREACH'); console.log('SUMMARY ' + getNetSummary()); onSyncOk() }
  else { for (let i = 0; i < 9; i++) { skew += 150_000; await onSyncFailed('ENETUNREACH') } console.log('SUMMARY ' + getNetSummary()) }
  await new Promise((r) => setTimeout(r, 800))
  for (const e of getNetLog()) console.log('LOG ' + e.msg)
  process.exit(0)
}
main()
