// @vitest-environment jsdom
// The browser entry: the page's own window is the DOM.
import { describe, expect, it } from 'vitest'
import { defineApi } from '../src/sanitize/api.js'
import { isSanitizerAvailable, renderMarkdown, sanitizeEmbedHtml, sanitizeHtml } from '../src/sanitize/web.js'
import { violations } from './helpers/dom-invariants.js'

describe('the browser entry', () => {
  it('uses the page window', () => {
    expect(typeof window).toBe('object')
    expect(isSanitizerAvailable()).toBe(true)
  })

  it('renders and cleans like the server entry', () => {
    expect(renderMarkdown('**hi** <img src=x onerror=alert(1)>')).toBe(
      '<p><strong>hi</strong> <img src="x" loading="lazy" referrerpolicy="no-referrer"></p>\n',
    )
    expect(violations(sanitizeHtml('<script>alert(1)</script><a href="javascript:alert(1)">x</a>'))).toEqual([])
    expect(sanitizeEmbedHtml('<iframe src="https://evil.example"></iframe>ok')).toBe('ok')
  })

  it('never runs anything while cleaning', () => {
    const w = window as unknown as { __xss?: number }
    w.__xss = 0
    document.body.innerHTML = renderMarkdown('<img src=x onerror="window.__xss=1"><svg onload="window.__xss=2">')
    expect(w.__xss).toBe(0)
  })
})

describe('an API with no window', () => {
  it('fails closed, and looks for a window again on the next call', () => {
    const page: { win?: unknown } = {}
    const api = defineApi(() => page.win as never)
    expect(api.isSanitizerAvailable()).toBe(false)
    expect(api.sanitizeHtml('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;')
    expect(api.renderMarkdown('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;')
    page.win = window
    expect(api.isSanitizerAvailable()).toBe(true)
    expect(api.sanitizeHtml('<b>x</b>')).toBe('<b>x</b>')
  })

  it('treats a window lookup that throws as no window', () => {
    const api = defineApi(() => {
      throw new Error('no window')
    })
    expect(api.sanitizeHtml('<i>x</i>')).toBe('&lt;i&gt;x&lt;/i&gt;')
  })
})
