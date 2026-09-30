// Checks on a sanitiser's output: the invariants that make it safe to put in
// innerHTML, asserted on the parsed DOM rather than on the string.
import { JSDOM } from 'jsdom'

const FORBIDDEN_TAGS = new Set([
  'script', 'svg', 'math', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'button',
  'textarea', 'select', 'option', 'optgroup', 'style', 'base', 'meta', 'link', 'noscript', 'template',
  'dialog', 'portal', 'fencedframe', 'title', 'head', 'body', 'html', 'xmp', 'plaintext', 'listing',
  'isindex', 'keygen', 'marquee',
])
const FORBIDDEN_ATTRS = new Set(['style', 'srcdoc', 'formaction', 'form', 'action', 'autofocus', 'ping', 'slot', 'autoplay'])
const URL_ATTRS = new Set([
  'href', 'src', 'srcset', 'poster', 'cite', 'background', 'action', 'formaction', 'data', 'longdesc',
  'usemap', 'dynsrc', 'lowsrc', 'xlink:href', 'codebase', 'manifest', 'icon',
])
const DATA_OK_TAGS = new Set(['img', 'video', 'audio', 'source', 'track'])
const SAFE_URL = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i

const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document

/** Parse markup without running anything (a template's content is inert). */
export function parseInert(html: string): DocumentFragment {
  const t = doc.createElement('template')
  t.innerHTML = html
  return t.content
}

/** Every reason `html` is not safe to insert, or an empty list. */
export function violations(html: string): string[] {
  const out: string[] = []
  const fragment = parseInert(html)
  for (const el of Array.from(fragment.querySelectorAll('*'))) {
    const tag = el.localName
    const where = `<${tag}>`
    if (FORBIDDEN_TAGS.has(tag)) out.push(`${where}: forbidden element`)
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') out.push(`${where}: foreign namespace ${el.namespaceURI}`)
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value
      if (name.startsWith('on')) out.push(`${where}: event handler ${name}`)
      if (FORBIDDEN_ATTRS.has(name)) out.push(`${where}: forbidden attribute ${name}`)
      if (name === 'is' && value !== '') out.push(`${where}: is="${value}"`)
      if (name.startsWith('data-') || name.startsWith('hx-') || name.startsWith('x-')) out.push(`${where}: ${name}`)
      if (name === 'id' || name === 'name') {
        if (!value.startsWith('user-content-')) out.push(`${where}: unprefixed ${name}="${value}"`)
      }
      if (name === 'class') {
        for (const c of value.split(/\s+/).filter(Boolean)) {
          if (!/^language-[\w+#.-]+$/.test(c)) out.push(`${where}: class ${c}`)
        }
      }
      if (URL_ATTRS.has(name)) {
        // Browsers ignore ASCII whitespace and control characters inside a scheme.
        // eslint-disable-next-line no-control-regex
        const bare = value.replace(/[\u0000- ]/g, '')
        if (/^data:/i.test(bare)) {
          if (!(DATA_OK_TAGS.has(tag) && name === 'src')) out.push(`${where}: data: URL in ${name}`)
        } else if (!SAFE_URL.test(bare) && bare !== '') {
          out.push(`${where}: unsafe URL in ${name}: ${value}`)
        }
        if (/^(?:javascript|vbscript|livescript|mocha):/i.test(bare)) out.push(`${where}: script URL in ${name}`)
      }
      if (name === 'srcset' && /(?:javascript|vbscript):/i.test(value)) out.push(`${where}: script URL in srcset`)
    }
    if (tag === 'a' || tag === 'area') {
      if (el.hasAttribute('href')) {
        const rel = (el.getAttribute('rel') ?? '').split(/\s+/)
        for (const need of ['noopener', 'noreferrer', 'nofollow', 'ugc']) {
          if (!rel.includes(need)) out.push(`${where}: rel lacks ${need}`)
        }
      }
      const target = el.getAttribute('target')
      if (target !== null && target !== '_blank') out.push(`${where}: target ${target}`)
      if (target === '_blank' && !/^(?:https?:)?\/\//i.test((el.getAttribute('href') ?? '').trim())) {
        out.push(`${where}: target _blank on a non-external link`)
      }
    }
    if (tag === 'input' && (!el.hasAttribute('disabled') || el.getAttribute('type') !== 'checkbox')) {
      out.push(`${where}: an active input`)
    }
  }
  return out
}
