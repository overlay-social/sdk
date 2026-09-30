// Runs the built single-file sanitiser (dist/sanitize.browser.js) in a real headless Chrome
// against the XSS corpus, and checks that nothing executes and the output DOM is clean.
// jsdom parses HTML differently from a browser, so this covers what the unit tests cannot.
//
//   npm run build && npm run check:sanitize-browser
//
// Not part of `verify` (CI has no browser step). Exits 0 with a notice when no Chrome or
// Chromium is installed; set CHROME to point at one.
import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bundle = join(root, 'dist/sanitize.browser.js')
if (!existsSync(bundle)) {
  console.error('dist/sanitize.browser.js is missing: run `npm run build` first')
  process.exit(1)
}

const chrome = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']
  .filter(Boolean)
  .find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0)
if (!chrome) {
  console.log('no Chrome or Chromium found (set CHROME): browser check skipped')
  process.exit(0)
}

const corpus = JSON.parse(readFileSync(join(root, 'test/fixtures/sanitize/xss-corpus.json'), 'utf8')).payloads

const page = `<!doctype html><meta charset="utf-8"><body><div id="out"></div>
<script>window.__xss = 0; window.__canary = 0; window.alert = function () { window.__xss = 'alert' }</script>
<script type="module">
import { renderMarkdown, sanitizeHtml, sanitizeEmbedHtml, isSanitizerAvailable } from './sanitize.browser.js'
const corpus = ${JSON.stringify(corpus).replace(/</g, '\\u003c')}
const BAD_TAGS = new Set(['script','svg','math','iframe','frame','frameset','object','embed','applet','form','button','textarea','select','option','optgroup','style','base','meta','link','noscript','template','dialog','portal','fencedframe','marquee','xmp','plaintext','listing'])
const BAD_ATTRS = new Set(['style','srcdoc','formaction','form','action','autofocus','ping','slot'])
const URLS = new Set(['href','src','poster','cite','background','data','longdesc','usemap','dynsrc','lowsrc','xlink:href'])
function problems(el) {
  const out = []
  for (const n of el.querySelectorAll('*')) {
    const t = n.localName
    if (BAD_TAGS.has(t)) out.push('<' + t + '>')
    if (n.namespaceURI !== 'http://www.w3.org/1999/xhtml') out.push('namespace on <' + t + '>')
    for (const a of n.attributes) {
      const name = a.name.toLowerCase()
      const bare = a.value.replace(/[\\u0000-\\u0020]/g, '')
      if (name.startsWith('on') || BAD_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('hx-')) out.push(t + ' ' + name)
      if (name === 'is' && a.value !== '') out.push('is=' + a.value)
      if ((name === 'id' || name === 'name') && !a.value.startsWith('user-content-')) out.push(t + ' ' + name + '=' + a.value)
      if (URLS.has(name) && /^(javascript|vbscript):/i.test(bare)) out.push(t + ' ' + name + ' script URL')
      if (URLS.has(name) && /^data:/i.test(bare) && !(name === 'src' && ['img','video','audio','source','track'].includes(t))) out.push(t + ' ' + name + ' data URL')
    }
    if (t === 'a' && n.hasAttribute('href') && !/noopener/.test(n.rel)) out.push('a without rel')
    if (t === 'a' && n.target && n.target !== '_blank') out.push('a target ' + n.target)
  }
  return out
}
const results = { available: isSanitizerAvailable(), problems: [], canary: 0, xss: 0, count: 0 }
const holder = document.getElementById('out')
for (const { name, payload } of corpus) {
  const variants = { html: sanitizeHtml(payload), markdown: renderMarkdown(payload), embed: sanitizeEmbedHtml(payload) }
  for (const [kind, html] of Object.entries(variants)) {
    const el = document.createElement('div')
    el.innerHTML = html
    holder.appendChild(el)
    results.count++
    for (const p of problems(el)) results.problems.push(name + ' [' + kind + ']: ' + p)
  }
}
// The harness must be able to see execution: an unsanitised handler has to fire.
const canary = document.createElement('div')
canary.innerHTML = '<img src="x:x" onerror="window.__canary = 1">'
holder.appendChild(canary)
setTimeout(() => {
  results.canary = window.__canary
  results.xss = window.__xss
  document.documentElement.setAttribute('data-results', JSON.stringify(results))
}, 4000)
</script>`

const dir = mkdtempSync(join(tmpdir(), 'sanitize-browser-'))
writeFileSync(join(dir, 'index.html'), page)
copyFileSync(bundle, join(dir, 'sanitize.browser.js'))
const server = createServer((req, res) => {
  const file = req.url === '/sanitize.browser.js' ? 'sanitize.browser.js' : 'index.html'
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' })
  res.end(readFileSync(join(dir, file)))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const { port } = server.address()

// A throw-away profile, so no session, extension or running browser is involved. The page is
// served from this process, so Chrome must run without blocking it.
const profile = join(dir, 'profile')
const run = await new Promise((done) => {
  const child = execFile(
    chrome,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-features=AsyncDns',
      `--user-data-dir=${profile}`, '--virtual-time-budget=15000', '--dump-dom', `http://127.0.0.1:${port}/`,
    ],
    { encoding: 'utf8', timeout: 90_000, maxBuffer: 256 * 1024 * 1024 },
    (error, stdout) => done({ stdout, error }),
  )
  child.stdin?.end()
})
server.close()
rmSync(dir, { recursive: true, force: true })

const m = /data-results="([^"]*)"/.exec(run.stdout ?? '')
if (!m) {
  console.error('Chrome produced no result (did the page load?)')
  process.exit(1)
}
const r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
const failures = []
if (!r.available) failures.push('the sanitiser found no DOM in the browser')
if (r.canary !== 1) failures.push('the canary did not fire: the harness cannot see script execution')
if (r.xss !== 0) failures.push(`a payload executed (window.__xss = ${r.xss})`)
failures.push(...r.problems)
if (failures.length > 0) {
  console.error(`browser check failed (${r.count} outputs):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`browser check ok: ${corpus.length} payloads x 3 entry points (${r.count} outputs), nothing executed (canary fired)`)
