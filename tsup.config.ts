import { defineConfig } from 'tsup'

// One entry per public subpath. The keys become the file names in dist/, and
// must stay in sync with the `exports` map in package.json (checked by
// `npm run check:exports`).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    read: 'src/read/index.ts',
    identity: 'src/identity/index.ts',
    schema: 'src/schema/index.ts',
    wallet: 'src/wallet/index.ts',
    sanitize: 'src/sanitize/index.ts',
    'sanitize.web': 'src/sanitize/web.ts',
    peckos: 'src/peckos/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  sourcemap: true,
})
