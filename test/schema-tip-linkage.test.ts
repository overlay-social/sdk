import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  UnlockingScript,
  Utils,
  type RevealSpecificKeyLinkageArgs,
  type WalletInterface,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  BRC29_LINKAGE_VERIFIER,
  BRC29_PROTOCOL,
  Brc29LinkageError,
  PROTO_MAP,
  SchemaError,
  brc29Linkage,
  brc29Output,
  brc29PayeeScript,
  opReturnPushes,
  payment,
  tip,
  verifyAip,
  type TipWallet,
} from '../src/schema/index.js'

// ---------------------------------------------------------------------------
// The readers' rule, ported. A tip record (MAP type=payment) is credited only
// for what the chain proves; for a BRC-29 tip that takes MAP `linkage`.
//
// indexerAttributeTip is peck-indexer-go `attributeTip` (tip_attribution.go)
// line for line, minus the log text: self-payment refused, then P2PKH to the
// author's address (p2pkh-author), then a BRC-29 output to recipient + L·G
// where the recipient identity key is bound to the author (brc29-linkage).
// overlayAttributeTip is peck-overlay-schema `attributeTipToAuthor`
// (src/lib/tipAttribution.ts): P2PKH to the author only; it writes no row for
// a BRC-29 tip and leaves it to the indexer.
// ---------------------------------------------------------------------------

const COMPRESSED_PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/
const P2PKH_RE = /^76a914([0-9a-f]{40})88ac$/

const p2pkhAddress = (scriptHex: string): string | null => {
  const m = P2PKH_RE.exec(scriptHex.toLowerCase())
  return m ? Utils.toBase58Check(Utils.toArray(m[1]!, 'hex'), [0x00]) : null
}
const pubkeyToAddress = (key: string) => PublicKey.fromString(key).toAddress()

interface Out { satoshis: number; script: string }
interface Claim { recipient: string; value: string; linkage: string }
interface Attribution { amount: number; method?: string; reason?: string }

const sumTo = (outputs: Out[], match: (script: string) => boolean) =>
  outputs.reduce((n, o) => (o.satoshis > 0 && match(o.script) ? n + o.satoshis : n), 0)

function indexerAttributeTip(
  outputs: Out[], authorAddr: string, senderAddr: string, c: Claim,
  ownsAddress: (identityKey: string, address: string) => boolean,
): Attribution {
  if (COMPRESSED_PUBKEY_RE.test(authorAddr)) authorAddr = pubkeyToAddress(authorAddr.toLowerCase())
  if (!authorAddr) return { amount: 0 }
  if (senderAddr && senderAddr === authorAddr) return { amount: 0, reason: 'self-payment' }
  const direct = sumTo(outputs, (s) => p2pkhAddress(s) === authorAddr)
  if (direct > 0) return { amount: direct, method: 'p2pkh-author' }
  const recipient = c.recipient.trim().toLowerCase()
  if (!COMPRESSED_PUBKEY_RE.test(recipient)) return { amount: 0, reason: 'no output pays the author' }
  const linkage = c.linkage.trim().toLowerCase()
  if (!linkage) return { amount: 0, reason: 'without a public linkage' }
  if (!ownsAddress(recipient, authorAddr)) return { amount: 0, reason: 'not bound' }
  let payee: string
  try {
    payee = brc29PayeeScript(recipient, linkage)
  } catch (e) {
    return { amount: 0, reason: `linkage rejected: ${(e as Error).message}` }
  }
  const sats = sumTo(outputs, (s) => s === payee)
  if (sats > 0) return { amount: sats, method: 'brc29-linkage' }
  return { amount: 0, reason: 'no output pays the derived key' }
}

function overlayAttributeTip(outputs: Out[], authorAddr: string, senderAddr: string | null): Attribution {
  if (senderAddr && senderAddr === authorAddr) return { amount: 0, reason: 'self-payment' }
  const sats = sumTo(outputs, (s) => p2pkhAddress(s) === authorAddr)
  return sats > 0 ? { amount: sats, method: 'p2pkh-author' } : { amount: 0, reason: 'no output pays the author' }
}

