/**
 * App – top-level screen router for the kiosk.
 *
 * Screen flow:
 *   home → coin-select → payment → thank-you
 *                              ↘ error
 *
 * Admin: triple-tap top-right corner on the home screen.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { Screen, CoinSelection, ErrorState, PaymentResult, ComboConfig } from './types'
import { HomeScreen } from './screens/HomeScreen'
import { CoinSelectScreen } from './screens/CoinSelectScreen'
import { PaymentScreen } from './screens/PaymentScreen'
import { ThankYouScreen } from './screens/ThankYouScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { AdminScreen } from './screens/AdminScreen'
import { AdminPIN } from './components/AdminPIN'
import { MarketingScreensaver } from './components/MarketingScreensaver'
import { VirtualKeyboard } from './components/VirtualKeyboard'
import { reloadCoinImages } from './coinImagesStore'

interface MarketingConfig {
  enabled: boolean
  slideSeconds: number
  idleSeconds: number
  activeStart: string
  activeEnd: string
  images: string[]
}

// Cheap deep-equality for small config objects, so a re-poll only updates React
// state (and re-renders) when the content genuinely changed.
function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function withinActiveHours(m: MarketingConfig): boolean {
  if (!m.activeStart || !m.activeEnd) return true
  const now = new Date()
  const hm = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = m.activeStart.split(':').map(Number)
  const [eh, em] = m.activeEnd.split(':').map(Number)
  const s = sh * 60 + sm
  const e = eh * 60 + em
  return s <= e ? hm >= s && hm <= e : hm >= s || hm <= e
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [coinSelected, setCoinSelected] = useState<CoinSelection>(1)
  const [error, setError] = useState<ErrorState | null>(null)
  const [showAdminPIN, setShowAdminPIN] = useState(false)
  const [priceCents, setPriceCents] = useState(9000)
  const [txTimeoutSec, setTxTimeoutSec] = useState(45)
  const [coinsOn, setCoinsOn] = useState<{ 1: boolean; 2: boolean }>({ 1: true, 2: true })
  const [combo, setCombo] = useState<ComboConfig | null>(null)
  const [opStatus, setOpStatus] = useState('active')
  const [promo, setPromo] = useState<{ text: string; enabled: boolean } | null>(null)
  const [qr, setQr] = useState<{ enabled: boolean; url: string; caption: string } | null>(null)
  const [marketing, setMarketing] = useState<MarketingConfig | null>(null)
  const [showSaver, setShowSaver] = useState(false)
  const [saverIdx, setSaverIdx] = useState(0)
  const marketingRef = useRef<MarketingConfig | null>(null)
  const showSaverRef = useRef(false)
  useEffect(() => { marketingRef.current = marketing }, [marketing])
  useEffect(() => { showSaverRef.current = showSaver }, [showSaver])

  // Load the configured coin price (and refresh it whenever we return home,
  // so price changes made in Admin take effect without a restart).
  // Re-poll config, but only push new state when a value ACTUALLY changed.
  // Returning the previous reference from a setter makes React bail out, so an
  // unchanged poll triggers zero re-renders (no screen flicker every 20s).
  const coinSigRef = useRef<string | null>(null)
  const marketingSigRef = useRef<string | null>(null)
  const refreshPrice = useCallback(() => {
    // ONE small call for all settings. The big pictures (coin images, marketing
    // slides) are fetched separately and ONLY when their signature changes —
    // they used to be re-sent in full on every poll.
    window.kiosk.getLiveConfig().then((c) => {
      setPriceCents(c.coinPriceCents) // numbers: React bails when identical
      setTxTimeoutSec(c.transactionTimeoutSeconds || 45)
      const next = { 1: c.coinsEnabled['1'] !== false, 2: c.coinsEnabled['2'] !== false }
      setCoinsOn((prev) => (prev[1] === next[1] && prev[2] === next[2] ? prev : next))
      setCombo((prev) => (sameJSON(prev, c.combo) ? prev : c.combo))
      setOpStatus(c.operationalStatus || 'active')
      setPromo((prev) => (sameJSON(prev, c.promo) ? prev : c.promo))
      setQr((prev) => (sameJSON(prev, c.qr) ? prev : c.qr))
      if (c.coinImagesSig !== coinSigRef.current) {
        coinSigRef.current = c.coinImagesSig
        void reloadCoinImages()
      }
      if (c.marketingSig !== marketingSigRef.current) {
        const sig = c.marketingSig
        window.kiosk.getMarketing?.().then((m) => { marketingSigRef.current = sig; setMarketing(m) }).catch(() => {})
      }
    }).catch(() => {})
  }, [])
  useEffect(() => {
    refreshPrice()
    // Re-poll config periodically so fleet changes (price, marketing, promo)
    // take effect while the kiosk sits idle, without a restart or navigation.
    const t = setInterval(refreshPrice, 8_000)
    return () => clearInterval(t)
  }, [refreshPrice])

  // Idle → marketing image cycle. Behaviour: idle for idleSeconds → show one
  // image full-screen for slideSeconds → return home → idle → show the NEXT
  // image → and so on. Any touch returns home and advances to the next image.
  // Keyed on a signature (not the marketing object) so the 20s config re-poll
  // doesn't reset the timers.
  const mkSig = marketing
    ? `${marketing.enabled}|${marketing.idleSeconds}|${marketing.slideSeconds}|${marketing.images.length}`
    : 'none'
  useEffect(() => {
    let idleT: ReturnType<typeof setTimeout> | undefined
    let showT: ReturnType<typeof setTimeout> | undefined
    const eligible = (): boolean => {
      const m = marketingRef.current
      return screen === 'home' && !!m && m.enabled && m.images.length > 0 && withinActiveHours(m)
    }
    const clearTimers = (): void => { if (idleT) clearTimeout(idleT); if (showT) clearTimeout(showT) }
    const scheduleIdle = (): void => {
      clearTimers()
      setShowSaver(false)
      const m = marketingRef.current
      if (eligible() && m) idleT = setTimeout(showOne, Math.max(3, m.idleSeconds) * 1000)
    }
    const showOne = (): void => {
      const m = marketingRef.current
      if (!eligible() || !m) return
      setShowSaver(true)
      showT = setTimeout(() => {
        setShowSaver(false)
        setSaverIdx((x) => x + 1) // next idle shows the next image
        scheduleIdle()
      }, Math.max(2, m.slideSeconds) * 1000)
    }
    const onActivity = (): void => {
      if (showSaverRef.current) setSaverIdx((x) => x + 1)
      scheduleIdle()
    }
    scheduleIdle()
    window.addEventListener('pointerdown', onActivity)
    window.addEventListener('keydown', onActivity)
    return () => {
      clearTimers()
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
    }
  }, [screen, mkSig])

  // Triple-tap to open admin (tap counter on home screen header)
  const adminTapCount = useRef(0)
  const adminTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleAdminTap = useCallback(() => {
    adminTapCount.current += 1
    if (adminTapTimer.current) clearTimeout(adminTapTimer.current)
    adminTapTimer.current = setTimeout(() => { adminTapCount.current = 0 }, 1500)
    if (adminTapCount.current >= 5) {
      adminTapCount.current = 0
      setShowAdminPIN(true)
    }
  }, [])

  // Keyboard shortcut to open the admin PIN from any screen: Cmd/Ctrl+Shift+A.
  // (Convenient for testing; the invisible corner tap still works for touch.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setShowAdminPIN(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Tell the Pi-only fast-tap handler (main.tsx) which screen is showing.
  useEffect(() => { document.body.dataset.screen = screen }, [screen])

  // ── Navigation helpers ──────────────────────────────────────────
  const goHome = useCallback(() => {
    setScreen('home')
    setError(null)
    refreshPrice()
  }, [refreshPrice])

  // Abandoned-transaction guard: if the customer reaches product selection and
  // walks away without choosing, auto-cancel the pending Nayax transaction and
  // return to idle after the configured timeout. Any touch/keypress resets it.
  // (The payment screen is covered separately by the Nayax sale timeout.)
  useEffect(() => {
    if (screen !== 'coin-select') return
    let t: ReturnType<typeof setTimeout>
    const reset = (): void => {
      clearTimeout(t)
      t = setTimeout(() => {
        window.kiosk.abandonTransaction?.('selection_timeout').catch(() => {})
        goHome()
      }, Math.max(10, txTimeoutSec) * 1000)
    }
    reset()
    window.addEventListener('pointerdown', reset)
    window.addEventListener('keydown', reset)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointerdown', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [screen, txTimeoutSec, goHome])

  const handleCoinSelect = useCallback((coin: CoinSelection) => {
    setCoinSelected(coin)
    setScreen('payment')
  }, [])

  // From the home screen: if only one coin is available, skip selection and go
  // straight to payment for it; if both, show the selection screen.
  const handleHomeTouch = useCallback(() => {
    const enabled = ([1, 2] as (1 | 2)[]).filter((c) => coinsOn[c])
    if (enabled.length === 1) {
      setCoinSelected(enabled[0])
      setScreen('payment')
    } else if (enabled.length >= 2) {
      setScreen('coin-select')
    }
    // none enabled → stay on home (it shows "temporarily unavailable")
  }, [coinsOn])

  const handlePaymentResult = useCallback(
    (result: PaymentResult) => {
      if (result.status === 'dispensed') {
        setScreen('thank-you')
        return
      }

      // No card presented in time — the customer left. Quietly return to idle
      // (no error screen); the terminal has already been reset.
      if (result.status === 'timeout') {
        goHome()
        return
      }

      // Selected hopper is empty — checked BEFORE any card charge. Ask the
      // customer to choose the other coin. No payment was taken.
      if (result.status === 'out_of_stock') {
        setError({
          type: 'hopper_empty',
          message: 'Selected Coin Currently Unavailable.',
          subMessage: 'Please choose another coin or contact staff.',
          returnTo: 'coin-select',
          returnDelay: 8000
        })
        setScreen('error')
        return
      }

      // Payment not completed (declined, cancelled or failed at the reader).
      // Cancel the whole transaction and return to the start for a NEW purchase —
      // the customer is never asked to complete the same payment a second time.
      // The declined sale already closed the Nayax session (reader is idle), so no
      // extra reset is needed — sending one now would be an out-of-sequence command.
      if (result.status === 'declined') {
        setError({
          type: 'payment_failed',
          message: 'Payment Not Completed.',
          subMessage: 'Transaction cancelled. Please take your card.\nReturning to the start.',
          returnTo: 'home',
          returnDelay: 5000
        })
        setScreen('error')
        return
      }

      if (result.status === 'communication_error') {
        setError({
          type: 'payment_terminal_unavailable',
          message: 'Payment Terminal Unavailable.',
          subMessage: 'Please contact staff.',
          returnTo: 'home',
          returnDelay: 8000
        })
        setScreen('error')
        return
      }

      if (result.status === 'dispense_failed') {
        const errorCode = result.errorCode ?? ''
        if (errorCode === 'HOPPER_EMPTY') {
          setError({
            type: 'hopper_empty',
            message: 'Selected Coin Currently Unavailable.',
            subMessage: 'Your coin was not dispensed and your payment is being cancelled.\nIf your card is still charged, please contact staff.',
            returnTo: 'coin-select',
            returnDelay: 8000
          })
        } else if (errorCode === 'HOPPER_JAM') {
          setError({
            type: 'hopper_jam',
            message: 'Dispensing Error.',
            subMessage: 'Your coin was not dispensed and your payment is being cancelled.\nIf your card is still charged, please contact staff.',
            returnTo: 'home',
            returnDelay: 10000
          })
        } else {
          setError({
            type: 'dispense_failed',
            message: 'Dispensing Error.',
            subMessage: 'Your coin was not dispensed and your payment is being cancelled.\nIf your card is still charged, please contact staff.',
            returnTo: 'home',
            returnDelay: 10000
          })
        }
        setScreen('error')
      }
    },
    [goHome]
  )

  const handleErrorDone = useCallback(() => {
    if (!error) { goHome(); return }
    setScreen(error.returnTo === 'payment' ? 'payment' : error.returnTo === 'coin-select' ? 'coin-select' : 'home')
    setError(null)
  }, [error, goHome])

  // Fleet "maintenance" / "out of service" takes the kiosk offline to customers.
  const serving = opStatus === 'active'

  // When the kiosk goes offline mid-flow, drop any customer screen back to a safe
  // state so it doesn't resume a stale payment when it comes back. Admin stays put.
  useEffect(() => {
    if (!serving) setScreen((s) => (s === 'admin' ? s : 'home'))
  }, [serving])

  // ── Render ──────────────────────────────────────────────────────
  return (
    <>
      {/* Invisible admin tap zone – top-right 80×80 px (also while offline, so
          staff can reach Admin to bring it back). */}
      {(screen === 'home' || !serving) && screen !== 'admin' && (
        <div
          onClick={handleAdminTap}
          style={{
            position: 'fixed', top: 0, right: 0,
            width: 120, height: 120, zIndex: 800,
            cursor: 'default'
          }}
        />
      )}

      {/* Out of service / maintenance — customer-facing unavailable screen. The
          wording differs: "maintenance" is temporary, "out of service" is closed. */}
      {!serving && screen !== 'admin' && (
        <div
          className="screen fade-in"
          style={{
            background: 'radial-gradient(ellipse at center, #1a140a 0%, var(--bg-dark) 75%)',
            padding: '60px 40px',
            gap: 0,
            textAlign: 'center'
          }}
        >
          <div style={{ fontSize: '4.5rem', marginBottom: 24 }}>{opStatus === 'out_of_service' ? '⛔' : '🛠️'}</div>
          <h1
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 'clamp(2.2rem, 5vw, 3.4rem)',
              color: 'var(--text-white)',
              marginBottom: 16
            }}
          >
            {opStatus === 'out_of_service' ? 'Out of Service' : 'Temporarily Unavailable'}
          </h1>
          <div className="gold-divider" style={{ marginBottom: 24 }} />
          <p style={{ color: 'var(--text-dim)', fontSize: 'clamp(1.1rem, 3vw, 1.5rem)', maxWidth: 520, lineHeight: 1.5 }}>
            {opStatus === 'out_of_service' ? (
              <>This kiosk is currently out of service.<br />We apologise for the inconvenience.</>
            ) : (
              <>This kiosk is currently under maintenance.<br />Please check back shortly.</>
            )}
          </p>
        </div>
      )}

      {screen === 'home' && serving && (
        <HomeScreen onTouch={handleHomeTouch} priceCents={priceCents} promo={promo} qr={qr} coinsOn={coinsOn} />
      )}

      {screen === 'coin-select' && (
        <CoinSelectScreen onSelect={handleCoinSelect} onBack={goHome} priceCents={priceCents} coinsOn={coinsOn} combo={combo} />
      )}

      {screen === 'payment' && (
        <PaymentScreen
          coinSelected={coinSelected}
          onResult={handlePaymentResult}
          onBack={() => setScreen('coin-select')}
          priceCents={coinSelected === 3 && combo ? combo.priceCents : priceCents}
        />
      )}

      {screen === 'thank-you' && (
        <ThankYouScreen coinSelected={coinSelected} onDone={goHome} />
      )}

      {screen === 'error' && error && (
        <ErrorScreen
          error={error}
          onDone={handleErrorDone}
          onReturnHome={goHome}
        />
      )}

      {screen === 'admin' && <AdminScreen onClose={goHome} />}

      {/* Admin PIN overlay */}
      {showAdminPIN && (
        <AdminPIN
          onSuccess={() => { setShowAdminPIN(false); setScreen('admin') }}
          onCancel={() => setShowAdminPIN(false)}
        />
      )}

      {/* Marketing attract loop on the home screen only — one image per idle cycle */}
      {showSaver && marketing && marketing.images.length > 0 && screen === 'home' && (
        <MarketingScreensaver image={marketing.images[saverIdx % marketing.images.length]} />
      )}

      {/* On-screen keyboard for touch input — mounted ONLY on the admin screen,
          so it can never appear on a customer-facing screen. */}
      {screen === 'admin' && <VirtualKeyboard />}
    </>
  )
}
