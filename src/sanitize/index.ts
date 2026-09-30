// The `sanitize` module: one profile for showing chain content as HTML.
//
//   import { renderMarkdown } from '@overlay-social/sdk/sanitize'
//   el.innerHTML = renderMarkdown(post.text)
//
// This is the Node (server-side rendering) entry. A server has no DOM, and
// DOMPurify needs one, so `jsdom` (an optional peer dependency) supplies it,
// loaded on first use. Bring your own window (linkedom, happy-dom, an existing
// jsdom) with `createSanitizer(window)`. Browsers and bundlers get `./web.ts`
// through the `browser` export condition and use the page's own DOM.
import { createRequire } from 'node:module'
import { defineApi } from './api.js'
import type { DomWindow } from './core.js'

let serverWindow: DomWindow | undefined
let warned = false

function jsdomWindow(): DomWindow | undefined {
  if (!serverWindow) {
    try {
      const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: DomWindow } }
      serverWindow = new JSDOM('').window
    } catch {
      // jsdom is not installed: the functions fail closed (escaped text).
      if (!warned) {
        warned = true
        console.warn(
          '@overlay-social/sdk/sanitize: no DOM available, so content is returned as escaped text. ' +
            'Install jsdom (optional peer dependency) or create a sanitiser with createSanitizer(window).',
        )
      }
      return undefined
    }
  }
  return serverWindow
}

const api = defineApi(() => (typeof window !== 'undefined' ? window : jsdomWindow()))

export const renderMarkdown = api.renderMarkdown
export const sanitizeHtml = api.sanitizeHtml
export const sanitizeEmbedHtml = api.sanitizeEmbedHtml
export const isSanitizerAvailable = api.isSanitizerAvailable

export { createSanitizer, type DomWindow, type RenderOptions, type Sanitizer } from './core.js'
export { LINK_REL, URI_OK, escapeHtml, type SanitizeOptions } from './profile.js'
