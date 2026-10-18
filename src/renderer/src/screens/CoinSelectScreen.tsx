import { CoinImage } from '../components/CoinImage'
import type { CoinSelection } from '../types'

interface CoinSelectScreenProps {
  onSelect: (coin: CoinSelection) => void
  onBack: () => void
  priceCents: number
  coinsOn?: { 1: boolean; 2: boolean }
}

export function CoinSelectScreen({ onSelect, onBack, priceCents, coinsOn }: CoinSelectScreenProps) {
  const on = coinsOn ?? { 1: true, 2: true }
  const coins = ([1, 2] as CoinSelection[]).filter((c) => on[c])
  return (
    <div
      className="screen fade-in"
      style={{
        background: 'radial-gradient(ellipse at center top, var(--bg-mid) 0%, var(--bg-dark) 70%)',
        padding: '60px 40px',
        gap: 0
      }}
    >
      {/* Heading */}
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <p
          style={{
            color: 'var(--text-gold)',
            fontSize: '1rem',
            letterSpacing: '0.25em',
            textTransform: 'uppercase',
            marginBottom: 12
          }}
        >
          Step 1 of 2
        </p>
        <h1
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 'clamp(1.8rem, 4vw, 2.8rem)',
            color: 'var(--text-white)'
          }}
        >
          Choose Your Desired Coin
        </h1>
        <div className="gold-divider" />
      </div>

      {/* Coin cards */}
      <div
        style={{
          display: 'flex',
          gap: 48,
          alignItems: 'flex-start',
          justifyContent: 'center',
          marginTop: 24,
          marginBottom: 60
        }}
      >
        {coins.map((coin) => (
          <button
            key={coin}
            onClick={() => onSelect(coin)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 24,
              padding: '36px 40px 32px',
              background: 'rgba(255,255,255,0.04)',
              border: '2px solid rgba(201,162,39,0.25)',
              borderRadius: 28,
              cursor: 'pointer',
              transition: 'transform 0.15s, border-color 0.2s, box-shadow 0.2s',
              minWidth: 260
            }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(201,162,39,0.8)'
              ;(e.currentTarget as HTMLButtonElement).style.boxShadow = 'var(--shadow-gold)'
              ;(e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-4px)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(201,162,39,0.25)'
              ;(e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'
              ;(e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'
            }}
          >
            <CoinImage coin={coin} size={190} />

            <div style={{ textAlign: 'center', marginTop: 28 }}>
              <p style={{ fontSize: '1.1rem', color: 'var(--text-gold)' }}>
                R{(priceCents / 100).toFixed(2)}
              </p>
            </div>

            <div
              style={{
                marginTop: 8,
                padding: '10px 36px',
                borderRadius: 12,
                background: 'linear-gradient(135deg, var(--accent-gold), var(--accent-gold-dark))',
                color: '#fff',
                fontWeight: 700,
                fontSize: '1rem',
                letterSpacing: '0.05em'
              }}
            >
              Select
            </div>
          </button>
        ))}
      </div>

      {/* Back */}
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
    </div>
  )
}
