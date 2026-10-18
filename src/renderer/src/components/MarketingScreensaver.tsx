interface Props {
  image: string // a single data URL
}

/**
 * Full-screen marketing image shown while the kiosk is idle on the home screen.
 * Timing and which image to show are controlled by App; this is presentational.
 * Any touch/keypress is handled globally in App to dismiss it back to home.
 */
export function MarketingScreensaver({ image }: Props) {
  if (!image) return null
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <img src={image} alt="Promotion" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      <div
        style={{
          position: 'absolute',
          bottom: 28,
          color: 'rgba(255,255,255,0.65)',
          fontSize: '1rem',
          letterSpacing: '0.1em',
          textTransform: 'uppercase'
        }}
      >
        Touch to begin
      </div>
    </div>
  )
}
