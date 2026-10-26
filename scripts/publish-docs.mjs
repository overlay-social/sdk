// Dry run of publishing a folder of markdown documents as spec 09 revision
// series. Nothing is broadcast: this script has no network code at all. It
// builds and signs every revision script, verifies each one with
// verifyDocumentRevision(), checks each series with verifyChain(), and prints
// what would be published.
//
//   npm run build
//   node scripts/publish-docs.mjs --repo <git repo> --dir specs --commits 5687a08,9344098 \
//     [--namespace overlay.social/specs] [--app overlay.social] \
//     [--source-base https://github.com/overlay-social/specs/blob] \
//     [--note <commit>=<one line>]... [--json]
//
// Revisions: the commits are read in the order given. A file's first commit
// is its revision 1; every later commit where its bytes differ is the next
// revision. Unchanged files get no new revision.
//
// Each document is `<namespace>/<NN>` for a file named `NN-*.md`, else
// `<namespace>/<file name without .md>`. The title is the first `# ` heading
// without its leading number, and the status the first uppercase word after
// "Status:" in the file. `source` is the file at its full commit hash.
//
// Placeholders: a revision's `prev` is the txid of the revision before it,
// which only exists once that transaction is built and funded. Here `prev` is
// SHA-256("dry-run placeholder for the txid of <doc> rev <n>"): the same
// length as a real txid, so every size printed is exact.
//
// Key: the revisions are signed with an EPHEMERAL key made in memory for this
// run (a ProtoWallet, default derivation [1, 'identity'] / '1' / 'self'). It
// is never written anywhere and is gone when the script exits. The real
// publishing key is the BRC-100 wallet's, once it is approved; broadcasting
// is a separate step through the wallet (createAction) and submitToOverlay().
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { documentRevision, signPayload, verifyChain, verifyDocumentRevision } from '../dist/schema.js'

if (process.versions.bun) throw new Error('run this under node, not bun')

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const all = (name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []))

const repo = arg('--repo')
const dir = (arg('--dir') ?? 'specs').replace(/\/+$/, '')
const commitArgs = (arg('--commits') ?? '').split(',').map((c) => c.trim()).filter(Boolean)
const namespace = arg('--namespace') ?? 'overlay.social/specs'
const app = arg('--app') ?? 'overlay.social'
const sourceBase = (arg('--source-base') ?? 'https://github.com/overlay-social/specs/blob').replace(/\/+$/, '')
const asJson = args.includes('--json')
if (!repo || commitArgs.length === 0) {
  console.error('usage: node scripts/publish-docs.mjs --repo <path> --dir <docs dir> --commits <c1,c2,...> [--namespace ns] [--app app] [--source-base url] [--note <commit>=<text>] [--json]')
  process.exit(2)
}

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 64 * 1024 * 1024 })
const commits = commitArgs.map((c) => git('rev-parse', '--verify', `${c}^{commit}`).toString('utf8').trim())
const notes = new Map(all('--note').map((n) => {
  const at = n.indexOf('=')
  if (at < 1) throw new Error(`--note must be <commit>=<text>: ${n}`)
  return [git('rev-parse', '--verify', `${n.slice(0, at)}^{commit}`).toString('utf8').trim(), n.slice(at + 1)]
}))

const sha = (s) => Utils.toHex(Hash.sha256(Utils.toArray(s, 'utf8')))
const placeholderTxid = (doc, rev) => sha(`dry-run placeholder for the txid of ${doc} rev ${rev}`)

function docId(file) {
  const m = /^(\d+)-/.exec(file)
  return `${namespace}/${m ? m[1] : file.replace(/\.md$/, '').toLowerCase()}`
}

function titleOf(text) {
  const h = /^# (.+)$/m.exec(text)
  return h ? h[1].replace(/\s+$/, '').replace(/^\d+\s*[—–-]\s*/, '') : undefined
}

