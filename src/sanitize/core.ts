/**
 * The sanitiser, independent of where its DOM comes from. `createSanitizer()`
 * takes a window (the page's own, or one made by jsdom, linkedom, happy-dom on
 * a server); the package entry points call it with the right default.
 */
import createDOMPurify, { type Config } from 'dompurify'
import { Marked } from 'marked'
import {
  DROP_MARK,
  embedConfig,
  escapeHtml,
  hardenNode,
  postConfig,
  type SanitizeOptions,
} from './profile.js'

/** What `createDOMPurify()` accepts as a window. */
export type DomWindow = Parameters<typeof createDOMPurify>[0]

export interface RenderOptions extends SanitizeOptions {
  /**
   * Turn `@handle` in the text into a link. Return the URL for a handle (for
   * example `/u/${handle}`), or a falsy value to leave that mention as text.
   * Handles are 3 to 30 letters, digits or underscores, after whitespace, an
   * opening parenthesis or the start of the text, and never inside code.
   */
  mentions?: (handle: string) => string | null | undefined
}

export interface Sanitizer {
  /**
   * False when the window cannot run DOMPurify (no DOM). Every method then
   * fails closed: it returns the input escaped as text, never raw markup.
   */
  readonly available: boolean
  /** Clean untrusted HTML (for example the output of a markdown parser). */
  sanitizeHtml(html: string, options?: SanitizeOptions): string
  /**
   * The second pass, for output of `sanitizeHtml()` that an app has since
   * added its own embed cards to: allows the cards' `data-*` attributes and
   * `peck-embed*` classes, and a YouTube no-cookie player iframe, nothing else.
   */
  sanitizeEmbedHtml(html: string, options?: SanitizeOptions): string
  /** Markdown (GFM, single newlines are line breaks) to safe HTML. */
  renderMarkdown(text: string, options?: RenderOptions): string
}

const HANDLE = /(^|[\s(])@([a-z0-9_]{3,30})\b/gi
// Fenced blocks and inline code, kept out of the mention pass.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/

function linkMentions(text: string, href: NonNullable<RenderOptions['mentions']>): string {
  return text
    .split(CODE)
    .map((part, i) => {
      if (i % 2 === 1) return part // a code segment
      return part.replace(HANDLE, (whole, lead: string, handle: string) => {
        const url = href(handle)
        return url ? `${lead}[@${handle}](<${String(url).replace(/[<>\n]/g, encodeURIComponent)}>)` : whole
      })
    })
    .join('')
}

const markdown = new Marked({ gfm: true, breaks: true, async: false })

/** Create a sanitiser that runs on the given window's DOM. */
export function createSanitizer(window: DomWindow): Sanitizer {
  const post = createDOMPurify(window)
  const embed = createDOMPurify(window)
  const available = post.isSupported === true && embed.isSupported === true
  // The hooks read the options of the call in progress; calls are synchronous.
  let current: SanitizeOptions = {}

  if (available) {
    post.addHook('afterSanitizeAttributes', (node) => hardenNode(node, false, current))
    embed.addHook('afterSanitizeAttributes', (node) => hardenNode(node, true, current))
  }

  const text = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))

  /**
   * DOMPurify, then the removal of the elements the hooks marked. The result
   * of a removal is cleaned once more, so what is returned is always
   * DOMPurify's own serialisation.
   */
  function purify(p: typeof post, cfg: () => Config, html: string, options: SanitizeOptions): string {
    current = options
    const clean = p.sanitize(text(html), cfg())
    if (!clean.includes(DROP_MARK)) return clean
    // A <template> keeps the reparse inert (nothing loads, nothing runs).
    const template = (window as unknown as Window).document.createElement('template')
    template.innerHTML = clean
    template.content.querySelectorAll(`[${DROP_MARK}]`).forEach((n) => n.remove())
    return p.sanitize(template.innerHTML, cfg())
  }

  function sanitizeHtml(html: string, options: SanitizeOptions = {}): string {
    return available ? purify(post, postConfig, html, options) : escapeHtml(html)
  }

  function sanitizeEmbedHtml(html: string, options: SanitizeOptions = {}): string {
    return available ? purify(embed, embedConfig, html, options) : escapeHtml(html)
  }

  function renderMarkdown(source: string, options: RenderOptions = {}): string {
    const raw = text(source)
    if (!available) return escapeHtml(raw).replace(/\r?\n/g, '<br>')
    const linked = options.mentions ? linkMentions(raw, options.mentions) : raw
    return sanitizeHtml(markdown.parse(linked) as string, options)
  }

  return { available, sanitizeHtml, sanitizeEmbedHtml, renderMarkdown }
}
