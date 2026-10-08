// Regenerates test/fixtures/schema/v1-parity.json: the exact output scripts the
// peck.to v1 web client produces for tips, identity profiles and friend records.
//
// The fixture is not hand-written. This script runs v1's own code:
//   - `sendTip` and `PeckApp.Wallet.signAipPayload` from the v1 browser bundle
//     (public/js/app.js), in a node `vm` with a stub browser and a fixed
//     BRC-100 ProtoWallet, and
//   - `build_universal_tx` from the v1 server (core.py), run in Python, which is
//     where v1 turns the tip's pushes into the OP_RETURN script,
//   - `setIdentityProfile` from the v1 browser bundle, whose `createAction`
//     call is captured, and
//   - `Friends.emit` from the same bundle, likewise.
//
// The v1 sources are not in this repository. Point the script at a checkout:
//
//   node scripts/gen-v1-parity-fixtures.mjs --app <v1>/public/js/app.js \
//     --core <v1>/core.py --python <python that can import `bsv`> [--v1-rev <sha>]
//
// All signing here is deterministic (fixed wallet key, RFC 6979 ECDSA, fixed
// profile serial), so the output is reproducible. Run it under node, never bun.
import { Buffer, btoa } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TextEncoder } from 'node:util'
import vm from 'node:vm'
import { Hash, PrivateKey, ProtoWallet } from '@bsv/sdk'

if (process.versions.bun) throw new Error('run this under node, not bun')

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const appPath = arg('--app')
const corePath = arg('--core')
const python = arg('--python')
if (!appPath || !corePath || !python) {
  console.error('usage: gen-v1-parity-fixtures.mjs --app <app.js> --core <core.py> --python <python> [--v1-rev <sha>]')
  process.exit(2)
}

// A throwaway key with no funds, used only for these fixtures.
const WALLET_KEY = 20261006
const wallet = new ProtoWallet(new PrivateKey(WALLET_KEY))
const SERIAL_BYTES = [0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78]

const appSource = readFileSync(resolve(appPath), 'utf8').split('\n')

/** The source of one method of the v1 object literals (8-space indent, closed by `        },`). */
function method(signature) {
  const start = appSource.findIndex((l) => l.startsWith(`        ${signature}`))
  if (start < 0) throw new Error(`v1 method not found: ${signature}`)
  let end = start + 1
  while (appSource[end] !== '        },') end++
  return appSource.slice(start, end + 1).join('\n').replace(/,$/, '')
}