/** What the indexer reads from a tip transaction: outputs, the MAP fields of the payment record, the AIP signer address. */
function readTip(txHex: string) {
  const tx = Transaction.fromHex(txHex)
  const outputs: Out[] = tx.outputs.map((o) => ({ satoshis: Number(o.satoshis ?? 0), script: o.lockingScript.toHex() }))
  for (const o of outputs) {
    if (!o.script.startsWith('006a')) continue
    const pushes = opReturnPushes(o.script)!.map((b) => Utils.toUTF8(b))
    if (pushes[0] !== PROTO_MAP || pushes[1] !== 'SET') continue
    const pipe = pushes.indexOf('|')
    const map: Record<string, string> = {}
    const kv = pushes.slice(2, pipe < 0 ? undefined : pipe)
    for (let i = 0; i + 1 < kv.length; i += 2) map[kv[i]!] = kv[i + 1]!
    if (map['type'] !== 'payment') continue
    const aip = verifyAip(o.script)
    return {
      tx,
      outputs,
      map,
      mapPushes: opReturnPushes(o.script)!.slice(0, pipe < 0 ? undefined : pipe),
      signer: aip?.valid ? pubkeyToAddress(aip.signer) : '',
      claim: { recipient: map['paymail'] ?? '', value: map['value'] ?? '', linkage: map['linkage'] ?? '' },
    }
  }
  throw new Error('no MAP type=payment output')
}

const boundTo = (bindings: Record<string, string>) => (key: string, addr: string) => bindings[key] === addr

// ---------------------------------------------------------------------------

const T1 = 'bd3a2a5ab5ae328676a84517dc59127d4bc1ef33788ea2f53c9f435a5e839570'
const alice = new ProtoWallet(new PrivateKey(1001)) // the sender
const bob = new ProtoWallet(new PrivateKey(1002)) // the post author
const bobKey = (await bob.getPublicKey({ identityKey: true })).publicKey
const aliceKey = (await alice.getPublicKey({ identityKey: true })).publicKey
// The address the author signs posts with (the SDK's default AIP key), bound to bobKey on chain.
const bobPostSigner = PublicKey.fromString(
  (await bob.getPublicKey({ protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })).publicKey,
).toAddress()

// The readers' own cross-implementation vector (peck-indexer-go
// tip_attribution_test.go, peck-overlay-schema test/tip-attribution.fixtures.json).
const READER = {
  recipient: '02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
  linkage: '066cd424029fe94ac4420c29fe3a2ffdc2129ad147eb75036fe022dd8d101c61',
  payee: '76a91430755516539ca6618251ff35a2ac1de1498d615e88ac',
  change: '76a91482a37a2de2f3de093283577788fd9b5dcfef921088ac',
}
const fixture = (name: string) => resolve(import.meta.dirname, 'fixtures/schema', name)

/** A tip transaction the way a wallet lays it out: record, payment, then the sender's self-derived change. */
async function tipTx(outputs: { lockingScript: string; satoshis: number }[]): Promise<string> {
  const change = await alice.getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: 'change 1', counterparty: 'self', forSelf: true })
  const tx = new Transaction()
  tx.addInput({ sourceTXID: 'ee'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  for (const o of outputs) tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis })
  tx.addOutput({ lockingScript: new P2PKH().lock(PublicKey.fromString(change.publicKey).toHash()), satoshis: 5000 })
  return tx.toHex()
}

describe('payment() with a linkage', () => {
  const L = 'ab'.repeat(32)
  it('writes MAP linkage after value', () => {
    const t = payment({ app: 'peck.to', targetTxid: T1, recipient: bobKey, amount: 1000, linkage: L.toUpperCase() })
      .pushes.map((b) => Utils.toUTF8([...b]))
    expect(t).toEqual([PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'payment', 'tx', T1, 'paymail', bobKey, 'value', '1000', 'linkage', L])
  })

  it('lays out the record exactly as the readers\' own fixture does (byte for byte, up to the AIP section)', () => {
    const r = readTip(readFileSync(fixture('reader-brc29-tip-with-linkage.hex'), 'utf8').trim())
    expect(r.claim).toEqual({ recipient: READER.recipient, value: '1000', linkage: READER.linkage })
    const ours = payment({ app: r.map['app']!, targetTxid: r.map['tx']!, recipient: READER.recipient, amount: 1000, linkage: READER.linkage })
    expect(ours.pushes.map((b) => Utils.toHex([...b]))).toEqual(r.mapPushes.map((b) => Utils.toHex(b)))
  })

  for (const [name, linkage] of [['short', 'abcd'], ['non-hex', 'zz'.repeat(32)], ['empty', ''], ['too long', 'ab'.repeat(33)]] as const) {
    it(`rejects a ${name} linkage`, () => {
      expect(() => payment({ app: 'x', targetTxid: T1, recipient: bobKey, amount: 1, linkage })).toThrow(SchemaError)
    })
  }
})

