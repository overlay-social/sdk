import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  LINK_REL,
  URI_OK,
  createSanitizer,
  escapeHtml,
  isSanitizerAvailable,
  renderMarkdown,
  sanitizeEmbedHtml,
  sanitizeHtml,
} from '../src/sanitize/index.js'
import { parseInert, violations } from './helpers/dom-invariants.js'

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/sanitize/xss-corpus.json'), 'utf8'),
) as { payloads: Array<{ name: string; payload: string }> }

describe('the server entry', () => {
  it('finds a DOM (jsdom) without being given one', () => {
    expect(isSanitizerAvailable()).toBe(true)
  })
})

describe('XSS corpus', () => {
  expect(corpus.payloads.length).toBeGreaterThan(100)

  for (const { name, payload } of corpus.payloads) {
    it(`${name}: as HTML`, () => {
      const out = sanitizeHtml(payload)
      expect(violations(out), out).toEqual([])
    })

    it(`${name}: as markdown`, () => {
      const out = renderMarkdown(payload)
      expect(violations(out), out).toEqual([])
    })

    it(`${name}: cleaning twice changes nothing`, () => {
      const once = sanitizeHtml(payload)
      expect(sanitizeHtml(once)).toBe(once)
    })
  }

  it('leaves no dangerous element in any output', () => {
    for (const { payload } of corpus.payloads) {
      for (const out of [sanitizeHtml(payload), renderMarkdown(payload)]) {
        expect(out).not.toMatch(/<script|<svg|<math|<iframe|<style|<object|<embed|<form|<link|<meta/i)
      }
    }
  })
})

describe('links', () => {
  it('gives every link the same rel and opens absolute links in a new tab', () => {
    const out = renderMarkdown('[a](https://example.com/x) [b](/u/name) [c](#top) [d](mailto:hi@example.com) [e](//cdn.example/x)')
    const links = Array.from(parseInert(out).querySelectorAll('a'))
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/x', '/u/name', '#top', 'mailto:hi@example.com', '//cdn.example/x',
    ])
    for (const a of links) expect(a.getAttribute('rel')).toBe(LINK_REL)
    expect(links.map((a) => a.getAttribute('target'))).toEqual(['_blank', null, null, null, '_blank'])
  })

  it('never takes target or rel from the content', () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_top" rel="opener">x</a><a href="/x" target="_blank">y</a>')
    const [a, b] = Array.from(parseInert(out).querySelectorAll('a'))
    expect(a!.getAttribute('target')).toBe('_blank')
    expect(a!.getAttribute('rel')).toBe(LINK_REL)
    expect(b!.getAttribute('target')).toBeNull()
  })

  it('can leave external links without a target', () => {
    const out = renderMarkdown('[a](https://example.com)', { externalLinkTarget: null })
    expect(parseInert(out).querySelector('a')!.hasAttribute('target')).toBe(false)
    expect(parseInert(out).querySelector('a')!.getAttribute('rel')).toBe(LINK_REL)
  })

  it('keeps http, https and mailto, and drops every other scheme', () => {
    for (const ok of ['http://a.example', 'https://a.example', 'mailto:a@example.com', '/x', '#y', 'page.html', '?q=1']) {
      expect(URI_OK.test(ok), ok).toBe(true)
    }
    for (const bad of ['javascript:x', 'JaVaScRiPt:x', 'vbscript:x', 'data:text/html,x', 'tel:1', 'ftp://a', 'blob:x', 'file:///x', 'sms:1', 'cid:x']) {
      expect(URI_OK.test(bad), bad).toBe(false)
    }
    const out = sanitizeHtml('<a href="tel:1">t</a><a href="ftp://a">f</a><a href="javascript:x">j</a><a href="https://ok.example">o</a>')
    expect(Array.from(parseInert(out).querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([null, null, null, 'https://ok.example'])
  })
})

