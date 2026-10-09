// The parts of the sanitising profile that need no DOM and no library: the HTML escaper and the
// two constants a renderer shares with it. Nothing here imports DOMPurify or marked, so a page
// that only escapes text (an `innerHTML` template, an attribute value) can take this file alone:
//
//   import { escapeHtml } from '@overlay-social/sdk/sanitize/escape'
//
// A size test (test/sanitize-escape.test.ts) keeps it that way.

/** The `rel` every link gets. */
export const LINK_REL = 'noopener noreferrer nofollow ugc'

/**
 * `http`, `https` and `mailto`, plus relative URLs (`/u/name`, `#top`,
 * `page.html`). DOMPurify's default minus `ftp`, `tel`, `sms`, `cid`, `xmpp`
 * and the rest, so `javascript:`, `vbscript:` and every other scheme fail.
 */
export const URI_OK = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }

/** Escape text for an HTML text or attribute context. */
export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"'`]/g, (c) => ESCAPES[c] as string)
}
