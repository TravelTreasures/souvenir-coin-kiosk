/**
 * Preload script for the main kiosk window.
 * Exposes a typed API to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron'

const kioskAPI = {
  // Payment (coinSelected: 1 | 2 = individual coin, 3 = Combo Sale)
  requestPayment: (coinSelected: 1 | 2 | 3) =>
    ipcRenderer.invoke('payment:request', coinSelected),
  cancelPayment: () => ipcRenderer.invoke('payment:cancel'),
  abandonTransaction: (reason?: string) => ipcRenderer.invoke('payment:abandon', reason),

  // MDB status
  getMDBStatus: (address: number) => ipcRenderer.invoke('mdb:status', address),
  isMDBConnected: () => ipcRenderer.invoke('mdb:isConnected'),

  // Admin
  getHopperCounts: () => ipcRenderer.invoke('admin:getHopperCounts'),
  setHopperCount: (hopperId: 1 | 2, count: number) =>
    ipcRenderer.invoke('admin:setHopperCount', hopperId, count),

  // Hopper maintenance (empty / refill / audit history) — attributed to the
  // authenticated operator automatically.
  emptyHopper: (hopperId: 1 | 2, quantity: number | 'all'): Promise<{ ok: boolean; error?: string; dispensed?: number; oldStock?: number; newStock?: number }> =>
    ipcRenderer.invoke('maintenance:emptyHopper', hopperId, quantity),
  refillHopper: (hopperId: 1 | 2, tokensAdded: number): Promise<{ ok: boolean; error?: string; oldStock?: number; added?: number; newStock?: number }> =>
    ipcRenderer.invoke('maintenance:refillHopper', hopperId, tokensAdded),
  getHopperEvents: (): Promise<Array<{ id: number; hopperId: 1 | 2; type: 'empty' | 'refill'; quantity: number; oldStock: number; newStock: number; reason: string | null; operator: string | null; operatorRole?: string | null; createdAt: string }>> =>
    ipcRenderer.invoke('maintenance:getHopperEvents'),
  getTransactions: (limit?: number, offset?: number) =>
    ipcRenderer.invoke('admin:getTransactions', limit, offset),
  getSalesReport: (period: 'today' | 'week' | 'month' | 'all') =>
    ipcRenderer.invoke('admin:getSalesReport', period),
  getAlerts: () => ipcRenderer.invoke('admin:getAlerts'),
  resolveAlert: (transactionId: string) =>
    ipcRenderer.invoke('admin:resolveAlert', transactionId),

  // Admin PIN (panel unlock)
  getPinLength: (): Promise<number> => ipcRenderer.invoke('admin:getPinLength'),
  verifyPin: (pin: string): Promise<{ ok: boolean; locked?: boolean; retryInMs?: number; remaining?: number; operator?: { name: string; role: 'office' | 'operator' | 'viewer' } }> =>
    ipcRenderer.invoke('admin:verifyPin', pin),
  getOperator: (): Promise<{ name: string; role: 'office' | 'operator' | 'viewer' } | null> =>
    ipcRenderer.invoke('admin:getOperator'),
  signOutOperator: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('admin:signOut'),
  setPin: (current: string, next: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('admin:setPin', current, next),
  getSystemStatus: () => ipcRenderer.invoke('system:getStatus'),

  // Config (coin price)
  getConfig: (): Promise<{ coinPriceCents: number }> => ipcRenderer.invoke('config:get'),
  setPrice: (cents: number) => ipcRenderer.invoke('config:setPrice', cents),
  getTransactionTimeout: (): Promise<number> => ipcRenderer.invoke('config:getTransactionTimeout'),
  setTransactionTimeout: (seconds: number): Promise<{ ok: boolean; seconds: number }> =>
    ipcRenderer.invoke('config:setTransactionTimeout', seconds),
  // One lightweight call for everything the customer screens poll.
  getLiveConfig: (): Promise<{
    coinPriceCents: number
    transactionTimeoutSeconds: number
    coinsEnabled: { '1': boolean; '2': boolean }
    combo: { enabled: boolean; priceCents: number; allowOverride: boolean; fleetPriceCents: number; localPriceCents: number | null }
    operationalStatus: string
    promo: { text: string; enabled: boolean }
    qr: { enabled: boolean; url: string; caption: string }
    coinImagesSig: string
    marketingSig: string
  }> => ipcRenderer.invoke('config:getLive'),
  getCoinImages: (): Promise<{ 1: string | null; 2: string | null }> =>
    ipcRenderer.invoke('config:getCoinImages'),
  getCoinsEnabled: (): Promise<{ '1': boolean; '2': boolean }> =>
    ipcRenderer.invoke('config:getCoinsEnabled'),
  getOperationalStatus: (): Promise<string> =>
    ipcRenderer.invoke('config:getOperationalStatus'),

  // Combo Sale (both coins as one product)
  getCombo: (): Promise<{ enabled: boolean; priceCents: number; allowOverride: boolean; fleetPriceCents: number; localPriceCents: number | null }> =>
    ipcRenderer.invoke('config:getCombo'),
  setComboPrice: (cents: number): Promise<{ ok: boolean; error?: string; combo?: { enabled: boolean; priceCents: number; allowOverride: boolean; fleetPriceCents: number; localPriceCents: number | null } }> =>
    ipcRenderer.invoke('config:setComboPrice', cents),
  setComboEnabled: (on: boolean): Promise<{ ok: boolean; error?: string; combo?: { enabled: boolean; priceCents: number; allowOverride: boolean; fleetPriceCents: number; localPriceCents: number | null } }> =>
    ipcRenderer.invoke('config:setComboEnabled', on),
  getPromo: (): Promise<{ text: string; enabled: boolean }> =>
    ipcRenderer.invoke('config:getPromo'),
  getQR: (): Promise<{ enabled: boolean; url: string; caption: string }> =>
    ipcRenderer.invoke('config:getQR'),
  getMarketing: (): Promise<{
    enabled: boolean; slideSeconds: number; idleSeconds: number
    activeStart: string; activeEnd: string; images: string[]
  }> => ipcRenderer.invoke('config:getMarketing'),

  // Fleet sync settings
  getFleet: (): Promise<{
    kioskId: string; fleetUrl: string; fleetApiKey: string
    appliedConfigVersion: number; lastSyncedTxId: number; enabled: boolean
    status: { state: 'ok' | 'auth_failed' | 'error' | 'offline'; at: string; code?: number } | null
  }> => ipcRenderer.invoke('fleet:get'),
  setFleet: (s: { kioskId: string; fleetUrl: string; fleetApiKey: string }) =>
    ipcRenderer.invoke('fleet:set', s),

  // App / mode control (Admin > System panel)
  getMode: (): Promise<'kiosk' | 'dev'> => ipcRenderer.invoke('app:getMode'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  // 'lite' on the Raspberry Pi 5 (Linux arm64): the renderer drops the costly
  // visual effects there. 'full' everywhere else (mini-PCs look exactly as before).
  // Override for testing with KIOSK_PERF=lite|full.
  perfProfile: ((): 'lite' | 'full' => {
    const o = process.env.KIOSK_PERF
    if (o === 'lite' || o === 'full') return o
    return process.platform === 'linux' && process.arch === 'arm64' ? 'lite' : 'full'
  })(),
  getGraphicsStatus: (): Promise<{ accelerated: boolean; detail: string }> =>
    ipcRenderer.invoke('app:getGraphicsStatus'),
  getPortInfo: (): Promise<{ hopper: string; nayax: string; note: string; verified: boolean; hopperPort?: string; nayaxPort?: string; hopperError?: string; nayaxError?: string }> =>
    ipcRenderer.invoke('app:getPortInfo'),
  setMode: (mode: 'kiosk' | 'dev') => ipcRenderer.invoke('app:setMode', mode),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  minimizeApp: () => ipcRenderer.invoke('app:minimize'),

  // Event listeners
  onHopperStatus: (callback: (data: unknown) => void) => {
    ipcRenderer.on('hopper:status', (_event, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('hopper:status')
  }
}

contextBridge.exposeInMainWorld('kiosk', kioskAPI)

// Shared API type — consumed by the renderer via src/preload/index.d.ts
export type KioskAPI = typeof kioskAPI

// Type declarations for renderer
declare global {
  interface Window {
    kiosk: KioskAPI
  }
}
