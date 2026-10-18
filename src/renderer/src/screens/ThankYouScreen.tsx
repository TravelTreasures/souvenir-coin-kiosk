import { useEffect, useState } from 'react'
import { CoinImage } from '../components/CoinImage'
import type { CoinSelection } from '../types'

interface ThankYouScreenProps {
  coinSelected: CoinSelection
  onDone: () => void
  delay?: number // ms before auto-returning home, default 8000
}

export function ThankYouScreen({ coinSelected, onDone, delay = 8000 }: ThankYouScreenProps) {
  const [secondsLeft, setSecondsLeft] = useState(Math.round(delay / 1000))

  useEffect(() => {
    const timer = setTimeout(onDone, delay)
    const ticker = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000)
    return () => {
      clearTimeout(timer)
      clearInterval(ticker)
    }
  }, [delay, onDone])

  return (
    <div
      className="screen fade-in"
      style={{
        background: 'radial-gradient(ellipse at center, #0d2040 0%, var(--bg-dark) 75%)',
        padding: '60px 40px',
        gap: 0
      }}
    >
      {/* Checkmark */}
      <div
        style={{
          width: 90,
          height: 90,
          borderRadius: '50%',
          background: 'rgba(76,175,80,0.15)',
          border: '3px solid var(--success-green)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 28,
          boxShadow: '0 0 30px rgba(76,175,80,0.3)'
        }}
      >
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <polyline
            points="8,21 17,30 33,12"
            stroke="var(--success-green)"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <h1
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: 'clamp(2.5rem, 6vw, 4rem)',
          color: 'var(--text-white)',
          textAlign: 'center',
          marginBottom: 10,
          textShadow: '0 0 30px rgba(255,255,255,0.2)'
        }}
      >
        Thank You!
      </h1>

      <div className="gold-divider" style={{ marginBottom: 28 }} />

      <p
        style={{
          fontSize: 'clamp(1.2rem, 3vw, 1.7rem)',
          color: 'var(--text-dim)',
          textAlign: 'center',
          lineHeight: 1.5,
          marginBottom: 40
        }}
      >
        Please collect your souvenir coin
        <br />
        from the collection tray below.
      </p>

      {/* Coin */}
      <div style={{ marginBottom: 48 }}>
        <CoinImage coin={coinSelected} size={160} />
      </div>

      {/* Collection tray indicator */}
      <div
        style={{
          background: 'rgba(201,162,39,0.1)',
          border: '1px solid rgba(201,162,39,0.3)',
          borderRadius: 16,
          padding: '18px 40px',
          textAlign: 'center',
          marginBottom: 40
        }}
      >
        <p style={{ color: 'var(--text-gold)', fontSize: '1.1rem' }}>
          ↓ Collect from tray below ↓
        </p>
      </div>

      {/* Return countdown */}
      <p style={{ color: 'var(--text-dim)', fontSize: '0.95rem' }}>
        Returning to home in {secondsLeft}s…
      </p>

      <button
        onClick={onDone}
        style={{
          marginTop: 20,
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.2)',
          color: 'var(--text-dim)',
          padding: '12px 36px',
          borderRadius: 12,
          cursor: 'pointer',
          fontSize: '0.95rem'
        }}
      >
        Return Home Now
      </button>
    </div>
  )
}
