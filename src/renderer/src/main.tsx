import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Raspberry Pi 5 only: tag the page so global.css can switch off the costly
// effects (see ".perf-lite" rules). Mini-PCs never get this class.
if (window.kiosk?.perfProfile === 'lite') {
  document.documentElement.classList.add('perf-lite')

  // Act on a touch the moment the finger LANDS instead of when it lifts. A
  // normal "click" only fires after the finger is released and the browser has
  // decided it was a tap, which on the Pi is what makes taps feel slightly late.
  // Customer screens only — in Admin a press must still be able to start a
  // scroll, so Admin keeps normal clicks.
  let swallowNextClick = false
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = e.target as HTMLElement | null
      const fast =
        e.pointerType === 'touch' && e.isPrimary &&
        document.body.dataset.screen !== 'admin' &&
        !!el && typeof el.click === 'function'
      swallowNextClick = fast
      if (fast) el!.click()
    },
    true
  )
  // The browser still sends its own click when the finger lifts (however long
  // the finger stayed down). Swallow exactly that one, so a single tap is never
  // counted twice — e.g. landing on a button of the NEXT screen.
  document.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && swallowNextClick) {
        swallowNextClick = false
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    },
    true
  )
}

// NOTE: React.StrictMode is intentionally NOT used here. StrictMode
// double-invokes effects in development, which would run PaymentScreen's
// cleanup (cancelPayment) against a live sale and incorrectly decline it.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
