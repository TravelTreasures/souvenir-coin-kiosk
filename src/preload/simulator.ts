/**
 * Preload script for the simulator window.
 * Exposes simulator controls to the simulator UI.
 */

import { contextBridge, ipcRenderer } from 'electron'

const simAPI = {
  // Payment simulation
  setPaymentResult: (result: 'approved' | 'declined' | 'communication_error') =>
    ipcRenderer.send('sim:setPaymentResult', result),
  triggerPayment: () => ipcRenderer.send('sim:triggerPayment'),

  // Hopper simulation
  setHopperStatus: (address: number, status: 'ok' | 'empty' | 'jam' | 'offline') =>
    ipcRenderer.send('sim:setHopperStatus', address, status),
  setHopperCoinCount: (address: number, count: number) =>
    ipcRenderer.send('sim:setHopperCoinCount', address, count),

  // Live hopper updates pushed from the main process (e.g. after a dispense)
  onHopperUpdate: (
    callback: (data: { address: number; status: string; coinCount: number }) => void
  ) => {
    ipcRenderer.on('hopper:status', (_event, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('hopper:status')
  },

  // Hopper ccTalk bus addresses (DIP switches: H1 = 3, H2 = 4)
  HOPPER_1_ADDR: 3,
  HOPPER_2_ADDR: 4
}

contextBridge.exposeInMainWorld('sim', simAPI)

declare global {
  interface Window {
    sim: typeof simAPI
  }
}
