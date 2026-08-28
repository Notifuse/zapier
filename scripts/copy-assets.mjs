// tsc emits JavaScript, not data. The generated webhook samples are a .json file
// that src/samples/index.ts imports at runtime, so the build has to place a copy
// next to the compiled module or the published integration loads nothing and
// every trigger sample comes out empty.
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const assets = [join('src', 'samples', 'payloads.json')]

for (const asset of assets) {
  const destination = join(root, 'dist', asset.replace(/^src[\\/]/, ''))
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(root, asset), destination)
}
