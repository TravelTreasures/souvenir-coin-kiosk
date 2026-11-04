/** 1 or 2 = an individual coin; 3 = the Combo Sale (one of each coin). */
export type CoinSelection = 1 | 2 | 3

/** Resolved combo config delivered to the renderer. */
export interface ComboConfig {
  enabled: boolean
  priceCents: number
  allowOverride: boolean
  fleetPriceCents: number
  localPriceCents: number | null
}

export type Screen =
  | 'home'
  | 'coin-select'
  | 'payment'
  | 'thank-you'
  | 'error'
  | 'admin'

export interface ErrorState {
  type:
    | 'payment_failed'
    | 'payment_terminal_unavailable'
    | 'hopper_empty'
    | 'hopper_jam'
    | 'mdb_comm_failure'
    | 'dispense_failed'
  message: string
  subMessage?: string
  returnTo: Screen
  returnDelay?: number // ms, default = 5000
}

export interface PaymentResult {
  status: 'dispensed' | 'declined' | 'communication_error' | 'dispense_failed' | 'timeout' | 'out_of_stock'
  transactionId?: string
  errorCode?: string
}
