// Verifies that the built package matches the `exports` map: every declared
// file exists in dist/, and every `import` target loads and exposes at least
// one export. Run after `npm run build`.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const failures = []
const fail = (msg) => failures.push(msg)

function* targets(subpath, value) {
  if (typeof value === 'string') {
    yield { subpath, condition: null, file: value }
    return
  }
  for (const [condition, file] of Object.entries(value)) {
    yield { subpath, condition, file }
  }
}

for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
  for (const t of targets(subpath, value)) {
    if (!t.file.startsWith('./')) {
      fail(`${subpath}: target "${t.file}" must start with ./`)
      continue
    }
    const abs = resolve(root, t.file)
    if (!existsSync(abs)) {
      fail(`${subpath}: missing file ${t.file} (condition ${t.condition ?? 'default'})`)
      continue
    }
    if (t.condition === 'import' && t.file.endsWith('.js')) {
      const mod = await import(pathToFileURL(abs).href)
      if (Object.keys(mod).length === 0) fail(`${subpath}: ${t.file} has no exports`)
    }
    // Browser builds are meant to be copied or served as a single file: no imports allowed.
    if (t.file.endsWith('.browser.js')) {
      const src = readFileSync(abs, 'utf8')
      if (/^\s*import\s|\bimport\(|\brequire\(|^\s*export\s[^;]*\sfrom\s/m.test(src)) {
        fail(`${subpath}: ${t.file} must be self-contained (found an import)`)
      }
    }
  }
}

// The package root must keep exposing the overlay client factory.
const rootEntry = pkg.exports?.['.']?.import
if (rootEntry) {
  const mod = await import(pathToFileURL(resolve(root, rootEntry)).href)
  if (typeof mod.createOverlayClient !== 'function') {
    fail('"." no longer exports createOverlayClient')
  }
}

if (failures.length > 0) {
  console.error('exports check failed:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`exports check ok (${Object.keys(pkg.exports ?? {}).length} subpaths)`)