function statusOf(text, file) {
  const m = /Status:\s*\**\s*([A-Z]+)\b/.exec(text)
  if (!m) throw new Error(`${file}: no "Status: WORD" line`)
  return m[1]
}

// ── build ───────────────────────────────────────────────────────

const key = PrivateKey.fromRandom()
const wallet = new ProtoWallet(key)
const { publicKey: signingKey } = await wallet.getPublicKey({ protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })

const series = new Map() // doc -> [{ rev, bytes, ... }]
const rows = []
for (const commit of commits) {
  const files = git('ls-tree', '--name-only', `${commit}`, `${dir}/`).toString('utf8').split('\n')
    .filter((f) => f.endsWith('.md')).map((f) => basename(f)).sort()
  for (const file of files) {
    const bytes = git('show', `${commit}:${dir}/${file}`)
    const content = Uint8Array.from(bytes)
    const text = bytes.toString('utf8')
    const doc = docId(file)
    const list = series.get(doc) ?? []
    const last = list[list.length - 1]
    if (last && last.bytes.equals(bytes)) continue
    const rev = list.length + 1
    const input = {
      app,
      doc,
      rev,
      ...(rev > 1 ? { prev: placeholderTxid(doc, rev - 1) } : {}),
      ...(titleOf(text) ? { title: titleOf(text) } : {}),
      status: statusOf(text, `${commit.slice(0, 7)}:${file}`),
      content,
      filename: file,
      source: `${sourceBase}/${commit}/${dir}/${file}`,
      ...(notes.has(commit) ? { note: notes.get(commit) } : {}),
    }
    const script = await signPayload(documentRevision(input), { wallet })
    const check = verifyDocumentRevision(script)
    if (!check.ok || check.signer !== signingKey) {
      throw new Error(`${doc} rev ${rev}: verifyDocumentRevision failed: ${check.errors.join('; ')}`)
    }
    const txid = placeholderTxid(doc, rev)
    list.push({ rev, bytes, txid, script })
    series.set(doc, list)
    rows.push({
      doc,
      rev,
      commit: commit.slice(0, 7),
      status: input.status,
      title: input.title ?? '',
      contentBytes: content.length,
      scriptBytes: script.toBinary().length,
      sha256: check.fields.sha256,
      verified: true,
    })
  }
}

// ── check every series ──────────────────────────────────────────

for (const [doc, list] of series) {
  const chain = verifyChain(list.map((r) => ({ txid: r.txid, revision: r.script })), { doc, author: signingKey })
  if (!chain.ok || chain.forked || chain.history.length !== list.length || chain.head.rev !== list.length) {
    throw new Error(`${doc}: verifyChain did not return the expected history`)
  }
}

// ── report ──────────────────────────────────────────────────────

const totalContent = rows.reduce((n, r) => n + r.contentBytes, 0)
const totalScript = rows.reduce((n, r) => n + r.scriptBytes, 0)
if (asJson) {
  console.log(JSON.stringify({ dryRun: true, ephemeralSigningKey: signingKey, commits, rows, totalContent, totalScript }, null, 2))
} else {
  console.log('DRY RUN: nothing is broadcast. Signed with an ephemeral in-memory key; prev txids are placeholders.')
  console.log(`ephemeral signing key ${signingKey}`)
  console.log(`commits ${commits.map((c) => c.slice(0, 7)).join(' -> ')}`)
  console.log('')
  const head = ['doc', 'rev', 'commit', 'status', 'content B', 'script B', 'sha256', 'verify']
  const body = rows.map((r) => [r.doc, String(r.rev), r.commit, r.status, String(r.contentBytes), String(r.scriptBytes), r.sha256, 'ok'])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cells) => cells.map((c, i) => (i >= 4 && i <= 5 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ')
  console.log(line(head))
  for (const b of body) console.log(line(b))
  console.log('')
  console.log(`${rows.length} revisions in ${series.size} documents; content ${totalContent} bytes, OP_RETURN scripts ${totalScript} bytes.`)
  console.log('Every revision passed verifyDocumentRevision, and every series verifyChain.')
}
