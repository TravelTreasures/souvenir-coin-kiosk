/**
 * AdminPIN – a full-screen PIN entry overlay.
 *
 * Accepts a variable-length PIN (4–8 digits): the device Admin PIN OR any
 * operator's PIN, which may be different lengths. The operator types their PIN
 * and presses the ✓ (enter) key. The value is validated in the main process,
 * so it is never exposed to the renderer.
 */

import { useState, useEffect } from 'react'

interface AdminPINProps {
  onSuccess: () => void
  onCancel: () => void
}

const MAX_LEN = 8
const MIN_LEN = 4

export function AdminPIN({ onSuccess, onCancel }: AdminPINProps) {
  const [entered, setEntered] = useState('')
  const [shake, setShake] = useState(false)
  const [lockLeft, setLockLeft] = useState(0) // seconds remaining while locked out
  const [error, setError] = useState('')

  // Count down the lockout timer.
  useEffect(() => {
    if (lockLeft <= 0) return
    const id = setInterval(() => setLockLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(id)
  }, [lockLeft])

  const locked = lockLeft > 0

  const submit = async (pin: string): Promise<void> => {
    if (pin.length < MIN_LEN) {
      setError(`Enter at least ${MIN_LEN} digits`)
      setTimeout(() => setError(''), 1500)
      return
    }
    const res = await window.kiosk
      .verifyPin(pin)
      .catch(() => ({ ok: false }) as Awaited<ReturnType<typeof window.kiosk.verifyPin>>)
    if (res.ok) {
      onSuccess()
      return
    }
    setShake(true)
    setError('Invalid PIN')
    setTimeout(() => {
      setEntered('')
      setShake(false)
      setError('')
    }, 800)
    if (res.locked && res.retryInMs) setLockLeft(Math.ceil(res.retryInMs / 1000))
  }

  const handleDigit = (d: string): void => {
    if (locked || entered.length >= MAX_LEN) return
    setEntered((e) => e + d)
  }
  const handleDelete = (): void => setEntered((e) => e.slice(0, -1))

  // Bottom row: delete · 0 · enter(✓)
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓']

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,12,28,0.95)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <h2 style={{ color: 'var(--text-gold)', fontSize: '1.8rem', marginBottom: 8 }}>
        Enter PIN
      </h2>
      <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem', marginBottom: 24 }}>
        Type your 4–8 digit PIN, then press ✓
      </p>

      {locked && (
        <p style={{ color: 'var(--error-red)', marginBottom: 16, fontSize: '1rem', textAlign: 'center' }}>
          Too many attempts.<br />Try again in {lockLeft}s.
        </p>
      )}

      {/* PIN dots (up to MAX_LEN, filled = entered length) */}
      <div
        style={{
          display: 'flex',
          gap: 14,
          marginBottom: 14,
          animation: shake ? 'shake 0.4s ease' : undefined
        }}
      >
        {Array.from({ length: MAX_LEN }).map((_, i) => (
          <div
            key={i}
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: i < entered.length ? 'var(--accent-gold)' : 'transparent',
              border: `2px solid ${i < entered.length ? 'var(--accent-gold)' : 'rgba(201,162,39,0.35)'}`,
              transition: 'background 0.1s'
            }}
          />
        ))}
      </div>
      <div style={{ height: 22, marginBottom: 18, color: 'var(--error-red)', fontSize: '0.9rem' }}>
        {error}
      </div>

      {/* Keypad */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 88px)',
          gap: 12,
          opacity: locked ? 0.35 : 1,
          pointerEvents: locked ? 'none' : 'auto'
        }}
      >
        {keys.map((d) => {
          const isEnter = d === '✓'
          const isDel = d === '⌫'
          return (
            <button
              key={d}
              onClick={() => (isEnter ? submit(entered) : isDel ? handleDelete() : handleDigit(d))}
              style={{
                height: 88,
                borderRadius: 12,
                border: isEnter ? 'none' : '2px solid rgba(201,162,39,0.4)',
                background: isEnter
                  ? 'linear-gradient(135deg, var(--accent-gold), var(--accent-gold-dark))'
                  : 'rgba(201,162,39,0.1)',
                color: isEnter ? '#1a1205' : 'var(--text-white)',
                fontSize: '1.8rem',
                fontWeight: isEnter ? 800 : 400,
                cursor: 'pointer',
                transition: 'background 0.15s'
              }}
            >
              {d}
            </button>
          )
        })}
      </div>

      <button
        onClick={onCancel}
        style={{
          marginTop: 28,
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.2)',
          color: 'var(--text-dim)',
          padding: '12px 32px',
          borderRadius: 10,
          cursor: 'pointer',
          fontSize: '1rem'
        }}
      >
        Cancel
      </button>

      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%      { transform: translateX(-10px); }
          40%      { transform: translateX(10px); }
          60%      { transform: translateX(-10px); }
          80%      { transform: translateX(10px); }
        }
      `}</style>
    </div>
  )
}