describe('brc29PayeeScript(): recipient + L·G', () => {
  it('matches the readers\' cross-implementation vector', () => {
    expect(brc29PayeeScript(READER.recipient, READER.linkage)).toBe(READER.payee)
    expect(brc29PayeeScript(READER.recipient.toUpperCase().replace(/^0/, '0'), READER.linkage.toUpperCase())).toBe(READER.payee)
  })

  const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
  const bad: Record<string, [string, string]> = {
    'zero scalar': [READER.recipient, '00'.repeat(32)],
    'scalar = order': [READER.recipient, N],
    'short linkage': [READER.recipient, 'abcd'],
    'non-hex linkage': [READER.recipient, 'zz'.repeat(32)],
    'address as key': ['1GN4KTADQ5prprzEAvuLdJut1NgXvju3Sm', READER.linkage],
    'x beyond field': ['02' + 'ff'.repeat(32), READER.linkage],
  }
  for (const [name, [key, l]] of Object.entries(bad)) {
    it(`rejects ${name} (as the indexer does)`, () => expect(() => brc29PayeeScript(key, l)).toThrow(SchemaError))
  }
})

describe('brc29Linkage(): one revealSpecificKeyLinkage call', () => {
  it('reveals L such that recipient + L·G is the key brc29Output paid and the recipient wallet derives', async () => {
    const out = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1000 })
    const { derivationPrefix, derivationSuffix } = out.remittance
    const L = await brc29Linkage(alice, { recipientIdentityKey: bobKey, derivationPrefix, derivationSuffix })
    expect(L).toMatch(/^[0-9a-f]{64}$/)
    expect(brc29PayeeScript(bobKey, L)).toBe(out.lockingScript)
    const own = await bob.getPublicKey({
      protocolID: BRC29_PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: aliceKey, forSelf: true,
    })
    expect(new P2PKH().lock(PublicKey.fromString(own.publicKey).toHash()).toHex()).toBe(out.lockingScript)
  })

  it('asks with the recipient as counterparty, BRC-29 protocol, "<prefix> <suffix>" and the public verifier', async () => {
    const calls: RevealSpecificKeyLinkageArgs[] = []
    const origins: (string | undefined)[] = []
    const spy = {
      revealSpecificKeyLinkage: (a: RevealSpecificKeyLinkageArgs, o?: string) => { calls.push(a); origins.push(o); return alice.revealSpecificKeyLinkage(a) },
    }
    await brc29Linkage(spy, { recipientIdentityKey: bobKey.toUpperCase().replace(/^0X/, ''), derivationPrefix: 'pre', derivationSuffix: 'suf', originator: 'peck.to' })
    expect(calls).toEqual([{ counterparty: bobKey, verifier: BRC29_LINKAGE_VERIFIER, protocolID: BRC29_PROTOCOL, keyID: 'pre suf' }])
    expect(origins).toEqual(['peck.to'])
    expect(BRC29_LINKAGE_VERIFIER).toBe(new PrivateKey(1).toPublicKey().toString())
  })

  const parts = { recipientIdentityKey: bobKey, derivationPrefix: 'p', derivationSuffix: 's' }

  it('fails "unsupported" for a wallet without the call', async () => {
    await expect(brc29Linkage({} as TipWallet, parts)).rejects.toMatchObject({ name: 'Brc29LinkageError', reason: 'unsupported' })
  })

  it('fails "refused" when the wallet throws, keeping its error as the cause', async () => {
    const no = new Error('User denied')
    const err = await brc29Linkage({ revealSpecificKeyLinkage: async () => { throw no } }, parts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Brc29LinkageError)
    expect(err).toMatchObject({ reason: 'refused', cause: no })
  })

  it('fails "invalid" on garbage, or a linkage encrypted for a different verifier', async () => {
    const garbage = { revealSpecificKeyLinkage: async () => ({ prover: aliceKey, encryptedLinkage: [1, 2, 3] }) } as unknown as TipWallet
    await expect(brc29Linkage(garbage, parts)).rejects.toMatchObject({ reason: 'invalid' })
    const private_ = {
      revealSpecificKeyLinkage: (a: RevealSpecificKeyLinkageArgs) => alice.revealSpecificKeyLinkage({ ...a, verifier: bobKey }),
    }
    await expect(brc29Linkage(private_, parts)).rejects.toMatchObject({ reason: 'invalid' })
    const noProver = { revealSpecificKeyLinkage: async () => ({ encryptedLinkage: [] }) } as unknown as TipWallet
    await expect(brc29Linkage(noProver, parts)).rejects.toMatchObject({ reason: 'invalid' })
  })

  it('rejects bad input before calling the wallet', async () => {
    await expect(brc29Linkage(alice, { ...parts, recipientIdentityKey: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' })).rejects.toThrow(SchemaError)
    await expect(brc29Linkage(alice, { ...parts, derivationPrefix: 'a b' })).rejects.toThrow(SchemaError)
  })
})

describe('tip(): a tip both readers can prove', () => {
  it('is credited by the indexer rule as brc29-linkage, and the change is not', async () => {
    const t = await tip({ app: 'peck.to', targetTxid: T1, recipientIdentityKey: bobKey, satoshis: 1000 }, { wallet: alice })
    const r = readTip(await tipTx(t.outputs))
    expect(r.claim).toEqual({ recipient: bobKey, value: '1000', linkage: t.linkage })
    expect(r.map['tx']).toBe(T1)
    expect(verifyAip(t.outputs[0].lockingScript)?.valid).toBe(true)
    const got = indexerAttributeTip(r.outputs, bobPostSigner, r.signer, r.claim, boundTo({ [bobKey]: bobPostSigner }))
    expect(got).toEqual({ amount: 1000, method: 'brc29-linkage' })
    // Same post, author stored as the AIP public key (overlay-admitted posts).
    const bobSigningKey = (await bob.getPublicKey({ protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })).publicKey
    expect(indexerAttributeTip(r.outputs, bobSigningKey, r.signer, r.claim, boundTo({ [bobKey]: bobPostSigner })).amount).toBe(1000)
  })

  it('is not credited to an identity that is not bound to the post author, nor with a forged linkage', async () => {
    const t = await tip({ app: 'peck.to', targetTxid: T1, recipientIdentityKey: bobKey, satoshis: 1000 }, { wallet: alice })
    const r = readTip(await tipTx(t.outputs))
    expect(indexerAttributeTip(r.outputs, bobPostSigner, r.signer, r.claim, boundTo({}))).toMatchObject({ amount: 0, reason: 'not bound' })
    const forged = { ...r.claim, linkage: 'ab'.repeat(32), value: '5000' }
    expect(indexerAttributeTip(r.outputs, bobPostSigner, r.signer, forged, boundTo({ [bobKey]: bobPostSigner })).amount).toBe(0)
  })

  it('the same tip without the linkage (the old composition) is not credited', async () => {
    const pay = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1000 })
    const { signPayload } = await import('../src/schema/index.js')
    const record = await signPayload(payment({ app: 'peck.to', targetTxid: T1, recipient: bobKey, amount: 1000 }), { wallet: alice })
    const r = readTip(await tipTx([{ lockingScript: record.toHex(), satoshis: 0 }, pay]))
    expect(indexerAttributeTip(r.outputs, bobPostSigner, r.signer, r.claim, boundTo({ [bobKey]: bobPostSigner })))
      .toMatchObject({ amount: 0, reason: 'without a public linkage' })
  })

  it('writes no overlay row (the overlay credits P2PKH to the author only and leaves BRC-29 to the indexer)', async () => {
    const t = await tip({ app: 'peck.to', targetTxid: T1, recipientIdentityKey: bobKey, satoshis: 1000 }, { wallet: alice })
    const r = readTip(await tipTx(t.outputs))
    expect(overlayAttributeTip(r.outputs, bobPostSigner, r.signer).amount).toBe(0)
  })

  it('returns the two createAction outputs, record first, with no fee setting', async () => {
    const t = await tip(
      { app: 'peck.to', targetTxid: T1, recipientIdentityKey: bobKey, satoshis: 700, derivationPrefix: 'pre', derivationSuffix: 'suf' },
      { wallet: alice, originator: 'peck.to' },
    )
    expect(t.outputs[0]).toMatchObject({ satoshis: 0, outputDescription: 'Tip record' })
    expect(t.outputs[1]).toEqual({
      lockingScript: t.payment.lockingScript, satoshis: 700, outputDescription: 'Payment', customInstructions: t.payment.customInstructions,
    })
    expect(t.record.toHex()).toBe(t.outputs[0].lockingScript)
    expect(t.remittance).toEqual({ derivationPrefix: 'pre', derivationSuffix: 'suf', senderIdentityKey: aliceKey })
    const keys: string[] = []
    JSON.stringify(t.outputs, (k, v) => (keys.push(k), v))
    expect(keys.filter((k) => /fee/i.test(k))).toEqual([])
  })

  /** A wallet that records its calls and can be told to misbehave on the linkage. */
  function walletWith(reveal?: WalletInterface['revealSpecificKeyLinkage']) {
    const calls: string[] = []
    const w: TipWallet = {
      getPublicKey: (a) => { calls.push('getPublicKey'); return alice.getPublicKey(a) },
      createSignature: (a) => { calls.push('createSignature'); return alice.createSignature(a) },
      revealSpecificKeyLinkage: (a, o) => { calls.push('revealSpecificKeyLinkage'); return (reveal ?? ((x) => alice.revealSpecificKeyLinkage(x)))(a, o) },
    }
    return { w, calls }
  }
  const input = { app: 'peck.to', targetTxid: T1, recipientIdentityKey: bobKey, satoshis: 1000 }

  it('makes the wallet calls in order: payee key, identity key, linkage, then the AIP signature', async () => {
    const { w, calls } = walletWith()
    await tip(input, { wallet: w })
    expect(calls).toEqual(['getPublicKey', 'getPublicKey', 'revealSpecificKeyLinkage', 'getPublicKey', 'createSignature'])
  })

  it('fails with Brc29LinkageError and signs nothing when the wallet refuses the linkage', async () => {
    const { w, calls } = walletWith(async () => { throw new Error('denied') })
    await expect(tip(input, { wallet: w })).rejects.toMatchObject({ name: 'Brc29LinkageError', reason: 'refused' })
    expect(calls).not.toContain('createSignature')
  })

  it('fails "invalid" and signs nothing when the revealed linkage is for another output', async () => {
    const { w, calls } = walletWith((a) => alice.revealSpecificKeyLinkage({ ...a, keyID: 'other key' }))
    // keyID mismatch makes decryption fail; also try a wallet that keeps the keyID but reveals for another counterparty.
    await expect(tip(input, { wallet: w })).rejects.toMatchObject({ reason: 'invalid' })
    const carolKey = new PrivateKey(1003).toPublicKey().toString()
    const second = walletWith((a) => alice.revealSpecificKeyLinkage({ ...a, counterparty: carolKey }))
    await expect(tip(input, { wallet: second.w })).rejects.toMatchObject({ reason: 'invalid' })
    expect([...calls, ...second.calls]).not.toContain('createSignature')
  })

  it('fails "unsupported" for a wallet without revealSpecificKeyLinkage', async () => {
    const w = { getPublicKey: alice.getPublicKey.bind(alice), createSignature: alice.createSignature.bind(alice) } as unknown as TipWallet
    await expect(tip(input, { wallet: w })).rejects.toMatchObject({ reason: 'unsupported' })
  })

  it('rejects bad input before any wallet call', async () => {
    const { w, calls } = walletWith()
    await expect(tip({ ...input, satoshis: 0 }, { wallet: w })).rejects.toThrow(SchemaError)
    await expect(tip({ ...input, targetTxid: 'abc' }, { wallet: w })).rejects.toThrow(SchemaError)
    await expect(tip({ ...input, recipientIdentityKey: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }, { wallet: w })).rejects.toThrow(SchemaError)
    expect(calls.filter((c) => c !== 'getPublicKey')).toEqual([])
  })

  // A deterministic SDK-built tip (fixed keys, fixed derivation, RFC 6979
  // signatures; unsigned made-up input, never broadcast), for the readers to
  // replay in their own test suites. UPDATE_FIXTURES=1 rewrites it.
  it('reproduces the published tip fixture', async () => {
    const t = await tip(
      { ...input, derivationPrefix: 'Zml4dHVyZQ==', derivationSuffix: 'dGlw' },
      { wallet: alice },
    )
    const hex = await tipTx(t.outputs)
    const path = fixture('sdk-brc29-tip-with-linkage.hex')
    if (process.env['UPDATE_FIXTURES'] === '1') writeFileSync(path, hex + '\n')
    expect(hex).toBe(readFileSync(path, 'utf8').trim())
    const r = readTip(hex)
    expect(indexerAttributeTip(r.outputs, bobPostSigner, r.signer, r.claim, boundTo({ [bobKey]: bobPostSigner })))
      .toEqual({ amount: 1000, method: 'brc29-linkage' })
  })
})
