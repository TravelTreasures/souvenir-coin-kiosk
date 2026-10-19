import { useEffect, useState, useCallback } from 'react'

interface AdminScreenProps {
  onClose: () => void
}

type Tab = 'hoppers' | 'sales' | 'transactions' | 'alerts' | 'diagnostics' | 'system'
type SalesPeriod = 'today' | 'week' | 'month' | 'all'

interface HopperCounts { hopper1: number; hopper2: number }
interface SalesReport {
  totalSales: number; totalRevenue: number
  coin1Sales: number; coin2Sales: number
  coin1Revenue: number; coin2Revenue: number
  periodStart: string; periodEnd: string
}
interface Transaction {
  id: number; transactionId: string; amount: number
  coinSelected: 1 | 2; paymentResult: string; dispenseResult: string | null
  nayaxAuthCode: string | null; nayaxCardType: string | null
  alertSent: number; createdAt: string
}
interface SystemStatus {
  mdbConnected: boolean; nayaxConnected: boolean
  hopper1: { status: string; coinCount: number }
  hopper2: { status: string; coinCount: number }
}

function formatRand(cents: number) {
  return `R${(cents / 100).toFixed(2)}`
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
        background: ok ? 'var(--success-green)' : 'var(--error-red)',
        marginRight: 8, boxShadow: ok ? '0 0 8px rgba(76,175,80,0.6)' : 'none'
      }}
    />
  )
}

