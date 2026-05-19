import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: [
    'electron',
    'node:sqlite',
    'playwright',
    'playwright-core',
    'chromium-bidi/*'
  ]
}

await build({
  ...common,
  entryPoints: [path.join(root, 'apps/desktop/src/main/index.ts')],
  outfile: path.join(root, 'apps/desktop/dist/main/index.js')
})

await build({
  ...common,
  entryPoints: [path.join(root, 'apps/desktop/src/preload/index.ts')],
  outfile: path.join(root, 'apps/desktop/dist/preload/index.js')
})
