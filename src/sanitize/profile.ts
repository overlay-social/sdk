/**
 * The sanitising profile: which markup survives when chain content becomes
 * HTML. Chain content is written by anyone and can never be deleted, so it is
 * cleaned at render time, on every read.
 *
 * The rules are DOMPurify's HTML profile plus the following.
 *
 * Elements: no scripts, no SVG or MathML, no form controls (the disabled
 * checkboxes of a task list are the one exception), no frames or embeds
 * (`iframe`, `object`, `embed`), no `style`, `link`, `meta`, `base`,
 * `template`, `noscript`, `dialog` or `marquee`. Text, headings, lists,
 * quotes, code, tables, links, images, audio and video survive.
 *
 * Attributes: no event handlers, no inline `style`, no `data-*` and no
 * `srcdoc`, `action` or `formaction`. `id` and `name` are prefixed with
 * `user-content-` (no DOM clobbering). Only `language-*` class tokens (code
 * fences) survive, so content cannot borrow an app's own CSS classes.
 *
 * URLs: `http`, `https` and `mailto`, and relative URLs. Nothing else:
 * `javascript:`, `vbscript:`, `tel:`, `ftp:` and the rest are dropped. Like
 * DOMPurify itself, `data:` URLs are kept on media elements only (`img`,
 * `video`, `audio`, `source`, `track`), where they are inert, and never on
 * links.
 *
 * Links: every link with an `href` gets `rel="noopener noreferrer nofollow
 * ugc"`. `target` is never taken from the content: an absolute `http(s)` link
 * gets `target="_blank"` (or none, see `externalLinkTarget`), everything else
 * has none.
 *
 * Media: images, audio and video may load from any `http(s)` host, as they do
 * on peck.to. Images and media are given `loading="lazy"` and
 * `referrerpolicy="no-referrer"`, so the reader's page address is not sent to
 * the host, and `autoplay` is removed: content never starts media by itself.
 */
import type { Config } from 'dompurify'

/** Options every sanitising call takes. */
export interface SanitizeOptions {
  /**
   * `target` for absolute `http(s)` links: `'_blank'` (default) opens them in
   * a new tab, `null` leaves them without a `target`. Content can never
   * choose its own.
   */
  externalLinkTarget?: '_blank' | null
}

/** The `rel` every link gets. */
export const LINK_REL = 'noopener noreferrer nofollow ugc'

/**
 * `http`, `https` and `mailto`, plus relative URLs (`/u/name`, `#top`,
 * `page.html`). DOMPurify's default minus `ftp`, `tel`, `sms`, `cid`, `xmpp`
 * and the rest, so `javascript:`, `vbscript:` and every other scheme fail.
 */
export const URI_OK = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i

/** The one iframe an embed card may contain. */
export const YOUTUBE_EMBED_URL = /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/
const YOUTUBE_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'

const FORBID_TAGS = [
  'style', 'form', 'button', 'textarea', 'select', 'option', 'optgroup',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link', 'meta',
  'template', 'noscript', 'dialog', 'portal', 'fencedframe', 'marquee',
]
const FORBID_ATTR = [
  'style', 'srcdoc', 'formaction', 'form', 'action', 'autofocus', 'ping',
  'popover', 'popovertarget', 'popovertargetaction', 'slot', 'is',
]
/** Attributes an app's own embed cards carry (see {@link embedConfig}). */
export const EMBED_DATA_ATTR = ['data-txid', 'data-oembed-url', 'data-og-url', 'data-ord-txid', 'data-ord-origin']

/** Class tokens content may keep: code fence languages. */
const CLASS_POST = /^language-[\w+#.-]+$/
/** The embed pass also keeps the app's own card classes. */
const CLASS_EMBED = /^(?:language-[\w+#.-]+|peck-embed[\w-]*)$/

/** DOMPurify configuration for untrusted markup. */
export function postConfig(): Config {
  return {
    USE_PROFILES: { html: true }, // no SVG or MathML namespaces at all
    ALLOWED_URI_REGEXP: URI_OK,
    FORBID_TAGS: FORBID_TAGS.slice(),
    FORBID_ATTR: FORBID_ATTR.slice(),
    ALLOW_DATA_ATTR: false, // data-hx-* would arm htmx on a later htmx.process()
    SANITIZE_NAMED_PROPS: true, // id/name become user-content-*
  }
}

/**
 * The second pass, run over `sanitizeHtml()` output after an app has added its
 * own embed cards: the same rules plus the card `data-*` attributes and the
 * privacy-friendly YouTube player, nothing else.
 */
export function embedConfig(): Config {
  const cfg = postConfig()
  cfg.FORBID_TAGS = FORBID_TAGS.filter((t) => t !== 'iframe')
  cfg.ADD_TAGS = ['iframe']
  cfg.ADD_ATTR = ['allow', 'allowfullscreen', 'frameborder', 'loading', 'referrerpolicy', ...EMBED_DATA_ATTR]
  return cfg
}

/** An absolute (or protocol-relative) `http(s)` link leaves the page. */
const EXTERNAL = /^(?:https?:)?\/\//i

/**
 * Marks an element for removal once DOMPurify is done: removing a node from
 * inside a DOMPurify hook is not safe, so it is marked there and deleted
 * after. Content cannot forge it (`data-*` is stripped) and would only lose
 * its own element if it did.
 */
export const DROP_MARK = 'data-drop'

/**
 * Attribute rules DOMPurify's own config cannot express. Runs on every
 * element after DOMPurify has cleaned its attributes.
 */
export function hardenNode(node: Element, embed: boolean, options: SanitizeOptions): void {
  const keep = embed ? CLASS_EMBED : CLASS_POST
  const cls = node.getAttribute('class')
  if (cls !== null) {
    const kept = cls.split(/\s+/).filter((c) => c && keep.test(c))
    if (kept.length > 0) node.setAttribute('class', kept.join(' '))
    else node.removeAttribute('class')
  }

  const tag = node.nodeName.toUpperCase()

  // `target` is ours to set, never the content's.
  node.removeAttribute('target')
  if ((tag === 'A' || tag === 'AREA') && node.hasAttribute('href')) {
    node.setAttribute('rel', LINK_REL)
    if (options.externalLinkTarget !== null && EXTERNAL.test((node.getAttribute('href') ?? '').trim())) {
      node.setAttribute('target', '_blank')
    }
  } else {
    node.removeAttribute('rel')
  }

  if (tag === 'INPUT') {
    // GFM task lists render <input type="checkbox" disabled>. That is the only
    // input that survives, and nothing in a post is ever an active control.
    if ((node.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') node.setAttribute(DROP_MARK, '1')
    node.setAttribute('disabled', '')
    node.removeAttribute('name')
  }

  // An `is` attribute is left as DOMPurify blanked it (`is=""`), not removed:
  // an element created with `is` remembers its value, and HTML serialisation
  // writes that value back unless the attribute is present and empty.

  if (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO') {
    node.setAttribute('loading', 'lazy')
    node.setAttribute('referrerpolicy', 'no-referrer')
    node.removeAttribute('autoplay')
  }

  if (embed && tag === 'IFRAME') {
    // Only the YouTube no-cookie player, with fixed permissions.
    if (!YOUTUBE_EMBED_URL.test(node.getAttribute('src') ?? '')) node.setAttribute(DROP_MARK, '1')
    node.setAttribute('allow', YOUTUBE_ALLOW)
    node.setAttribute('loading', 'lazy')
    node.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }

/** Escape text for an HTML text or attribute context. */
export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"'`]/g, (c) => ESCAPES[c] as string)
}
