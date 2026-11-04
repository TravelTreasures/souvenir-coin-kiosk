import { CoinImage } from '../components/CoinImage'
import type { CoinSelection, ComboConfig } from '../types'

interface CoinSelectScreenProps {
  onSelect: (coin: CoinSelection) => void
  onBack: () => void
  priceCents: number
  coinsOn?: { 1: boolean; 2: boolean }
  combo?: ComboConfig | null
}

const cardStyle: React.CSSProperties = {
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
}

function hoverIn(e: React.MouseEvent<HTMLButtonElement>): void {
  const t = e.currentTarget
  t.style.borderColor = 'rgba(201,162,39,0.8)'
  t.style.boxShadow = 'var(--shadow-gold)'
  t.style.transform = 'translateY(-4px)'
}
function hoverOut(e: React.MouseEvent<HTMLButtonElement>): void {
  const t = e.currentTarget
  t.style.borderColor = 'rgba(201,162,39,0.25)'
  t.style.boxShadow = 'none'
  t.style.transform = 'translateY(0)'
}

const priceStyle: React.CSSProperties = { fontSize: '1.1rem', color: 'var(--text-gold)' }
const selectBtnStyle: React.CSSProperties = {
  marginTop: 8,
  padding: '10px 36px',
  borderRadius: 12,
  background: 'linear-gradient(135deg, var(--accent-gold), var(--accent-gold-dark))',
  color: '#fff',
  fontWeight: 700,
  fontSize: '1rem',
  letterSpacing: '0.05em'
}

export function CoinSelectScreen({ onSelect, onBack, priceCents, coinsOn, combo }: CoinSelectScreenProps) {
  const on = coinsOn ?? { 1: true, 2: true }
  const coins = ([1, 2] as CoinSelection[]).filter((c) => on[c as 1 | 2])
  // The combo needs one of each coin, so it only shows when BOTH coins are
  // available and the fleet/kiosk has it enabled.
  const showCombo = !!combo && combo.enabled && on[1] && on[2]

  return (
    <div
      className="screen fade-in"
      style={{
        background: 'radial-gradient(ellipse at center top, var(--bg-mid) 0%, var(--bg-dark) 70%)',
        padding: '60px 40px',
        gap: 0
      }}
    >
      {/* Heading — shifted up visually; the coin cards below stay put. */}
      <div style={{ textAlign: 'center', marginBottom: 16, transform: 'translateY(-150px)' }}>
        <p
          style={{
            color: 'var(--text-gold)',
            fontSize: '1.4rem',
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
            fontSize: 'clamp(2.6rem, 6vw, 4rem)',
            color: 'var(--text-white)'
          }}
        >
          Choose Your Desired Coin
        </h1>
        <div className="gold-divider" />
      </div>

      {/* Product cards: the two individual coins on top, and the Combo Sale
          centred directly underneath them. Pulled up to sit just under the heading. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 28,
          marginTop: -110,
          marginBottom: 40
        }}
      >
        {/* Top row — individual coins */}
        <div
          style={{
            display: 'flex',
            gap: 48,
            alignItems: 'flex-start',
            justifyContent: 'center',
            flexWrap: 'wrap'
          }}
        >
          {coins.map((coin) => (
            <button key={coin} onClick={() => onSelect(coin)} style={cardStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
              <CoinImage coin={coin as 1 | 2} size={170} />
              <div style={{ textAlign: 'center', marginTop: 28 }}>
                <p style={priceStyle}>R{(priceCents / 100).toFixed(2)}</p>
              </div>
              <div style={selectBtnStyle}>Select</div>
            </button>
          ))}
        </div>

        {/* Combo Sale — one of each coin, at the configured combo price. Centred
            below the two individual coins, same card style with both images. */}
        {showCombo && combo && (
          <button onClick={() => onSelect(3)} style={cardStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
            <p
              style={{
                color: 'var(--text-gold)',
                fontSize: '0.85rem',
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                marginBottom: -8
              }}
            >
              Combo Sale
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0 }}>
              <CoinImage coin={1} size={140} style={{ marginRight: -26, zIndex: 2 }} />
              <CoinImage coin={2} size={140} style={{ marginLeft: -26 }} />
            </div>
            <div style={{ textAlign: 'center', marginTop: 24 }}>
              <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 2 }}>Coin 1 + Coin 2</p>
              <p style={priceStyle}>R{(combo.priceCents / 100).toFixed(2)}</p>
            </div>
            <div style={selectBtnStyle}>Select</div>
          </button>
        )}
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
