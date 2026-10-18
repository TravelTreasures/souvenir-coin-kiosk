// Copies the self-contained Hardware Simulator HTML into the build output
// (out/renderer/simulator/) so electron-builder packs it inside app.asar.
// The simulator has no JS module to bundle, so Vite doesn't emit it; this
// step makes the packaged app able to load it via loadFile().
import { mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/renderer/simulator/index.html')
const destDir = join(root, 'out/renderer/simulator')

mkdirSync(destDir, { recursive: true })
copyFileSync(src, join(destDir, 'index.html'))
console.log('[copy-simulator] simulator HTML copied into out/renderer/simulator/')