export function AdminScreen({ onClose }: AdminScreenProps) {
  const [tab, setTab] = useState<Tab>('hoppers')
  const [hopperCounts, setHopperCounts] = useState<HopperCounts | null>(null)
  const [editH1, setEditH1] = useState('')
  const [editH2, setEditH2] = useState('')
  const [emptyH, setEmptyH] = useState<1 | 2>(1)
  const [emptyQty, setEmptyQty] = useState<'all' | 1 | 2 | 3 | 4 | 5>('all')
  const [refillH, setRefillH] = useState<1 | 2>(1)
  const [refillAdd, setRefillAdd] = useState('')
  const [me, setMe] = useState<{ name: string; role: 'office' | 'operator' | 'viewer' } | null>(null)
  const [maintMsg, setMaintMsg] = useState('')
  const [hopperEvents, setHopperEvents] = useState<Array<{ id: number; hopperId: 1 | 2; type: 'empty' | 'refill'; quantity: number; oldStock: number; newStock: number; operator: string | null; operatorRole?: string | null; createdAt: string }>>([])
  const [salesPeriod, setSalesPeriod] = useState<SalesPeriod>('today')
  const [salesReport, setSalesReport] = useState<SalesReport | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [alerts, setAlerts] = useState<Transaction[]>([])
  const [sysStatus, setSysStatus] = useState<SystemStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [mode, setMode] = useState<'kiosk' | 'dev' | null>(null)
  const [priceInput, setPriceInput] = useState('')
  const [priceMsg, setPriceMsg] = useState('')
  const [priceFocused, setPriceFocused] = useState(false)
  const [txTimeout, setTxTimeout] = useState('45')
  const [txTimeoutMsg, setTxTimeoutMsg] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [fleet, setFleet] = useState<{
    kioskId: string; fleetUrl: string; fleetApiKey: string; enabled: boolean; appliedConfigVersion: number
    status?: { state: 'ok' | 'auth_failed' | 'error' | 'offline'; at: string; code?: number } | null
  }>({ kioskId: '', fleetUrl: '', fleetApiKey: '', enabled: false, appliedConfigVersion: 0, status: null })
  const [fleetMsg, setFleetMsg] = useState('')
  const [pinCur, setPinCur] = useState('')
  const [pinNew, setPinNew] = useState('')
  const [pinConf, setPinConf] = useState('')
  const [pinMsg, setPinMsg] = useState<{ text: string; ok: boolean } | null>(null)

  // Load data based on active tab
  useEffect(() => {
    if (tab === 'hoppers') {
      window.kiosk.getHopperCounts().then((d: HopperCounts) => {
        setHopperCounts(d)
        setEditH1(String(d.hopper1))
        setEditH2(String(d.hopper2))
      })
      window.kiosk.getHopperEvents?.().then(setHopperEvents).catch(() => {})
    } else if (tab === 'sales') {
      window.kiosk.getSalesReport(salesPeriod).then(setSalesReport)
    } else if (tab === 'transactions') {
      window.kiosk.getTransactions(100).then(setTransactions)
    } else if (tab === 'alerts') {
      window.kiosk.getAlerts().then(setAlerts)
    } else if (tab === 'diagnostics') {
      window.kiosk.getSystemStatus().then(setSysStatus)
    } else if (tab === 'system') {
      window.kiosk.getMode().then(setMode)
      window.kiosk.getConfig().then((c) => setPriceInput((c.coinPriceCents / 100).toFixed(2)))
      window.kiosk.getTransactionTimeout?.().then((s) => setTxTimeout(String(s || 45)))
      window.kiosk.getFleet().then(setFleet)
    }
  }, [tab, salesPeriod])

  // Load the alert count once on open so the tab can show a badge.
  useEffect(() => {
    window.kiosk.getAlerts().then(setAlerts)
    window.kiosk.getAppVersion?.().then(setAppVersion).catch(() => {})
    window.kiosk.getOperator?.().then((o) => setMe(o)).catch(() => {})
  }, [])

  // Role-based capabilities (server enforces these too).
  const role = me?.role ?? 'office'
  const canMaintain = role !== 'viewer'
  const canConfig = role === 'office'

  // While the System tab is open, keep the price + fleet status fresh so a
  // remote price push from the Fleet Admin shows up here too. Don't overwrite
  // the price field while the operator is actively editing it.
  useEffect(() => {
    if (tab !== 'system') return
    const id = setInterval(() => {
      window.kiosk.getConfig().then((c) => {
        if (!priceFocused) setPriceInput((c.coinPriceCents / 100).toFixed(2))
      })
      // Only refresh the live connection STATUS — never overwrite the editable
      // Server URL / Kiosk ID / API Key fields, or it would wipe what the
      // operator is typing/pasting before they can press Save.
      window.kiosk.getFleet().then((f) =>
        // Only update (and re-render) when the live status actually changed —
        // returning the previous object unchanged keeps the screen from
        // flickering every 4s while the System tab sits open.
        setFleet((prev) =>
          prev.enabled === f.enabled &&
          prev.appliedConfigVersion === f.appliedConfigVersion &&
          JSON.stringify(prev.status) === JSON.stringify(f.status)
            ? prev
            : { ...prev, enabled: f.enabled, appliedConfigVersion: f.appliedConfigVersion, status: f.status })
      )
    }, 4000)
    return () => clearInterval(id)
  }, [tab, priceFocused])

  const savePrice = useCallback(async () => {
    const value = parseFloat(priceInput)
    if (!Number.isFinite(value) || value < 0) {
      setPriceMsg('Enter a valid price')
      return
    }
    await window.kiosk.setPrice(Math.round(value * 100))
    setPriceMsg('Saved!')
    setTimeout(() => setPriceMsg(''), 2000)
  }, [priceInput])

  const saveTxTimeout = useCallback(async () => {
    const v = parseInt(txTimeout, 10)
    if (!Number.isFinite(v) || v < 10 || v > 300) {
      setTxTimeoutMsg('Enter 10–300 seconds')
      return
    }
    const r = await window.kiosk.setTransactionTimeout(v)
    setTxTimeout(String(r.seconds))
    setTxTimeoutMsg('Saved!')
    setTimeout(() => setTxTimeoutMsg(''), 2000)
  }, [txTimeout])

  const saveFleet = useCallback(async () => {
    await window.kiosk.setFleet({ kioskId: fleet.kioskId, fleetUrl: fleet.fleetUrl, fleetApiKey: fleet.fleetApiKey })
    setFleetMsg('Saved — syncing…')
    setTimeout(async () => {
      setFleet(await window.kiosk.getFleet())
      setFleetMsg('')
    }, 1500)
  }, [fleet])

  const savePin = useCallback(async () => {
    if (pinNew !== pinConf) {
      setPinMsg({ text: 'New PIN and confirmation do not match.', ok: false })
      return
    }
    if (!/^\d{4,8}$/.test(pinNew)) {
      setPinMsg({ text: 'New PIN must be 4 to 8 digits.', ok: false })
      return
    }
    const res = await window.kiosk.setPin(pinCur, pinNew)
    if (res.ok) {
      setPinMsg({ text: 'PIN changed.', ok: true })
      setPinCur(''); setPinNew(''); setPinConf('')
      setTimeout(() => setPinMsg(null), 2500)
    } else {
      setPinMsg({ text: res.error || 'Could not change PIN.', ok: false })
    }
  }, [pinCur, pinNew, pinConf])

  const handleResolveAlert = useCallback(async (transactionId: string) => {
    await window.kiosk.resolveAlert(transactionId)
    const updated = await window.kiosk.getAlerts()
    setAlerts(updated)
  }, [])

  const saveHopperCounts = useCallback(async () => {
    setSaving(true)
    await window.kiosk.setHopperCount(1, parseInt(editH1) || 0)
    await window.kiosk.setHopperCount(2, parseInt(editH2) || 0)
    setSaveMsg('Saved!')
    setSaving(false)
    setTimeout(() => setSaveMsg(''), 2000)
  }, [editH1, editH2])

  const reloadHoppers = useCallback(async () => {
    const d = await window.kiosk.getHopperCounts()
    setHopperCounts(d); setEditH1(String(d.hopper1)); setEditH2(String(d.hopper2))
    setHopperEvents(await window.kiosk.getHopperEvents())
  }, [])

  const doEmptyHopper = useCallback(async () => {
    const label = emptyQty === 'all' ? 'ALL remaining tokens' : `${emptyQty} token(s)`
    if (!confirm(`Dispense ${label} from Hopper ${emptyH}? This is a maintenance dispense — it is NOT a sale.`)) return
    const r = await window.kiosk.emptyHopper(emptyH, emptyQty)
    if (!r.ok) { setMaintMsg(r.error || 'Not permitted.'); return }
    setMaintMsg(`Dispensed ${r.dispensed} from Hopper ${emptyH} (${r.oldStock} → ${r.newStock}).`)
    await reloadHoppers()
    setTimeout(() => setMaintMsg(''), 4000)
  }, [emptyH, emptyQty, reloadHoppers])

  const doRefillHopper = useCallback(async () => {
    const added = parseInt(refillAdd, 10)
    if (!Number.isFinite(added) || added <= 0) { setMaintMsg('Enter the number of tokens loaded.'); return }
    const r = await window.kiosk.refillHopper(refillH, added)
    if (!r.ok) { setMaintMsg(r.error || 'Not permitted.'); return }
    setMaintMsg(`Refilled Hopper ${refillH}: old ${r.oldStock} + ${r.added} = ${r.newStock}.`)
    setRefillAdd('')
    await reloadHoppers()
    setTimeout(() => setMaintMsg(''), 4000)
  }, [refillH, refillAdd, reloadHoppers])

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '12px 24px',
    border: 'none',
    borderBottom: tab === t ? '2px solid var(--accent-gold)' : '2px solid transparent',
    background: 'transparent',
    color: tab === t ? 'var(--text-gold)' : 'var(--text-dim)',
    fontSize: '0.95rem',
    fontWeight: tab === t ? 700 : 400,
    cursor: 'pointer'
  })

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(5,12,28,0.97)',
        display: 'flex', flexDirection: 'column',
        zIndex: 900, overflowY: 'auto'
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 32px',
          borderBottom: '1px solid rgba(201,162,39,0.2)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2 style={{ color: 'var(--text-gold)', fontSize: '1.4rem', fontWeight: 700 }}>
            Admin Panel
          </h2>
          {appVersion && (
            <span style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
              Kiosk app v{appVersion}
            </span>
          )}
          {me && (
            <span style={{ color: 'var(--text-gold)', fontSize: '0.9rem' }}>
              · {me.name} <span style={{ color: 'var(--text-dim)', textTransform: 'capitalize' }}>({me.role})</span>
            </span>
          )}
        </div>
        <button
          onClick={() => { window.kiosk.signOutOperator?.(); onClose() }}
          style={{
            background: 'rgba(255,255,255,0.08)', border: 'none',
            color: 'var(--text-white)', padding: '10px 24px',
            borderRadius: 10, cursor: 'pointer', fontSize: '1rem'
          }}
        >
          ✕ Close
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.1)', padding: '0 20px' }}>
        {(['hoppers', 'sales', 'transactions', 'alerts', 'diagnostics', 'system'] as Tab[]).map((t) => (
          <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>
            {{ hoppers: 'Hoppers', sales: 'Sales', transactions: 'Transactions', alerts: 'Alerts', diagnostics: 'Diagnostics', system: 'System' }[t]}
            {t === 'alerts' && alerts.length > 0 && (
              <span
                style={{
                  marginLeft: 8, padding: '2px 8px', borderRadius: 999,
                  background: 'var(--error-red)', color: '#fff',
                  fontSize: '0.7rem', fontWeight: 700
                }}
              >
                {alerts.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>

        {/* ── HOPPERS ── */}
        {tab === 'hoppers' && hopperCounts && (
          <div style={{ maxWidth: 480 }}>
            <h3 style={{ color: 'var(--text-white)', marginBottom: 24, fontSize: '1.1rem' }}>Hopper Coin Counts</h3>

            {([1, 2] as (1|2)[]).map((h) => (
              <div key={h}
                style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                <label style={{ color: 'var(--text-dim)', width: 80 }}>Hopper {h}</label>
                <input
                  type="number" min={0} max={1000}
                  value={h === 1 ? editH1 : editH2}
                  onChange={(e) => h === 1 ? setEditH1(e.target.value) : setEditH2(e.target.value)}
                  style={{
                    width: 120, padding: '10px 14px', borderRadius: 10,
                    border: '1px solid rgba(201,162,39,0.4)',
                    background: 'rgba(255,255,255,0.05)',
                    color: 'var(--text-white)', fontSize: '1.1rem'
                  }}
                />
                <span style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>/ 1,000 coins</span>
              </div>
            ))}

            {canMaintain && (
              <button
                onClick={saveHopperCounts} disabled={saving}
                className="btn btn-gold"
                style={{ marginTop: 8, fontSize: '1rem', padding: '14px 36px' }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            {saveMsg && <span style={{ color: 'var(--success-green)', marginLeft: 16 }}>{saveMsg}</span>}

            {!canMaintain && (
              <p style={{ marginTop: 28, color: 'var(--text-gold)' }}>
                You are signed in as a Viewer — maintenance actions are read-only.
              </p>
            )}

            {/* Maintenance: empty + refill (recorded automatically against the signed-in operator) */}
            {canMaintain && (
            <div style={{ marginTop: 36, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, maxWidth: 720 }}>
              <div style={{ padding: '18px 20px', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(201,162,39,0.15)' }}>
                <h4 style={{ color: 'var(--text-white)', marginBottom: 6 }}>Empty Hopper</h4>
                <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: 12 }}>
                  Dispense tokens for refill. Maintenance only — not counted as a sale.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select value={emptyH} onChange={(e) => setEmptyH(Number(e.target.value) as 1 | 2)}
                    style={{ padding: '9px 12px', borderRadius: 9, background: 'rgba(255,255,255,0.05)', color: 'var(--text-white)', border: '1px solid rgba(201,162,39,0.4)' }}>
                    <option value={1}>Hopper 1</option>
                    <option value={2}>Hopper 2</option>
                  </select>
                  <select value={String(emptyQty)} onChange={(e) => setEmptyQty(e.target.value === 'all' ? 'all' : (Number(e.target.value) as 1 | 2 | 3 | 4 | 5))}
                    style={{ padding: '9px 12px', borderRadius: 9, background: 'rgba(255,255,255,0.05)', color: 'var(--text-white)', border: '1px solid rgba(201,162,39,0.4)' }}>
                    <option value="all">All</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5</option>
                  </select>
                  <button className="btn btn-gold" style={{ padding: '10px 22px' }} onClick={doEmptyHopper}>Dispense</button>
                </div>
              </div>

              <div style={{ padding: '18px 20px', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(201,162,39,0.15)' }}>
                <h4 style={{ color: 'var(--text-white)', marginBottom: 6 }}>Refill Hopper</h4>
                <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: 12 }}>
                  Enter how many tokens you loaded. Stock becomes current + added.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select value={refillH} onChange={(e) => setRefillH(Number(e.target.value) as 1 | 2)}
                    style={{ padding: '9px 12px', borderRadius: 9, background: 'rgba(255,255,255,0.05)', color: 'var(--text-white)', border: '1px solid rgba(201,162,39,0.4)' }}>
                    <option value={1}>Hopper 1</option>
                    <option value={2}>Hopper 2</option>
                  </select>
                  <input type="number" min={1} max={1000} placeholder="tokens added" value={refillAdd}
                    onChange={(e) => setRefillAdd(e.target.value)}
                    style={{ width: 120, padding: '9px 12px', borderRadius: 9, background: 'rgba(255,255,255,0.05)', color: 'var(--text-white)', border: '1px solid rgba(201,162,39,0.4)' }} />
                  <button className="btn btn-gold" style={{ padding: '10px 22px' }} onClick={doRefillHopper}>Refill</button>
                </div>
              </div>
            </div>
            )}
            {maintMsg && <p style={{ color: 'var(--success-green)', marginTop: 14 }}>{maintMsg}</p>}

            {/* Audit history */}
            <h3 style={{ color: 'var(--text-white)', margin: '32px 0 12px', fontSize: '1.05rem' }}>Maintenance History</h3>
            {hopperEvents.length === 0 ? (
              <p style={{ color: 'var(--text-dim)' }}>No hopper maintenance recorded yet.</p>
            ) : (
              <table style={{ width: '100%', maxWidth: 720, borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 6px' }}>Date/Time</th>
                    <th>Hopper</th>
                    <th>Action</th>
                    <th>Qty</th>
                    <th>Stock</th>
                    <th>Operator</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {hopperEvents.map((e) => (
                    <tr key={e.id} style={{ color: 'var(--text-white)', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      <td style={{ padding: '8px 6px' }}>{e.createdAt}</td>
                      <td>{e.hopperId}</td>
                      <td style={{ color: e.type === 'refill' ? 'var(--success-green)' : 'var(--text-gold)' }}>
                        {e.type === 'refill' ? 'Refill' : 'Empty (maint.)'}
                      </td>
                      <td>{e.type === 'refill' ? `+${e.quantity}` : e.quantity}</td>
                      <td>{e.oldStock} → {e.newStock}</td>
                      <td>{e.operator || '-'}</td>
                      <td style={{ color: 'var(--text-dim)', textTransform: 'capitalize' }}>{e.operatorRole || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── SALES ── */}
        {tab === 'sales' && (
          <div style={{ maxWidth: 560 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 28 }}>
              {(['today', 'week', 'month', 'all'] as SalesPeriod[]).map((p) => (
                <button key={p} onClick={() => setSalesPeriod(p)}
                  style={{
                    padding: '8px 20px', borderRadius: 10,
                    border: salesPeriod === p ? '1px solid var(--accent-gold)' : '1px solid rgba(255,255,255,0.15)',
                    background: salesPeriod === p ? 'rgba(201,162,39,0.15)' : 'transparent',
                    color: salesPeriod === p ? 'var(--text-gold)' : 'var(--text-dim)',
                    cursor: 'pointer', fontSize: '0.9rem', textTransform: 'capitalize'
                  }}
                >
                  {p === 'all' ? 'All Time' : p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>

            {salesReport && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {[
                  { label: 'Total Sales', value: salesReport.totalSales },
                  { label: 'Total Revenue', value: formatRand(salesReport.totalRevenue) },
                  { label: 'Coin 1 Sales', value: salesReport.coin1Sales },
                  { label: 'Coin 1 Revenue', value: formatRand(salesReport.coin1Revenue) },
                  { label: 'Coin 2 Sales', value: salesReport.coin2Sales },
                  { label: 'Coin 2 Revenue', value: formatRand(salesReport.coin2Revenue) }
                ].map(({ label, value }) => (
                  <div key={label}
                    style={{
                      padding: '20px 24px', borderRadius: 16,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(201,162,39,0.15)'
                    }}
                  >
                    <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 6 }}>{label}</p>
                    <p style={{ color: 'var(--text-white)', fontSize: '1.6rem', fontWeight: 700 }}>{value}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TRANSACTIONS ── */}
        {tab === 'transactions' && (
          <div>
            <h3 style={{ color: 'var(--text-white)', marginBottom: 16, fontSize: '1.1rem' }}>
              Recent Transactions (last 100)
            </h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(201,162,39,0.3)' }}>
                    {['Date/Time', 'Transaction ID', 'Coin', 'Amount', 'Payment', 'Dispense'].map((h) => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-gold)', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={t.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '10px 12px', color: 'var(--text-dim)' }}>{t.createdAt.substring(0, 19)}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: '0.78rem' }}>{t.transactionId}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-white)' }}>Coin {t.coinSelected}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-white)' }}>{formatRand(t.amount)}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ color: t.paymentResult === 'approved' ? 'var(--success-green)' : 'var(--error-red)' }}>
                          {t.paymentResult}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{
                          color: t.dispenseResult === 'success' ? 'var(--success-green)'
                            : t.dispenseResult ? 'var(--error-red)'
                            : 'var(--text-dim)'
                        }}>
                          {t.dispenseResult ?? '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {transactions.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: 'var(--text-dim)' }}>
                        No transactions yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── ALERTS (critical: approved but not dispensed) ── */}
        {tab === 'alerts' && (
          <div>
            <h3 style={{ color: 'var(--text-white)', marginBottom: 8, fontSize: '1.1rem' }}>
              Critical Alerts — Payment Approved but Coin Not Dispensed
            </h3>
            <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem', marginBottom: 20 }}>
              These transactions were charged but the coin failed to dispense. Investigate and
              process a manual refund, then mark the alert resolved.
            </p>

            {alerts.length === 0 ? (
              <div
                style={{
                  padding: '32px', textAlign: 'center', color: 'var(--success-green)',
                  border: '1px solid rgba(76,175,80,0.3)', borderRadius: 14,
                  background: 'rgba(76,175,80,0.06)'
                }}
              >
                ✓ No outstanding alerts.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(229,57,53,0.4)' }}>
                      {['Date/Time', 'Transaction ID', 'Coin', 'Amount', 'Dispense', 'Action'].map((h) => (
                        <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--error-red)', fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((a) => (
                      <tr key={a.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '10px 12px', color: 'var(--text-dim)' }}>{a.createdAt.substring(0, 19)}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--text-white)', fontFamily: 'monospace', fontSize: '0.78rem' }}>{a.transactionId}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--text-white)' }}>Coin {a.coinSelected}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--text-white)' }}>{formatRand(a.amount)}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--error-red)' }}>{a.dispenseResult ?? 'not dispensed'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <button
                            onClick={() => handleResolveAlert(a.transactionId)}
                            style={{
                              background: 'rgba(201,162,39,0.15)', border: '1px solid var(--accent-gold)',
                              color: 'var(--text-gold)', padding: '6px 16px',
                              borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem'
                            }}
                          >
                            Mark Resolved
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── DIAGNOSTICS ── */}
        {tab === 'diagnostics' && (
          <div style={{ maxWidth: 480 }}>
            <h3 style={{ color: 'var(--text-white)', marginBottom: 24, fontSize: '1.1rem' }}>System Status</h3>
            {sysStatus ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  { label: 'MDB Bus', ok: sysStatus.mdbConnected },
                  { label: 'Nayax Terminal', ok: sysStatus.nayaxConnected },
                  { label: 'Hopper 1', ok: sysStatus.hopper1.status === 'ok',
                    detail: `${sysStatus.hopper1.status} · ${sysStatus.hopper1.coinCount} coins` },
                  { label: 'Hopper 2', ok: sysStatus.hopper2.status === 'ok',
                    detail: `${sysStatus.hopper2.status} · ${sysStatus.hopper2.coinCount} coins` }
                ].map(({ label, ok, detail }) => (
                  <div key={label}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '16px 20px', borderRadius: 14,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)'
                    }}
                  >
                    <span style={{ color: 'var(--text-white)' }}>
                      <StatusDot ok={ok} />{label}
                    </span>
                    <span style={{ color: ok ? 'var(--success-green)' : 'var(--error-red)', fontSize: '0.9rem' }}>
                      {detail ?? (ok ? 'Connected' : 'Offline')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="spinner" />
            )}

            <button
              onClick={() => window.kiosk.getSystemStatus().then(setSysStatus)}
              style={{
                marginTop: 24, background: 'transparent',
                border: '1px solid rgba(201,162,39,0.4)',
                color: 'var(--text-gold)', padding: '12px 28px',
                borderRadius: 12, cursor: 'pointer', fontSize: '0.95rem'
              }}
            >
              Refresh
            </button>
          </div>
        )}

        {/* ── SYSTEM (configuration — Office role only) ── */}
        {tab === 'system' && !canConfig && (
          <div style={{ maxWidth: 560 }}>
            <p style={{ color: 'var(--text-gold)', fontSize: '1.05rem', marginBottom: 8 }}>
              Configuration is available to the Office role only.
            </p>
            <p style={{ color: 'var(--text-dim)' }}>
              You are signed in as {me?.name} ({me?.role}). Pricing, PIN, fleet connection and mode
              can only be changed by an Office operator or with the device Admin PIN.
            </p>
          </div>
        )}
        {tab === 'system' && canConfig && (
          <div style={{ maxWidth: 560 }}>
            <h3 style={{ color: 'var(--text-white)', marginBottom: 16, fontSize: '1.1rem' }}>
              Coin Price
            </h3>
            <div
              style={{
                padding: '18px 20px', borderRadius: 14, marginBottom: 28,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(201,162,39,0.15)'
              }}
            >
              <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 14 }}>
                Price per coin (applies to both coins).
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: 'var(--text-gold)', fontSize: '1.2rem' }}>R</span>
                <input
                  type="number" min={0} step="0.01"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  onFocus={() => setPriceFocused(true)}
                  onBlur={() => setPriceFocused(false)}
                  style={{
                    width: 140, padding: '10px 14px', borderRadius: 10,
                    border: '1px solid rgba(201,162,39,0.4)',
                    background: 'rgba(255,255,255,0.05)',
                    color: 'var(--text-white)', fontSize: '1.1rem'
                  }}
                />
                <button className="btn btn-gold" style={{ padding: '12px 28px' }} onClick={savePrice}>
                  Save Price
                </button>
                {priceMsg && <span style={{ color: 'var(--success-green)' }}>{priceMsg}</span>}
              </div>
            </div>

            <h3 style={{ color: 'var(--text-white)', marginBottom: 16, fontSize: '1.1rem' }}>
              Transaction Timeout
            </h3>
            <div
              style={{
                padding: '18px 20px', borderRadius: 14, marginBottom: 28,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(201,162,39,0.15)'
              }}
            >
              <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 14 }}>
                If a customer reaches the coin selection or payment screen and walks away, the
                kiosk auto-cancels the pending Nayax transaction and returns to idle after this
                many seconds (10–300).
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="number" min={10} max={300} step={5}
                  value={txTimeout}
                  onChange={(e) => setTxTimeout(e.target.value)}
                  style={{
                    width: 110, padding: '10px 14px', borderRadius: 10,
                    border: '1px solid rgba(201,162,39,0.4)',
                    background: 'rgba(255,255,255,0.05)',
                    color: 'var(--text-white)', fontSize: '1.1rem'
                  }}
                />
                <span style={{ color: 'var(--text-dim)' }}>seconds</span>
                <button className="btn btn-gold" style={{ padding: '12px 28px' }} onClick={saveTxTimeout}>
                  Save
                </button>
                {txTimeoutMsg && <span style={{ color: 'var(--success-green)' }}>{txTimeoutMsg}</span>}
              </div>
            </div>

            <h3 style={{ color: 'var(--text-white)', marginBottom: 16, fontSize: '1.1rem' }}>
              Admin PIN
            </h3>
            <div
              style={{
                padding: '18px 20px', borderRadius: 14, marginBottom: 28,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(201,162,39,0.15)'
              }}
            >
              <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 14 }}>
                PIN to open this Admin panel (tap the top-right corner of the home screen).
                Change it from the default so customers can&rsquo;t get in. 4 to 8 digits.
              </p>
              {([
                ['Current PIN', pinCur, setPinCur, 'current'],
                ['New PIN', pinNew, setPinNew, 'new'],
                ['Confirm new PIN', pinConf, setPinConf, 'confirm']
              ] as [string, string, (v: string) => void, string][]).map(([label, val, set, k]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <label style={{ color: 'var(--text-dim)', width: 130, fontSize: '0.85rem' }}>{label}</label>
                  <input
                    type="password" inputMode="numeric" maxLength={8}
                    value={val}
                    onChange={(e) => set(e.target.value.replace(/\D/g, ''))}
                    style={{
                      width: 160, padding: '9px 12px', borderRadius: 9,
                      border: '1px solid rgba(201,162,39,0.4)',
                      background: 'rgba(255,255,255,0.05)', color: 'var(--text-white)',
                      fontSize: '1rem', letterSpacing: '0.3em'
                    }}
                  />
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-gold" style={{ padding: '12px 28px' }} onClick={savePin}>
                  Change PIN
                </button>
                {pinMsg && (
                  <span style={{ color: pinMsg.ok ? 'var(--success-green)' : 'var(--error-red)', marginLeft: 12 }}>
                    {pinMsg.text}
                  </span>
                )}
              </div>
            </div>

            <h3 style={{ color: 'var(--text-white)', marginBottom: 16, fontSize: '1.1rem' }}>
              Fleet Connection
            </h3>
            <div
              style={{
                padding: '18px 20px', borderRadius: 14, marginBottom: 28,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(201,162,39,0.15)'
              }}
            >
              <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 14 }}>
                Connect this kiosk to the central Fleet Admin server to receive remote
                settings (e.g. price) and report sales/status.{' '}
                <strong style={{ color: fleet.enabled ? 'var(--success-green)' : 'var(--text-dim)' }}>
                  {fleet.enabled ? '● Configured' : '○ Not configured'}
                </strong>
                {fleet.enabled && ` · applied config v${fleet.appliedConfigVersion}`}
              </p>
              {fleet.enabled && (() => {
                const st = fleet.status
                const map: Record<string, { label: string; color: string }> = {
                  ok: { label: '✓ Syncing OK', color: 'var(--success-green)' },
                  auth_failed: { label: '✕ Auth failed — wrong API key', color: 'var(--error-red)' },
                  error: { label: '✕ Server error', color: 'var(--error-red)' },
                  offline: { label: '○ Cannot reach server', color: 'var(--text-gold)' }
                }
                const s = st ? map[st.state] : { label: '… waiting for first sync', color: 'var(--text-dim)' }
                return (
                  <p style={{ color: s.color, fontSize: '0.85rem', marginBottom: 12 }}>
                    {s.label}
                    {st?.at ? ` · ${new Date(st.at).toLocaleTimeString()}` : ''}
                  </p>
                )
              })()}
              {([
                ['Server URL', 'fleetUrl', 'https://fleet.example.com'],
                ['Kiosk ID', 'kioskId', 'kiosk-001'],
                ['API Key', 'fleetApiKey', 'kk_…']
              ] as [string, 'fleetUrl' | 'kioskId' | 'fleetApiKey', string][]).map(([label, k, ph]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <label style={{ color: 'var(--text-dim)', width: 90, fontSize: '0.85rem' }}>{label}</label>
                  <input
                    value={fleet[k]}
                    placeholder={ph}
                    onChange={(e) => setFleet({ ...fleet, [k]: e.target.value })}
                    style={{
                      flex: 1, padding: '9px 12px', borderRadius: 9,
                      border: '1px solid rgba(201,162,39,0.4)',
                      background: 'rgba(255,255,255,0.05)', color: 'var(--text-white)', fontSize: '0.9rem'
                    }}
                  />
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-gold" style={{ padding: '12px 28px' }} onClick={saveFleet}>
                  Save & Connect
                </button>
                {fleetMsg && <span style={{ color: 'var(--success-green)', marginLeft: 12 }}>{fleetMsg}</span>}
              </div>
            </div>

            <h3 style={{ color: 'var(--text-white)', marginBottom: 8, fontSize: '1.1rem' }}>
              Application Mode
            </h3>
            <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem', marginBottom: 20 }}>
              Current mode:{' '}
              <strong style={{ color: mode === 'kiosk' ? 'var(--text-gold)' : 'var(--success-green)' }}>
                {mode === 'kiosk' ? 'KIOSK (locked)' : mode === 'dev' ? 'TEST / DEVELOPER' : '…'}
              </strong>
            </p>

            <div
              style={{
                padding: '18px 20px', borderRadius: 14, marginBottom: 28,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(201,162,39,0.15)'
              }}
            >
              <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 16 }}>
                <strong style={{ color: 'var(--text-white)' }}>Test Mode</strong> runs in a normal window —
                you can close, minimize, and switch apps.{' '}
                <strong style={{ color: 'var(--text-white)' }}>Kiosk Mode</strong> locks the app full-screen
                for live use. Switching restarts the application automatically.
              </p>

              {mode === 'kiosk' ? (
                <button
                  className="btn btn-gold"
                  style={{ fontSize: '1rem', padding: '14px 32px' }}
                  onClick={() => {
                    if (confirm('Switch to TEST mode? The app will restart in a normal window.')) {
                      window.kiosk.setMode('dev')
                    }
                  }}
                >
                  Switch to Test Mode
                </button>
              ) : (
                <button
                  className="btn btn-gold"
                  style={{ fontSize: '1rem', padding: '14px 32px' }}
                  onClick={() => {
                    if (confirm('Switch to KIOSK mode? The app will restart locked full-screen.')) {
                      window.kiosk.setMode('kiosk')
                    }
                  }}
                >
                  Switch to Kiosk Mode
                </button>
              )}
            </div>

            <h3 style={{ color: 'var(--text-white)', marginBottom: 16, fontSize: '1.1rem' }}>
              Application Control
            </h3>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <button
                onClick={() => window.kiosk.restartApp()}
                style={{
                  background: 'transparent', border: '1px solid rgba(201,162,39,0.4)',
                  color: 'var(--text-gold)', padding: '14px 28px',
                  borderRadius: 12, cursor: 'pointer', fontSize: '0.95rem'
                }}
              >
                ⟳ Restart App
              </button>
              <button
                onClick={() => window.kiosk.minimizeApp()}
                style={{
                  background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
                  color: 'var(--text-white)', padding: '14px 28px',
                  borderRadius: 12, cursor: 'pointer', fontSize: '0.95rem'
                }}
              >
                – Minimize
              </button>
              <button
                onClick={() => {
                  if (confirm('Exit the application?')) window.kiosk.quitApp()
                }}
                style={{
                  background: 'rgba(229,57,53,0.15)', border: '1px solid var(--error-red)',
                  color: 'var(--error-red)', padding: '14px 28px',
                  borderRadius: 12, cursor: 'pointer', fontSize: '0.95rem', fontWeight: 600
                }}
              >
                ⏻ Exit Application
              </button>
            </div>

            <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginTop: 28, lineHeight: 1.6 }}>
              Service shortcuts (work even when locked):<br />
              <code>⌘/Ctrl + Alt + Shift + Q</code> — quit ·{' '}
              <code>⌘/Ctrl + Alt + Shift + D</code> — Test mode ·{' '}
              <code>⌘/Ctrl + Alt + Shift + K</code> — Kiosk mode
            </p>
          </div>
        )}

      </div>
    </div>
  )
}