describe('media policy', () => {
  it('keeps http(s) images, lazy and without a referrer', () => {
    const img = parseInert(renderMarkdown('![alt text](https://example.com/a.png)')).querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://example.com/a.png')
    expect(img.getAttribute('alt')).toBe('alt text')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('drops javascript: images, and keeps data: only on media elements', () => {
    expect(parseInert(sanitizeHtml('<img src="javascript:alert(1)">')).querySelector('img')!.hasAttribute('src')).toBe(false)
    const png = 'data:image/png;base64,iVBORw0KGgo='
    expect(parseInert(sanitizeHtml(`<img src="${png}">`)).querySelector('img')!.getAttribute('src')).toBe(png)
    expect(parseInert(sanitizeHtml(`<a href="${png}">x</a>`)).querySelector('a')!.hasAttribute('href')).toBe(false)
  })

  it('removes autoplay, and audio and video stay controllable', () => {
    const v = parseInert(sanitizeHtml('<video src="https://example.com/v.mp4" controls autoplay muted></video>')).querySelector('video')!
    expect(v.hasAttribute('autoplay')).toBe(false)
    expect(v.hasAttribute('controls')).toBe(true)
    expect(v.getAttribute('src')).toBe('https://example.com/v.mp4')
    expect(v.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('removes frames and embeds entirely', () => {
    const out = sanitizeHtml('a<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe><object data="https://x.example"></object><embed src="https://x.example">b')
    expect(out).toBe('ab')
  })
})

describe('markdown that posts use', () => {
  it('renders emphasis, code and line breaks', () => {
    expect(renderMarkdown('Hello **bold** and _em_ and `code`')).toBe('<p>Hello <strong>bold</strong> and <em>em</em> and <code>code</code></p>\n')
    expect(renderMarkdown('one\ntwo')).toBe('<p>one<br>two</p>\n')
    expect(renderMarkdown('~~gone~~')).toBe('<p><del>gone</del></p>\n')
  })

  it('renders headings, quotes and rules', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>\n')
    expect(renderMarkdown('> quoted words')).toBe('<blockquote>\n<p>quoted words</p>\n</blockquote>\n')
    expect(renderMarkdown('---')).toBe('<hr>\n')
  })

  it('renders lists', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n')
    expect(renderMarkdown('1. first\n2. second')).toBe('<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n')
  })

  it('keeps the language class of a code fence, and escapes what is inside', () => {
    const out = renderMarkdown('```js\nconst a = 1 < 2;\n```')
    expect(out).toBe('<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>\n')
  })

  it('renders links and bare URLs', () => {
    const out = renderMarkdown('[peck](https://peck.to/about) and see https://example.com/page?a=1&b=2 for more')
    const links = Array.from(parseInert(out).querySelectorAll('a'))
    expect(links.map((a) => a.textContent)).toEqual(['peck', 'https://example.com/page?a=1&b=2'])
    expect(links[1]!.getAttribute('href')).toBe('https://example.com/page?a=1&b=2')
  })

  it('renders tables', () => {
    const out = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    const cells = Array.from(parseInert(out).querySelectorAll('th,td')).map((c) => c.textContent)
    expect(cells).toEqual(['a', 'b', '1', '2'])
  })

  it('renders task lists as disabled checkboxes', () => {
    const boxes = Array.from(parseInert(renderMarkdown('- [x] done\n- [ ] todo')).querySelectorAll('input'))
    expect(boxes.map((b) => [b.getAttribute('type'), b.hasAttribute('disabled'), b.hasAttribute('checked')])).toEqual([
      ['checkbox', true, true],
      ['checkbox', true, false],
    ])
  })

  it('handles emoji and non-Latin text', () => {
    expect(renderMarkdown('GM from peck ❤️ æøå 日本語')).toBe('<p>GM from peck ❤️ æøå 日本語</p>\n')
  })

  it('treats an empty or missing text as empty', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(undefined as unknown as string)).toBe('')
    expect(sanitizeHtml(null as unknown as string)).toBe('')
  })
})

describe('mentions', () => {
  const mentions = (h: string) => (h === 'nobody' ? null : `/u/${h}`)

  it('links @handles through the callback', () => {
    const out = renderMarkdown('gm @thomas, and (@kryp_2) but not @ab or @nobody', { mentions })
    const links = Array.from(parseInert(out).querySelectorAll('a'))
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['@thomas', '/u/thomas'],
      ['@kryp_2', '/u/kryp_2'],
    ])
    expect(out).toContain('@nobody')
  })

  it('leaves code alone', () => {
    const out = renderMarkdown('`@thomas`\n\n```\n@thomas\n```\n\n@thomas', { mentions })
    expect(parseInert(out).querySelectorAll('a')).toHaveLength(1)
    expect(parseInert(out).querySelector('code')!.textContent).toBe('@thomas')
  })

  it('is off unless asked for, and the result is sanitised whatever the callback returns', () => {
    expect(parseInert(renderMarkdown('gm @thomas')).querySelector('a')).toBeNull()
    const out = renderMarkdown('gm @thomas', { mentions: () => 'javascript:alert(1)' })
    expect(violations(out)).toEqual([])
    expect(parseInert(out).querySelector('a')?.hasAttribute('href') ?? false).toBe(false)
  })
})

