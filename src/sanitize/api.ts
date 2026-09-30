/**
 * The module-level functions (`renderMarkdown`, `sanitizeHtml`, ...): one
 * shared sanitiser, created on first use from a window the entry point
 * supplies. The browser entry supplies the page's window; the Node entry a
 * jsdom window.
 */
import { createSanitizer, type DomWindow, type RenderOptions, type Sanitizer } from './core.js'
import { escapeHtml, type SanitizeOptions } from './profile.js'

export interface SanitizeApi {
  renderMarkdown(text: string, options?: RenderOptions): string
  sanitizeHtml(html: string, options?: SanitizeOptions): string
  sanitizeEmbedHtml(html: string, options?: SanitizeOptions): string
  /** True when a DOM is available; when false the functions above return escaped text. */
  isSanitizerAvailable(): boolean
}

export function defineApi(getWindow: () => DomWindow | undefined): SanitizeApi {
  let shared: Sanitizer | undefined
  const sanitizer = (): Sanitizer => {
    if (!shared) {
      let win: DomWindow | undefined
      try {
        win = getWindow()
      } catch {
        win = undefined
      }
      // Without a DOM, fail closed: escaped text, never raw markup. A window
      // is looked up again on the next call, so a late-created one is used.
      const s = win ? createSanitizer(win) : undefined
      if (s?.available) shared = s
      else return failClosed
    }
    return shared
  }
  return {
    renderMarkdown: (text, options) => sanitizer().renderMarkdown(text, options),
    sanitizeHtml: (html, options) => sanitizer().sanitizeHtml(html, options),
    sanitizeEmbedHtml: (html, options) => sanitizer().sanitizeEmbedHtml(html, options),
    isSanitizerAvailable: () => sanitizer().available,
  }
}

const failClosed: Sanitizer = {
  available: false,
  sanitizeHtml: (html) => escapeHtml(html),
  sanitizeEmbedHtml: (html) => escapeHtml(html),
  renderMarkdown: (text) => escapeHtml(text).replace(/\r?\n/g, '<br>'),
}
