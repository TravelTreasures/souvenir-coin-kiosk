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
import type { Screen, CoinSelection, ErrorState, PaymentResult } from './types'
import { HomeScreen } from './screens/HomeScreen'
import { CoinSelectScreen } from './screens/CoinSelectScreen'
import { PaymentScreen } from './screens/PaymentScreen'
import { ThankYouScreen } from './screens/ThankYouScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { AdminScreen } from './screens/AdminScreen'
import { AdminPIN } from './components/AdminPIN'
import { MarketingScreensaver } from './components/MarketingScreensaver'
import { VirtualKeyboard } from './components/VirtualKeyboard'

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
  const refreshPrice = useCallback(() => {
    // Numbers: React already bails when the value is identical.
    window.kiosk.getConfig().then((c) => setPriceCents(c.coinPriceCents))
    window.kiosk.getTransactionTimeout?.().then((s) => setTxTimeoutSec(s || 45)).catch(() => {})
    window.kiosk.getCoinsEnabled?.().then((c) => {
      const next = { 1: c['1'] !== false, 2: c['2'] !== false }
      setCoinsOn((prev) => (prev[1] === next[1] && prev[2] === next[2] ? prev : next))
    }).catch(() => {})
    window.kiosk.getPromo?.().then((p) => setPromo((prev) => (sameJSON(prev, p) ? prev : p))).catch(() => {})
    window.kiosk.getQR?.().then((q) => setQr((prev) => (sameJSON(prev, q) ? prev : q))).catch(() => {})
    window.kiosk.getMarketing?.().then((m) => setMarketing((prev) => (sameJSON(prev, m) ? prev : m))).catch(() => {})
  }, [])
  useEffect(() => {
    refreshPrice()
    // Re-poll config periodically so fleet changes (price, marketing, promo)
    // take effect while the kiosk sits idle, without a restart or navigation.
    const t = setInterval(refreshPrice, 20_000)
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
    const enabled = ([1, 2] as CoinSelection[]).filter((c) => coinsOn[c])
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

      if (result.status === 'declined') {
        setError({
          type: 'payment_failed',
          message: 'Payment Failed.',
          subMessage: 'Please try again.',
          returnTo: 'payment',
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
            subMessage: 'Please choose another coin or contact staff.\nA refund will be processed.',
            returnTo: 'coin-select',
            returnDelay: 8000
          })
        } else if (errorCode === 'HOPPER_JAM') {
          setError({
            type: 'hopper_jam',
            message: 'Dispensing Error.',
            subMessage: 'Please contact staff.',
            returnTo: 'home',
            returnDelay: 8000
          })
        } else {
          setError({
            type: 'dispense_failed',
            message: 'Dispensing Error.',
            subMessage: 'Payment taken. Please contact staff for a refund.',
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

  // ── Render ──────────────────────────────────────────────────────
  return (
    <>
      {/* Invisible admin tap zone – top-right 80×80 px */}
      {screen === 'home' && (
        <div
          onClick={handleAdminTap}
          style={{
            position: 'fixed', top: 0, right: 0,
            width: 120, height: 120, zIndex: 800,
            cursor: 'default'
          }}
        />
      )}

      {screen === 'home' && (
        <HomeScreen onTouch={handleHomeTouch} priceCents={priceCents} promo={promo} qr={qr} coinsOn={coinsOn} />
      )}

      {screen === 'coin-select' && (
        <CoinSelectScreen onSelect={handleCoinSelect} onBack={goHome} priceCents={priceCents} coinsOn={coinsOn} />
      )}

      {screen === 'payment' && (
        <PaymentScreen
          coinSelected={coinSelected}
          onResult={handlePaymentResult}
          onBack={() => setScreen('coin-select')}
          priceCents={priceCents}
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
          onRetry={
            error.type === 'payment_failed'
              ? () => { setError(null); setScreen('payment') }
              : undefined
          }
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

      {/* On-screen keyboard for touch input — shows only when a field is focused */}
      <VirtualKeyboard />
    </>
  )
}
