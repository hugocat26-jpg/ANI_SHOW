import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopDist = path.join(root, 'apps/desktop/dist')

const commonExternal = [
  'electron',
  'node:sqlite',
  'playwright',
  'playwright-core',
  'chromium-bidi/*'
]

const mainBuild = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: commonExternal
}

await rm(path.join(desktopDist, 'main'), { recursive: true, force: true })
await rm(path.join(desktopDist, 'preload'), { recursive: true, force: true })

await build({
  ...mainBuild,
  entryPoints: [path.join(root, 'apps/desktop/src/main/index.ts')],
  outfile: path.join(desktopDist, 'main/index.js')
})

await build({
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  external: commonExternal,
  entryPoints: [path.join(root, 'apps/desktop/src/preload/index.ts')],
  outfile: path.join(desktopDist, 'preload/index.cjs')
})
