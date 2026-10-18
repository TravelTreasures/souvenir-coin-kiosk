/**
 * Coin3D — a true 3D coin that spins on its vertical axis, matching the
 * reference video: one full 360° revolution every 8.00s at constant speed
 * (45°/s), showing face → reeded edge → back face → edge → face, with a soft
 * shadow beneath that narrows and widens in sync with the spin.
 *
 * Built from real CSS 3D geometry (not a sprite), so it stays crisp at any
 * size: two opaque faces plus a cylindrical rim made of thin tangential
 * slices, which gives the milled/reeded edge you see when it turns edge-on.
 *
 * Image source priority matches CoinImage: a fleet-pushed image if one has
 * been downloaded, else the bundled default artwork.
 */

import { useEffect, useState } from 'react'
import coin1Img from '../assets/coin1.png'
import coin2Img from '../assets/coin2.png'
import coinBackImg from '../assets/coin-back.png'

const COIN_IMAGES: Record<1 | 2, string> = { 1: coin1Img, 2: coin2Img }

/** Number of slices forming the cylindrical rim. Higher = smoother edge. */
const RIM_SLICES = 40

/** Coin thickness as a fraction of its diameter (reference video ≈ 0.073). */
const THICKNESS_RATIO = 0.075

interface Coin3DProps {
  coin: 1 | 2
  size?: number
  /** Seconds for one full 360° revolution (video reference = 8.00s). */
  spinSeconds?: number
  /** Offset the animation so two coins aren't in lockstep. */
  delaySeconds?: number
}

export function Coin3D({ coin, size = 320, spinSeconds = 8, delaySeconds = 0 }: Coin3DProps): JSX.Element {
  const [remoteSrc, setRemoteSrc] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    window.kiosk?.getCoinImages?.()
      .then((imgs) => { if (active) setRemoteSrc(imgs?.[coin] ?? null) })
      .catch(() => {})
    return () => { active = false }
  }, [coin])

  const src = remoteSrc ?? COIN_IMAGES[coin]

  const r = size / 2
  // Thickness as a fraction of diameter, measured off the reference video: the
  // coin is 19px wide edge-on against a 261px face-on diameter ≈ 7.3%. Gives a
  // satisfying chunky rim rather than a wafer.
  const thickness = Math.max(8, Math.round(size * THICKNESS_RATIO))
  const chord = (2 * Math.PI * r) / RIM_SLICES + 1.5 // +overlap so no gaps show

  // A negative delay starts the turn part-way through; 0 means every coin starts
  // face-on and they all spin in step (as in the reference video).
  const spinStyle: React.CSSProperties = {
    animationDuration: `${spinSeconds}s`,
    animationDelay: delaySeconds ? `${-delaySeconds}s` : '0s'
  }

  return (
    <div className="coin3d" style={{ width: size, height: size }}>
      <div className="coin3d-spin" style={spinStyle}>
        {/* Front face */}
        <div className="coin3d-face" style={{ transform: `translateZ(${thickness / 2}px)` }}>
          <img src={src} alt={`Coin ${coin}`} draggable={false} />
        </div>

        {/* Reverse face — the shared "Treasure Tokens / Africa map" side, as in the
            reference video. The face is pre-rotated 180°, so the artwork already reads
            the right way round when it comes into view — no extra mirroring. */}
        <div
          className="coin3d-face"
          style={{ transform: `rotateY(180deg) translateZ(${thickness / 2}px)` }}
        >
          <img src={coinBackImg} alt="" draggable={false} />
        </div>

        {/* Cylindrical reeded rim */}
        {Array.from({ length: RIM_SLICES }).map((_, i) => (
          <div
            key={i}
            className="coin3d-rim"
            style={{
              width: thickness,
              height: chord,
              marginLeft: -thickness / 2,
              marginTop: -chord / 2,
              transform: `rotateZ(${(i * 360) / RIM_SLICES}deg) translateX(${r}px) rotateY(90deg)`
            }}
          />
        ))}
      </div>

      {/* Shadow — scales with |cos θ| so it tightens as the coin turns edge-on */}
      <div className="coin3d-shadow" style={spinStyle} />
    </div>
  )
}
