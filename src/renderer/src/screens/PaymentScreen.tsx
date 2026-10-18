import { useEffect, useRef, useState } from 'react'
import { CoinImage } from '../components/CoinImage'
import type { CoinSelection, PaymentResult } from '../types'

interface PaymentScreenProps {
  coinSelected: CoinSelection
  onResult: (result: PaymentResult) => void
  onBack: () => void
  priceCents: number
}

type PaymentState = 'waiting' | 'processing' | 'done'

export function PaymentScreen({ coinSelected, onResult, onBack, priceCents }: PaymentScreenProps) {
  const [state, setState] = useState<PaymentState>('waiting')
  const settledRef = useRef(false)

  useEffect(() => {
    let active = true
    setState('processing')

    window.kiosk.requestPayment(coinSelected).then((result: PaymentResult) => {
      settledRef.current = true
      if (!active) return
      setState('done')
      onResult(result)
    })

    return () => {
      active = false
      // Cancel only if the user navigated away before payment completed.
      if (!settledRef.current) window.kiosk.cancelPayment()
    }
  }, [coinSelected, onResult])

  return (
    <div
      className="screen fade-in"
      style={{
        background: 'radial-gradient(ellipse at center top, var(--bg-mid) 0%, var(--bg-dark) 70%)',
        padding: '60px 40px',
        gap: 0
      }}
    >
      {/* Step indicator */}
      <p
        style={{
          color: 'var(--text-gold)',
          fontSize: '1rem',
          letterSpacing: '0.25em',
          textTransform: 'uppercase',
          marginBottom: 16
        }}
      >
        Step 2 of 2
      </p>

      <h1
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: 'clamp(1.8rem, 4vw, 2.6rem)',
          color: 'var(--text-white)',
          marginBottom: 6,
          textAlign: 'center'
        }}
      >
        Complete Payment
      </h1>
      <div className="gold-divider" />

      {/* Selected coin */}
      <div style={{ textAlign: 'center', marginTop: 16, marginBottom: 32 }}>
        <p style={{ color: 'var(--text-dim)', fontSize: '1rem', marginBottom: 18 }}>
          Selected Coin:
        </p>
        <CoinImage coin={coinSelected} size={140} />
      </div>

      {/* Price */}
      <div
        style={{
          background: 'rgba(201,162,39,0.1)',
          border: '1px solid rgba(201,162,39,0.3)',
          borderRadius: 16,
          padding: '16px 56px',
          textAlign: 'center',
          marginBottom: 40
        }}
      >
        <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem', marginBottom: 4 }}>Amount</p>
        <p style={{ color: 'var(--text-gold)', fontSize: '2.4rem', fontWeight: 700 }}>
          R{(priceCents / 100).toFixed(2)}
        </p>
      </div>

      {/* Card tap area */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20,
          marginBottom: 40
        }}
      >
        {/* Contactless icon */}
        <div className="card-pulse">
          <svg
            width="100"
            height="100"
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Card body */}
            <rect x="15" y="30" width="70" height="46" rx="6" fill="rgba(201,162,39,0.15)" stroke="var(--accent-gold)" strokeWidth="2.5"/>
            <rect x="15" y="44" width="70" height="10" fill="rgba(201,162,39,0.3)"/>
            {/* Chip */}
            <rect x="26" y="52" width="16" height="12" rx="2" fill="var(--accent-gold)" opacity="0.7"/>
            {/* Contactless waves */}
            <path d="M72 40 Q80 50 72 60" stroke="var(--accent-gold)" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
            <path d="M78 36 Q90 50 78 64" stroke="var(--accent-gold)" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.6"/>
            <path d="M84 32 Q100 50 84 68" stroke="var(--accent-gold)" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.3"/>
          </svg>
        </div>

        {state === 'processing' ? (
          <p
            style={{
              fontSize: 'clamp(1.2rem, 3vw, 1.7rem)',
              fontWeight: 700,
              color: 'var(--text-white)',
              textAlign: 'center'
            }}
          >
            Please tap your card,<br />phone, or watch to pay.
          </p>
        ) : (
          <div className="spinner" />
        )}

        <p
          style={{
            color: 'var(--text-dim)',
            fontSize: '0.9rem',
            textAlign: 'center',
            maxWidth: 320
          }}
        >
          Tap on the Nayax terminal screen. If no card is presented, the kiosk resets automatically.
        </p>
      </div>

      {/* Back button – only before payment starts */}
      {state === 'waiting' && (
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'var(--text-dim)',
            padding: '14px 40px',
            borderRadius: 14,
            cursor: 'pointer',
            fontSize: '1rem'
          }}
        >
          ← Back
        </button>
      )}
    </div>
  )
}
