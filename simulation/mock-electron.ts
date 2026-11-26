// Stand-in for Electron so the kiosk's main-process code can run under plain Node.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const dir = mkdtempSync(join(tmpdir(), 'kiosk-userdata-'))
export const handlers: Record<string, (...a: any[]) => any> = {}
export const app = { getPath: (_: string) => dir, getVersion: () => '1.21.38', isPackaged: true, exit: () => {}, relaunch: () => {}, on: () => {}, quit: () => {} }
export const ipcMain = { handle: (n: string, f: (...a: any[]) => any) => { handlers[n] = f }, on: () => {} }
export const BrowserWindow = { getAllWindows: () => [] as any[] }
export const net = { fetch: (u: string, o: any) => fetch(u, o) }
export const shell = {}, globalShortcut = {}, Menu = {}