describe('the embed pass', () => {
  const YT = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'

  it('keeps an app embed card and the YouTube player, with fixed permissions', () => {
    const out = sanitizeEmbedHtml(
      `<div class="peck-embed peck-embed-post" data-txid="${'a'.repeat(64)}"><iframe src="${YT}" onload="alert(1)" allow="camera"></iframe></div>`,
    )
    const dom = parseInert(out)
    expect(dom.querySelector('div')!.getAttribute('class')).toBe('peck-embed peck-embed-post')
    expect(dom.querySelector('div')!.getAttribute('data-txid')).toBe('a'.repeat(64))
    const frame = dom.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(YT)
    expect(frame.hasAttribute('onload')).toBe(false)
    expect(frame.getAttribute('allow')).toContain('encrypted-media')
    expect(frame.getAttribute('allow')).not.toContain('camera')
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
    expect(frame.hasAttribute('data-drop')).toBe(false)
  })

  it('drops every other iframe, and still applies the post rules', () => {
    const out = sanitizeEmbedHtml(
      '<iframe src="https://evil.example/x"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe>' +
        '<iframe src="javascript:alert(1)"></iframe><iframe src="https://www.youtube-nocookie.com/embed/short"></iframe>' +
        '<img src=x onerror=alert(1)><a href="javascript:alert(1)" data-other="1">x</a>',
    )
    expect(out).not.toMatch(/iframe|onerror|javascript|data-other|data-drop/)
  })

  it('does not let a post borrow the card attributes', () => {
    const out = sanitizeHtml('<div class="peck-embed" data-txid="x">y</div>')
    expect(out).toBe('<div>y</div>')
  })
})

describe('id and class', () => {
  it('prefixes ids and names, and keeps only language-* classes', () => {
    const out = sanitizeHtml('<a id="x" name="y" class="btn language-js" href="/z">a</a>')
    const a = parseInert(out).querySelector('a')!
    expect(a.getAttribute('id')).toBe('user-content-x')
    expect(a.getAttribute('name')).toBe('user-content-y')
    expect(a.getAttribute('class')).toBe('language-js')
  })
})

describe('createSanitizer', () => {
  it('runs on a window it is given', () => {
    const { window } = new JSDOM('')
    const s = createSanitizer(window as unknown as Parameters<typeof createSanitizer>[0])
    expect(s.available).toBe(true)
    expect(s.renderMarkdown('**x**<img src=x onerror=alert(1)>')).toBe('<p><strong>x</strong><img src="x" loading="lazy" referrerpolicy="no-referrer"></p>\n')
  })

  it('fails closed without a DOM: escaped text, never markup', () => {
    const s = createSanitizer({} as never)
    expect(s.available).toBe(false)
    expect(s.sanitizeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
    expect(s.sanitizeEmbedHtml('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;')
    expect(s.renderMarkdown('<b>a</b>\nb')).toBe('&lt;b&gt;a&lt;/b&gt;<br>b')
  })

  it('keeps separate sanitisers apart, including their options', () => {
    const a = createSanitizer(new JSDOM('').window as never)
    const b = createSanitizer(new JSDOM('').window as never)
    expect(a.renderMarkdown('[x](https://example.com)', { externalLinkTarget: null })).not.toContain('target')
    expect(b.renderMarkdown('[x](https://example.com)')).toContain('target="_blank"')
  })
})

describe('escapeHtml', () => {
  it('escapes text and attribute context', () => {
    expect(escapeHtml(`<a href="x" t='y'>\`&`)).toBe('&lt;a href=&quot;x&quot; t=&#39;y&#39;&gt;&#96;&amp;')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(5)).toBe('5')
  })
})
