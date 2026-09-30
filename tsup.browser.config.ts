import { defineConfig } from 'tsup'

// Standalone, dependency-free ESM builds for pages that have no build step: copy the file
// next to the page, or serve it from a static host, and import it. Each is built from the
// same source as its `@overlay-social/sdk/<module>` subpath. Runs after the main build,
// which cleans dist/.
const common = {
  format: ['esm'] as ['esm'],
  platform: 'browser' as const,
  target: 'es2022',
  splitting: false,
  dts: false,
  clean: false,
}

export default defineConfig([
  {
    ...common,
    entry: { 'peckos.browser': 'src/peckos/index.ts' },
    banner: {
      js: '// Generated from @overlay-social/sdk (src/peckos). Do not edit; import it or copy it as is.',
    },
  },
  {
    ...common,
    entry: { 'sanitize.browser': 'src/sanitize/web.ts' },
    // The libraries are bundled in, so the file has no imports. esbuild keeps
    // DOMPurify's licence comment at the end of the file; marked's is in the banner.
    noExternal: [/.*/],
    minify: true,
    banner: {
      js: [
        '// Generated from @overlay-social/sdk (src/sanitize). Do not edit; import it or copy it as is.',
        '// Bundles DOMPurify (Cure53, Apache-2.0 OR MPL-2.0) and marked (MarkedJS and Christopher Jeffrey, MIT).',
      ].join('\n'),
    },
  },
])
