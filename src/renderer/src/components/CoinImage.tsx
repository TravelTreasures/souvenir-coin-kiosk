/**
 * CoinImage – shows the coin image, or a CSS gold-coin placeholder on error.
 *
 * Image source priority:
 *   1. a remote image pushed from the fleet server (downloaded by the kiosk), else
 *   2. the bundled default in src/renderer/src/assets/coin1.png / coin2.png.
 */

import { useState, useEffect } from 'react'
import coin1Img from '../assets/coin1.png'
import coin2Img from '../assets/coin2.png'

interface CoinImageProps {
  coin: 1 | 2
  size?: number
  label?: string
  className?: string
  style?: React.CSSProperties
}

// Bundled defaults (Vite-imported so they resolve in dev and the packaged app).
const COIN_IMAGES: Record<1 | 2, string> = { 1: coin1Img, 2: coin2Img }

export function CoinImage({ coin, size = 220, label, className = '', style }: CoinImageProps) {
  const [imgError, setImgError] = useState(false)
  const [remoteSrc, setRemoteSrc] = useState<string | null>(null)

  // Pick up a fleet-pushed image for this coin, if one has been downloaded.
  useEffect(() => {
    let active = true
    window.kiosk?.getCoinImages?.().then((imgs) => {
      if (active) setRemoteSrc(imgs?.[coin] ?? null)
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [coin])

  const imgSrc = remoteSrc ?? COIN_IMAGES[coin]

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        position: 'relative',
        ...style
      }}
    >
      <div className="coin-disc">
        {!imgError ? (
          <img src={imgSrc} alt={`Coin ${coin}`} onError={() => setImgError(true)} />
        ) : (
          <span
            style={{
              color: 'rgba(255,255,255,0.85)',
              fontSize: size * 0.24,
              fontWeight: 'bold',
              fontFamily: 'Georgia, serif',
              textShadow: '1px 1px 3px rgba(0,0,0,0.6)',
              letterSpacing: '0.05em'
            }}
          >
            {coin === 1 ? 'I' : 'II'}
          </span>
        )}
        <span className="coin-sheen" />
      </div>

      {label && (
        <div
          style={{
            position: 'absolute',
            bottom: -36,
            left: '50%',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            fontSize: '1.1rem',
            fontWeight: 700,
            color: 'var(--text-gold)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase'
          }}
        >
          {label}
        </div>
      )}
    </div>
  )
}