function load(signature, globals) {
  const context = vm.createContext({ ...globals, console: { log() {}, warn() {}, error() {} } })
  const name = signature.match(/async (\w+)\(/)[1]
  return vm.runInContext(`({ ${method(signature)} })`, context)[name]
}

const clone = (v) => JSON.parse(JSON.stringify(v))

/** v1's `window.walletRequest`, backed by the fixed wallet. Records createAction calls. */
function makeWindow(actions) {
  return {
    location: { href: 'https://peck.to/', reload() {} },
    showToast() {},
    ensureBsvSdk: async () => ({ Hash }),
    walletRequest: async (m, p) => {
      if (m === 'getPublicKey') return wallet.getPublicKey(clone(p))
      if (m === 'createSignature') return wallet.createSignature(clone(p))
      if (m === 'createAction') {
        actions.push(clone(p))
        return { txid: '00'.repeat(32), tx: [1, 2, 3] }
      }
      throw new Error(`unexpected wallet call ${m}`)
    },
  }
}

const pythonCode = `
import sys, types, importlib.util, json, asyncio
for name in ('config', 'database', 'paymail'):
    sys.modules[name] = types.ModuleType(name)
spec = importlib.util.spec_from_file_location('core', sys.argv[1])
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
req = json.loads(sys.stdin.read())
res = asyncio.run(core.build_universal_tx(op_return_parts=req['parts'], outputs=req['outputs']))
sys.stdout.write('RESULT ' + json.dumps(res))
`

/** v1's server-side `build_universal_tx`, run for real. */
function buildUniversalTx(parts, outputs) {
  const out = execFileSync(python, ['-c', pythonCode, resolve(corePath)], {
    input: JSON.stringify({ parts, outputs }),
    encoding: 'utf8',
  })
  return JSON.parse(out.slice(out.indexOf('RESULT ') + 7))
}

// ── tips ────────────────────────────────────────────────────────

async function v1Tip({ recipient, txid, amount }) {
  const actions = []
  const win = makeWindow(actions)
  const signAipPayload = load('async signAipPayload(', {
    window: win,
    TextEncoder,
    btoa,
  })
  let sent
  const sendTip = load('async sendTip(', {
    window: win,
    PeckApp: {
      Wallet: {
        getActiveAddress: async () => '1TestSenderAddress',
        signAipPayload,
        suppressNextSendToast() {},
        fetchBalance() {},
      },
    },
    WalletAdapter: {
      sendAction: async (prep) => {
        sent = prep
        return { status: 'ok', txid: '11'.repeat(32) }
      },
    },
    fetch: async (url, opts) => {
      if (url !== '/api/prepare_tip') throw new Error(`unexpected fetch ${url}`)
      const body = JSON.parse(opts.body)
      const result = buildUniversalTx(body.map_aip_parts, [{ lockingScript: '76a914', satoshis: body.amount }])
      return { json: async () => result }
    },
  })
  await sendTip(recipient, txid, amount)
  if (!sent?.op_return_script) throw new Error('v1 did not produce an OP_RETURN script')
  return sent.op_return_script
}

const tipInputs = [
  {
    note: 'v1 modal amount (100 sats), recipient as a P2PKH address (what v1 passes today)',
    input: { app: 'peck.to', targetTxid: 'a1'.repeat(32), recipient: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount: 100 },
  },
  {
    note: 'recipient as an identity key (what v2 passes), 2,100 sats',
    input: {
      app: 'peck.to',
      targetTxid: '0b'.repeat(32),
      recipient: new PrivateKey(31337).toPublicKey().toString(),
      amount: 2100,
    },
  },
  {
    note: 'a custom amount',
    input: { app: 'peck.to', targetTxid: 'ef'.repeat(32), recipient: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount: 123456 },
  },
]

const payments = []
for (const t of tipInputs) {
  const scriptHex = await v1Tip({ recipient: t.input.recipient, txid: t.input.targetTxid, amount: t.input.amount })
  payments.push({ ...t, scriptHex })
}

// ── identity profiles ───────────────────────────────────────────

async function v1Profile({ displayName, avatar, bio }) {
  const actions = []
  const win = makeWindow(actions)
  const setIdentityProfile = load('async setIdentityProfile(', {
    window: win,
    document: { getElementById: () => null },
    TextEncoder,
    crypto: {
      getRandomValues(a) {
        for (let i = 0; i < a.length; i++) a[i] = SERIAL_BYTES[i]
        return a
      },
    },
    // v1 asks the server for a generated avatar when none is given; the reply carries none here.
    fetch: async () => ({ json: async () => ({}) }),
  })
  await setIdentityProfile(displayName, avatar, bio)
  const script = actions[0]?.outputs?.[0]?.lockingScript
  if (!script) throw new Error('v1 did not call createAction with an output')
  return script
}

const long = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const profileInputs = [
  { note: 'name, avatar URL and bio', input: { displayName: 'Ada Lovelace', avatar: 'https://example.com/ada.png', bio: 'First programmer.' } },
  { note: 'name only', input: { displayName: 'Ada' } },
  { note: 'avatar only (uhrp reference)', input: { avatar: 'uhrp://XUU7cTfy6fA6q2neLDmzPqJnGB6o18PXKoGaWLPrtC8cZ5Ydsiw1' } },
  { note: 'bio only', input: { bio: 'bio only' } },
  { note: 'non-ASCII name, emoji, quotes, backslash and newline in the bio', input: { displayName: 'Åse Nørgård 🦊', bio: 'She said "hi"\\ and\nleft; ≠ ASCII' } },
  { note: 'values at the push-size boundaries (75, 76 and 300 bytes)', input: { displayName: long('n', 75), avatar: 'https://example.com/' + long('a', 56), bio: long('Lorem ipsum ', 300) } },
  { note: 'one-byte values', input: { displayName: 'A', bio: '1' } },
  { note: 'empty strings are left out, as v1 does', input: { displayName: 'Ada', avatar: '', bio: '' } },
  { note: 'a value containing a pipe is fine; only a lone "|" would collide', input: { displayName: 'a|b', bio: '||' } },
]
const profiles = []
for (const p of profileInputs) {
  profiles.push({ ...p, scriptHex: await v1Profile(p.input) })
}

// ── friend records ──────────────────────────────────────────────

/**
 * v1's `Friends.emit(kind, peerRoot)`: builds, signs and submits a friend or
 * unfriend record. `emit` reads `this.OVERLAY`, so it is called with that set;
 * its overlay `/submit` call is answered by a stub, and the script it hands
 * to `createAction` is what is captured.
 */
async function v1Friend(kind, peerRoot) {
  const actions = []
  const win = makeWindow(actions)
  const emit = load('async emit(', {
    window: win,
    TextEncoder,
    crypto: {
      getRandomValues(a) {
        for (let i = 0; i < a.length; i++) a[i] = SERIAL_BYTES[i]
        return a
      },
    },
    fetch: async () => ({ ok: true, status: 200 }),
  })
  await emit.call({ OVERLAY: 'https://overlay.peck.to' }, kind, peerRoot)
  const script = actions[0]?.outputs?.[0]?.lockingScript
  if (!script) throw new Error('v1 did not call createAction with an output')
  return script
}

const peerA = new PrivateKey(31338).toPublicKey().toString()
const peerB = new PrivateKey(31339).toPublicKey().toString()
const friendInputs = [
  { note: 'a friend request', kind: 'friend', input: { peer: peerA } },
  { note: 'a friend request to another key (an accept looks the same)', kind: 'friend', input: { peer: peerB } },
  { note: 'a withdrawal', kind: 'unfriend', input: { peer: peerA } },
]
const friends = []
for (const f of friendInputs) {
  friends.push({ ...f, scriptHex: await v1Friend(f.kind, f.input.peer) })
}

const identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
const out = {
  about:
    'Generated by scripts/gen-v1-parity-fixtures.mjs from the peck.to v1 client code (sendTip, signAipPayload, ' +
    'setIdentityProfile, Friends.emit) and the v1 server build_universal_tx. Do not edit by hand.',
  v1Rev: arg('--v1-rev') ?? null,
  walletKey: WALLET_KEY,
  identityKey,
  serial: Buffer.from(SERIAL_BYTES).toString('hex'),
  payments,
  profiles,
  friends,
}
const target = resolve(import.meta.dirname, '../test/fixtures/schema/v1-parity.json')
writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${payments.length} payments, ${profiles.length} profiles and ${friends.length} friend records to ${target}`)
