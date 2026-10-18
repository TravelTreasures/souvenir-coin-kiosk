import { useEffect, useState } from 'react'
import type { ErrorState } from '../types'

interface ErrorScreenProps {
  error: ErrorState
  /** Auto-return timeout action (respects error.returnTo). */
  onDone: () => void
  /** Explicit "Return Home" button — always goes to the home screen. */
  onReturnHome: () => void
  onRetry?: () => void
}

const ICON: Record<ErrorState['type'], string> = {
  payment_failed:               '💳',
  payment_terminal_unavailable: '📵',
  hopper_empty:                 '⚠️',
  hopper_jam:                   '🔧',
  mdb_comm_failure:             '🔌',
  dispense_failed:              '⚠️'
}

export function ErrorScreen({ error, onDone, onReturnHome, onRetry }: ErrorScreenProps) {
  const returnDelay = error.returnDelay ?? 5000
  const [secondsLeft, setSecondsLeft] = useState(Math.round(returnDelay / 1000))

  useEffect(() => {
    const timer = setTimeout(onDone, returnDelay)
    const ticker = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000)
    return () => {
      clearTimeout(timer)
      clearInterval(ticker)
    }
  }, [returnDelay, onDone])

  const isStaffError =
    error.type === 'payment_terminal_unavailable' ||
    error.type === 'hopper_jam' ||
    error.type === 'mdb_comm_failure' ||
    error.type === 'dispense_failed'

  return (
    <div
      className="screen fade-in"
      style={{
        background: 'radial-gradient(ellipse at center, #1a0a0a 0%, var(--bg-dark) 75%)',
        padding: '60px 40px',
        gap: 0
      }}
    >
      {/* Icon */}
      <div style={{ fontSize: '4rem', marginBottom: 20 }}>{ICON[error.type]}</div>

      {/* Error border panel */}
      <div
        style={{
          border: `2px solid ${isStaffError ? 'rgba(200,80,80,0.5)' : 'rgba(201,162,39,0.4)'}`,
          borderRadius: 24,
          padding: '36px 48px',
          textAlign: 'center',
          maxWidth: 520,
          marginBottom: 40,
          background: 'rgba(0,0,0,0.3)'
        }}
      >
        <h2
          style={{
            fontSize: 'clamp(1.4rem, 3vw, 2rem)',
            color: 'var(--text-white)',
            fontWeight: 700,
            marginBottom: 16,
            lineHeight: 1.3
          }}
        >
          {error.message}
        </h2>

        {error.subMessage && (
          <p
            style={{
              fontSize: '1.1rem',
              color: isStaffError ? 'var(--error-red)' : 'var(--text-dim)',
              lineHeight: 1.5
            }}
          >
            {error.subMessage}
          </p>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 32 }}>
        {onRetry && (
          <button
            onClick={onRetry}
            className="btn btn-gold"
            style={{ fontSize: '1.1rem', padding: '16px 40px' }}
          >
            Try Again
          </button>
        )}
        <button
          onClick={onReturnHome}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.25)',
            color: 'var(--text-dim)',
            padding: '16px 40px',
            borderRadius: 14,
            cursor: 'pointer',
            fontSize: '1.1rem'
          }}
        >
          Return Home
        </button>
      </div>

      <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
        Returning automatically in {secondsLeft}s…
      </p>
    </div>
  )
}
