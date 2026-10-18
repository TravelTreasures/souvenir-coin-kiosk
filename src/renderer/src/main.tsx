import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// NOTE: React.StrictMode is intentionally NOT used here. StrictMode
// double-invokes effects in development, which would run PaymentScreen's
// cleanup (cancelPayment) against a live sale and incorrectly decline it.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
