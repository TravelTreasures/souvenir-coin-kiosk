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
      {/* Heading block — larger and shifted up. transform doesn't reflow, so the
          coin and tray prompt below are positioned independently. */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'translateY(-90px)' }}>
        {/* Checkmark */}
        <div
          style={{
            width: 110,
            height: 110,
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
          <svg width="50" height="50" viewBox="0 0 40 40" fill="none">
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
            fontSize: 'clamp(3.4rem, 8vw, 5.2rem)',
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
            fontSize: 'clamp(1.5rem, 3.6vw, 2.1rem)',
            color: 'var(--text-dim)',
            textAlign: 'center',
            lineHeight: 1.5
          }}
        >
          {coinSelected === 3 ? 'Please collect your two souvenir coins' : 'Please collect your souvenir coin'}
          <br />
          from the collection tray below.
        </p>
      </div>

      {/* Coin (or both coins for a combo) */}
      <div style={{ marginTop: -30, marginBottom: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {coinSelected === 3 ? (
          <>
            <CoinImage coin={1} size={195} style={{ marginRight: -36, zIndex: 2 }} />
            <CoinImage coin={2} size={195} style={{ marginLeft: -36 }} />
          </>
        ) : (
          <CoinImage coin={coinSelected} size={230} />
        )}
      </div>

      {/* Collection tray indicator — bigger text, with arrows that keep moving
          downwards to point the customer at the tray. */}
      <div
        style={{
          background: 'rgba(201,162,39,0.1)',
          border: '1px solid rgba(201,162,39,0.3)',
          borderRadius: 18,
          padding: '22px 48px',
          textAlign: 'center'
        }}
      >
        <p style={{ color: 'var(--text-gold)', fontSize: 'clamp(1.6rem, 3.8vw, 2.2rem)', fontWeight: 700 }}>
          <span className="tray-arrow">↓</span>
          <span style={{ margin: '0 18px' }}>Collect from tray below</span>
          <span className="tray-arrow">↓</span>
        </p>
      </div>
      <div className="tray-chevrons" aria-hidden="true" style={{ marginTop: 14, marginBottom: 34 }}>
        {[0, 1, 2].map((i) => (
          <svg key={i} width="64" height="26" viewBox="0 0 64 26" fill="none" style={{ animationDelay: `${i * 0.18}s` }}>
            <polyline points="6,4 32,22 58,4" stroke="var(--accent-gold)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ))}
      </div>

      {/* Return countdown */}
      <p style={{ color: 'var(--text-dim)', fontSize: '1.1rem' }}>
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
