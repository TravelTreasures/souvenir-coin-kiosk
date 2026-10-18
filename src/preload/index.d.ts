import type { KioskAPI } from './index'

declare global {
  interface Window {
    kiosk: KioskAPI
  }
}

export {}
