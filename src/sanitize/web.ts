// The browser entry: the page's own `window` is the DOM. Selected by the
// `browser` export condition, and the source of the single-file build
// (`@overlay-social/sdk/sanitize/browser`).
import { defineApi } from './api.js'

const api = defineApi(() => (typeof window === 'undefined' ? undefined : window))

export const renderMarkdown = api.renderMarkdown
export const sanitizeHtml = api.sanitizeHtml
export const sanitizeEmbedHtml = api.sanitizeEmbedHtml
export const isSanitizerAvailable = api.isSanitizerAvailable

export { createSanitizer, type DomWindow, type RenderOptions, type Sanitizer } from './core.js'
export { LINK_REL, URI_OK, escapeHtml, type SanitizeOptions } from './profile.js'
