/**
 * Shared coin-image store.
 *
 * The fleet-pushed coin pictures are large. Every coin on screen used to fetch
 * BOTH pictures from the main process every 5 seconds — up to four separate
 * fetches of the same megabytes on the selection screen. Now they are fetched
 * once, kept here, and every coin component reads the same copy. App.tsx calls
 * reloadCoinImages() only when the fleet says a picture actually changed.
 */
import { useSyncExternalStore } from 'react'

type Images = { 1: string | null; 2: string | null }

let images: Images = { 1: null, 2: null }
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export async function reloadCoinImages(): Promise<void> {
  try {
    const next = await window.kiosk?.getCoinImages?.()
    if (!next) return
    const n: Images = { 1: next[1] ?? null, 2: next[2] ?? null }
    if (n[1] !== images[1] || n[2] !== images[2]) {
      images = n
      listeners.forEach((f) => f())
    }
  } catch {
    /* keep showing whatever we have */
  }
}

/** The fleet-pushed picture for a coin, or null to use the bundled default. */
export function useCoinImage(coin: 1 | 2): string | null {
  return useSyncExternalStore(subscribe, () => images[coin])
}
