import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Raspberry Pi 5 only: tag the page so global.css can switch off the costly
// effects (see ".perf-lite" rules). Mini-PCs never get this class.
if (window.kiosk?.perfProfile === 'lite') document.documentElement.classList.add('perf-lite')

// NOTE: React.StrictMode is intentionally NOT used here. StrictMode
// double-invokes effects in development, which would run PaymentScreen's
// cleanup (cancelPayment) against a live sale and incorrectly decline it.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
