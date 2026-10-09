// The escape-only entry has to stay tiny: it exists so a page that only escapes text does not ship
// DOMPurify and marked (sanitize/browser is about 73 KB). The test bundles it the way
// tsup.browser.config.ts does and checks the size and the contents of the result.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINK_REL, URI_OK, escapeHtml } from '../src/sanitize/escape.js'
import * as profile from '../src/sanitize/profile.js'
import * as sanitize from '../src/sanitize/web.js'

const entry = resolve(import.meta.dirname, '../src/sanitize/escape.ts')

describe('sanitize/escape', () => {
  it('bundles to a few hundred bytes, without DOMPurify or marked', async () => {
    const out = await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    })
    expect(out.outputFiles).toHaveLength(1)
    const code = out.outputFiles[0]!.text
    expect(code.length).toBeLessThan(1024)
    expect(code).not.toMatch(/purify|marked|\bimport\b/i)
    // The bundle must still contain the real thing.
    expect(code).toContain('&amp;')
  })

  it('imports nothing at runtime', () => {
    expect(readFileSync(entry, 'utf8')).not.toMatch(/^\s*import\s/m)
  })

  it('escapes the five HTML characters and the backtick, and tolerates non-strings', () => {
    expect(escapeHtml(`<a href="x" title='y'>&\``)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(12)).toBe('12')
  })

  it('is the very function the sanitise entries export', () => {
    expect(sanitize.escapeHtml).toBe(escapeHtml)
    expect(profile.escapeHtml).toBe(escapeHtml)
    expect(sanitize.LINK_REL).toBe(LINK_REL)
    expect(sanitize.URI_OK).toBe(URI_OK)
    expect(LINK_REL).toBe('noopener noreferrer nofollow ugc')
  })
})
