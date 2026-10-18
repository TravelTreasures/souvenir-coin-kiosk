import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Coin3D } from '../components/Coin3D'

interface HomeScreenProps {
  onTouch: () => void
  priceCents: number
  promo: { text: string; enabled: boolean } | null
  qr: { enabled: boolean; url: string; caption: string } | null
  coinsOn?: { 1: boolean; 2: boolean }
}

export function HomeScreen({ onTouch, priceCents, promo, qr, coinsOn }: HomeScreenProps) {
  const showPromo = !!promo?.enabled && promo.text.trim().length > 0
  const on = coinsOn ?? { 1: true, 2: true }
  const enabledCoins = ([1, 2] as const).filter((c) => on[c])
  const anyCoins = enabledCoins.length > 0

  // App version — shown discreetly in the corner for field staff/diagnostics.
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    window.kiosk.getAppVersion?.().then(setAppVersion).catch(() => {})
  }, [])

  // Generate the QR image (data URL) whenever the configured link changes.
  const [qrData, setQrData] = useState<string | null>(null)
  const qrActive = !!qr?.enabled && (qr.url || '').trim().length > 0
  useEffect(() => {
    if (!qrActive) {
      setQrData(null)
      return
    }
    QRCode.toDataURL(qr!.url, { margin: 1, width: 320, color: { dark: '#0a1628', light: '#ffffff' } })
      .then(setQrData)
      .catch(() => setQrData(null))
  }, [qrActive, qr?.url])
  return (
    <div
      className="screen fade-in"
      onClick={onTouch}
      style={{
        background: 'radial-gradient(ellipse at center top, var(--bg-mid) 0%, var(--bg-dark) 70%)',
        cursor: 'pointer',
        gap: 0,
        padding: '60px 40px'
      }}
    >
      {/* Promotional banner (pushed from the fleet server) */}
      {showPromo && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(90deg, var(--accent-gold-dark), var(--accent-gold))',
            color: '#1a1205',
            fontWeight: 700,
            fontSize: 'clamp(1rem, 2.2vw, 1.4rem)',
            textAlign: 'center',
            padding: '14px 20px',
            letterSpacing: '0.02em',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
          }}
        >
          {promo!.text}
        </div>
      )}

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 20, marginTop: showPromo ? 40 : 0 }}>
        <p
          style={{
            color: 'var(--text-gold)',
            fontSize: '1rem',
            letterSpacing: '0.25em',
            textTransform: 'uppercase',
            marginBottom: 8
          }}
        >
          Exclusive
        </p>
        <h1
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 'clamp(2rem, 5vw, 3.5rem)',
            color: 'var(--text-white)',
            lineHeight: 1.15,
            textShadow: '0 2px 20px rgba(0,0,0,0.5)'
          }}
        >
          Souvenir Coins
        </h1>
        <div className="gold-divider" />
      </div>

      {/* Coins — only the available ones; a single coin is centered.
          Both start face-on (Big Five / Joburg Zoo) and spin simultaneously:
          a full 360° every 8s at constant speed, exactly as in the reference
          video, each with its shadow synced to the same turn. */}
      <div
        style={{
          display: 'flex',
          gap: 90,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 80,
          marginTop: 40
        }}
      >
        {enabledCoins.map((coin) => (
          <Coin3D key={coin} coin={coin} size={320} spinSeconds={8} />
        ))}
      </div>

      {/* Price banner */}
      {anyCoins && (
        <div
          style={{
            background: 'rgba(201,162,39,0.12)',
            border: '1px solid rgba(201,162,39,0.35)',
            borderRadius: 16,
            padding: '14px 48px',
            marginBottom: 56,
            textAlign: 'center'
          }}
        >
          <span style={{ color: 'var(--text-gold)', fontSize: '1.4rem', fontWeight: 700 }}>
            R{(priceCents / 100).toFixed(2)}
          </span>
          <span style={{ color: 'var(--text-dim)', fontSize: '1rem', marginLeft: 10 }}>
            per coin
          </span>
        </div>
      )}

      {/* Tap prompt — or an unavailable notice if no coins are enabled */}
      {anyCoins ? (
        <div className="pulse" style={{ textAlign: 'center' }}>
          <p
            style={{
              fontSize: 'clamp(1.4rem, 3vw, 2rem)',
              fontWeight: 700,
              color: 'var(--text-white)',
              letterSpacing: '0.05em',
              textShadow: '0 0 30px rgba(201,162,39,0.4)'
            }}
          >
            ✦ Touch Screen to Start ✦
          </p>
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <p
            style={{
              fontSize: 'clamp(1.3rem, 3vw, 1.8rem)',
              fontWeight: 700,
              color: 'var(--text-gold)',
              letterSpacing: '0.05em'
            }}
          >
            Temporarily Unavailable
          </p>
          <p style={{ color: 'var(--text-dim)', marginTop: 8 }}>Please check back soon.</p>
        </div>
      )}

      {/* Footer */}
      <p
        style={{
          position: 'absolute',
          bottom: 28,
          color: 'rgba(255,255,255,0.2)',
          fontSize: '0.75rem',
          letterSpacing: '0.15em',
          textTransform: 'uppercase'
        }}
      >
        Card Payment Only · Contactless Accepted
      </p>

      {/* App version — discreet, bottom-left */}
      {appVersion && (
        <span
          style={{
            position: 'absolute',
            left: 16,
            bottom: 12,
            color: 'rgba(255,255,255,0.18)',
            fontSize: '0.7rem',
            letterSpacing: '0.05em'
          }}
        >
          v{appVersion}
        </span>
      )}

      {/* QR code (bottom-right) */}
      {qrActive && qrData && (
        <div
          style={{
            position: 'absolute',
            right: 28,
            bottom: 24,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6
          }}
        >
          <img
            src={qrData}
            alt="QR code"
            style={{ width: 110, height: 110, borderRadius: 10, background: '#fff', padding: 6 }}
          />
          {qr?.caption ? (
            <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem', maxWidth: 130, textAlign: 'center' }}>
              {qr.caption}
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}
