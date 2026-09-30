import { defineConfig } from 'tsup'

// A standalone, dependency-free ESM build of the peckos module for pages that have no
// build step: copy `dist/peckos.browser.js` next to the page, or serve it from a static
// host, and `import { PeckOS } from './peckos.browser.js'`. It is built from the same
// source as `@overlay-social/sdk/peckos`. Runs after the main build, which cleans dist/.
export default defineConfig({
  entry: { 'peckos.browser': 'src/peckos/index.ts' },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  splitting: false,
  dts: false,
  clean: false,
  banner: {
    js: '// Generated from @overlay-social/sdk (src/peckos). Do not edit; import it or copy it as is.',
  },
})
