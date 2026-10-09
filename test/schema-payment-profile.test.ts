import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Utils,
  type CreateActionArgs,
  type CreateSignatureArgs,
  type GetPublicKeyArgs,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  BRC29_PROTOCOL,
  PROTO_MAP,
  SchemaError,
  brc29Output,
  identityProfile,
  identityProfilePreimage,
  opReturnPushes,
  payment,
  post,
  profile,
  signPayload,
  toLockingScript,
  verifyAip,
  verifyIdentityProfile,
  type IdentityProfileWallet,
  type SchemaPayload,
} from '../src/schema/index.js'

const T1 = 'a'.repeat(64)
const texts = (p: SchemaPayload) => p.pushes.map((b) => Utils.toUTF8([...b]))
const asHex = (bytes: readonly number[]) => Utils.toHex([...bytes])

const alice = new ProtoWallet(new PrivateKey(1001))
const bob = new ProtoWallet(new PrivateKey(1002))
const bobKey = (await bob.getPublicKey({ identityKey: true })).publicKey
const aliceKey = (await alice.getPublicKey({ identityKey: true })).publicKey

describe('payment()', () => {
  it('writes MAP SET app, type payment, tx, paymail, value', () => {
    expect(texts(payment({ app: 'peck.to', targetTxid: T1, recipient: bobKey, amount: 2100 }))).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'payment', 'tx', T1, 'paymail', bobKey, 'value', '2100',
    ])
  })

  it('lowercases the txid, as the other builders do', () => {
    expect(texts(payment({ app: 'x', targetTxid: 'B'.repeat(64), recipient: 'r', amount: 1 }))[7]).toBe('b'.repeat(64))
  })

  const bad: Array<[string, () => unknown]> = [
    ['no app', () => payment({ app: '', targetTxid: T1, recipient: 'r', amount: 1 })],
    ['a bad txid', () => payment({ app: 'x', targetTxid: 'abc', recipient: 'r', amount: 1 })],
    ['no recipient', () => payment({ app: 'x', targetTxid: T1, recipient: '', amount: 1 })],
    ['a recipient that is a separator', () => payment({ app: 'x', targetTxid: T1, recipient: '|', amount: 1 })],
    ['zero sats', () => payment({ app: 'x', targetTxid: T1, recipient: 'r', amount: 0 })],
    ['negative sats', () => payment({ app: 'x', targetTxid: T1, recipient: 'r', amount: -5 })],
    ['fractional sats', () => payment({ app: 'x', targetTxid: T1, recipient: 'r', amount: 1.5 })],
    ['NaN sats', () => payment({ app: 'x', targetTxid: T1, recipient: 'r', amount: NaN })],
    ['sats beyond a safe integer', () => payment({ app: 'x', targetTxid: T1, recipient: 'r', amount: 2 ** 60 })],
    ['sats as a string', () => payment({ app: 'x', targetTxid: T1, recipient: 'r', amount: '100' as unknown as number })],
  ]
  for (const [name, fn] of bad) it(`rejects ${name}`, () => expect(fn).toThrow(SchemaError))

  it('is signed with AIP like every other record, and the signature verifies', async () => {
    const script = await signPayload(payment({ app: 'peck.to', targetTxid: T1, recipient: bobKey, amount: 100 }), { wallet: alice })
    expect(verifyAip(script)).toMatchObject({ algorithm: 'BRC77', valid: true })
  })
})

describe('brc29Output(): a standard BRC-29 payment to an identity key', () => {
  it('pays a key the recipient wallet derives itself (round trip)', async () => {
    const out = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 500 })
    // What the recipient's wallet does to take the output in: derive its own
    // key for [prefix suffix] with the sender as counterparty, lock to it.
    const { publicKey } = await bob.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${out.remittance.derivationPrefix} ${out.remittance.derivationSuffix}`,
      counterparty: out.remittance.senderIdentityKey,
      forSelf: true,
    })
    expect(out.lockingScript).toBe(new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex())
    expect(out.remittance.senderIdentityKey).toBe(aliceKey)
    expect(out.satoshis).toBe(500)
    expect(out.outputDescription).toBe('Payment')
    expect(JSON.parse(out.customInstructions)).toEqual({
      derivationPrefix: out.remittance.derivationPrefix,
      derivationSuffix: out.remittance.derivationSuffix,
      payee: bobKey,
    })
  })

  it('does not pay the recipient identity key itself, nor a third party', async () => {
    const out = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1 })
    const plain = new P2PKH().lock(PublicKey.fromString(bobKey).toHash()).toHex()
    expect(out.lockingScript).not.toBe(plain)
    const carol = new ProtoWallet(new PrivateKey(1003))
    const { publicKey } = await carol.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${out.remittance.derivationPrefix} ${out.remittance.derivationSuffix}`,
      counterparty: aliceKey,
      forSelf: true,
    })
    expect(out.lockingScript).not.toBe(new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex())
  })

  it('uses fresh derivation parts each time, or the ones it is given', async () => {
    const a = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1 })
    const b = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1 })
    expect(a.remittance.derivationPrefix).not.toBe(b.remittance.derivationPrefix)
    expect(a.lockingScript).not.toBe(b.lockingScript)
    const c = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1, derivationPrefix: 'p', derivationSuffix: 's' })
    const d = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1, derivationPrefix: 'p', derivationSuffix: 's' })
    expect(c.lockingScript).toBe(d.lockingScript)
  })

  it('asks the wallet for the derived key with the recipient as counterparty, and sets no fee rate', async () => {
    const calls: GetPublicKeyArgs[] = []
    const spy = { getPublicKey: (a: GetPublicKeyArgs) => { calls.push(a); return alice.getPublicKey(a) } }
    const out = await brc29Output(spy, {
      recipientIdentityKey: bobKey.toUpperCase().replace(/^0X/, ''), satoshis: 7, derivationPrefix: 'pre', derivationSuffix: 'suf',
    })
    expect(calls[0]).toEqual({ protocolID: BRC29_PROTOCOL, keyID: 'pre suf', counterparty: bobKey })
    expect(calls[1]).toEqual({ identityKey: true })
    expect(Object.keys(out).sort()).toEqual(['customInstructions', 'lockingScript', 'outputDescription', 'remittance', 'satoshis'])
  })

  const bad: Array<[string, () => Promise<unknown>]> = [
    ['an address as recipient', () => brc29Output(alice, { recipientIdentityKey: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', satoshis: 1 })],
    ['no recipient', () => brc29Output(alice, { recipientIdentityKey: '', satoshis: 1 })],
    ['zero sats', () => brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 0 })],
    ['fractional sats', () => brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1.5 })],
    ['a prefix with a space', () => brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1, derivationPrefix: 'a b' })],
    ['an empty suffix', () => brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: 1, derivationSuffix: '' })],
    ['a wallet without a key', () => brc29Output({ getPublicKey: async () => ({ publicKey: 'nope' }) }, { recipientIdentityKey: bobKey, satoshis: 1 })],
  ]
  for (const [name, fn] of bad) it(`rejects ${name}`, async () => { await expect(fn()).rejects.toThrow(SchemaError) })
})

describe('a whole tip', () => {
  it('is one createAction with the signed record and the BRC-29 output, and no fee rate', async () => {
    const amount = 500
    const record = await signPayload(payment({ app: 'peck.to', targetTxid: T1, recipient: bobKey, amount }), { wallet: alice })
    const pay = await brc29Output(alice, { recipientIdentityKey: bobKey, satoshis: amount })
    const args: CreateActionArgs = {
      description: 'Tip',
      outputs: [
        { lockingScript: record.toHex(), satoshis: 0, outputDescription: 'Tip record' },
        { lockingScript: pay.lockingScript, satoshis: pay.satoshis, outputDescription: pay.outputDescription, customInstructions: pay.customInstructions },
      ],
      options: { randomizeOutputs: false },
    }
    // No fee option anywhere: look at the keys, not the serialized text, whose
    // random hex (keys, signatures) can spell 'fee' by chance.
    const keys: string[] = []
    JSON.stringify(args, (k, v) => (keys.push(k), v))
    expect(keys.filter((k) => /fee/i.test(k))).toEqual([])
    // The record names the amount the second output pays.
    const value = opReturnPushes(args.outputs![0]!.lockingScript!)!.map((b) => Utils.toUTF8(b))
    expect(value[value.indexOf('value') + 1]).toBe(String(args.outputs![1]!.satoshis))
    expect(verifyAip(args.outputs![0]!.lockingScript!)?.valid).toBe(true)
  })
})

describe('identityProfile()', () => {
  const SERIAL = '0123456789abcdef'

  /** peck-overlay-schema src/identity/profile.ts `isValidProfile`, reproduced: the overlay's admission test. */
  async function overlayAdmits(f: Record<string, string>): Promise<boolean> {
    if (f['type']?.toLowerCase() !== 'profile' || f['schema_version'] !== '1') return false
    if (!/^0[23][0-9a-fA-F]{64}$/.test(f['identity'] ?? '') || !f['sig'] || !f['serial']) return false
    const core: Record<string, string> = {}
    for (const k of ['app', 'type', 'schema_version', 'identity', 'display_name', 'avatar', 'bio', 'serial']) {
      if (f[k] !== undefined) core[k] = f[k]
    }
    const preimage = Utils.toArray(JSON.stringify(core, Object.keys(core).sort()), 'utf8')
    try {
      const r = await new ProtoWallet('anyone').verifySignature({
        data: preimage,
        signature: Utils.toArray(f['sig'], 'hex'),
        protocolID: [1, 'profile'],
        keyID: f['serial'],
        counterparty: f['identity'],
      })
      return !!r.valid
    } catch {
      return false
    }
  }

  it('writes the fields in v1 order, leaves out the empty ones, and ends with the signature', async () => {
    const p = await identityProfile({ displayName: 'Ada', avatar: '', bio: 'hi', serial: SERIAL }, { wallet: alice })
    const t = texts(p)
    expect(t.slice(0, 2)).toEqual([PROTO_MAP, 'SET'])
    expect(t.slice(2, -2)).toEqual([
      'app', 'overlay.social', 'type', 'profile', 'schema_version', '1', 'identity', aliceKey,
      'display_name', 'Ada', 'bio', 'hi', 'serial', SERIAL,
    ])
    expect(t.at(-2)).toBe('sig')
    expect(t.at(-1)).toMatch(/^30[0-9a-f]+$/) // DER, hex
    // MAP only: no separator, no AIP section.
    expect(t).not.toContain('|')
    expect(toLockingScript(p).toHex().startsWith('006a')).toBe(true)
  })

  it('round trip: the signature verifies, and the overlay admission test accepts it', async () => {
    const p = await identityProfile({ displayName: 'Ada', avatar: 'https://example.com/a.png', bio: 'First.', serial: SERIAL }, { wallet: alice })
    const check = verifyIdentityProfile(toLockingScript(p))
    expect(check).toMatchObject({ identity: aliceKey, valid: true })
    expect(await overlayAdmits(p.fields as Record<string, string>)).toBe(true)
  })

  it('signs BRC-3 [1, profile] with the serial as key ID and counterparty anyone, over the canonical preimage', async () => {
    let asked: CreateSignatureArgs | undefined
    const spy: IdentityProfileWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: (a) => { asked = a; return alice.createSignature(a) },
    }
    const p = await identityProfile({ displayName: 'Ada', serial: SERIAL }, { wallet: spy, originator: 'peck.to' })
    expect(asked).toMatchObject({ protocolID: [1, 'profile'], keyID: SERIAL, counterparty: 'anyone' })
    expect(asked?.data).toEqual(identityProfilePreimage(p.fields))
    expect(asked?.hashToDirectlySign).toBeUndefined()
    // Sorted keys, no whitespace: the same text the overlay hashes.
    expect(Utils.toUTF8(asked!.data!)).toBe(
      `{"app":"overlay.social","display_name":"Ada","identity":"${aliceKey}","schema_version":"1","serial":"${SERIAL}","type":"profile"}`,
    )
  })

  it('makes the same signature whether the counterparty is left out (as v1 does) or is anyone', async () => {
    const p = await identityProfile({ displayName: 'Ada', serial: SERIAL }, { wallet: alice })
    // v1's call, verbatim: no counterparty.
    const v1Style = await alice.createSignature({ data: identityProfilePreimage(p.fields), protocolID: [1, 'profile'], keyID: SERIAL })
    expect(asHex(v1Style.signature)).toBe(p.fields['sig'])
  })

  it('uses a fresh random serial by default (16 hex characters, as v1)', async () => {
    const a = await identityProfile({ displayName: 'Ada' }, { wallet: alice })
    const b = await identityProfile({ displayName: 'Ada' }, { wallet: alice })
    expect(a.fields['serial']).toMatch(/^[0-9a-f]{16}$/)
    expect(a.fields['serial']).not.toBe(b.fields['serial'])
    expect(verifyIdentityProfile(toLockingScript(a))?.valid).toBe(true)
  })

  it('accepts a hex or Uint8Array signature from the wallet', async () => {
    const hexWallet: IdentityProfileWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: async (a) => ({ signature: asHex((await alice.createSignature(a)).signature) as unknown as number[] }),
    }
    const bytesWallet: IdentityProfileWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: async (a) => ({ signature: Uint8Array.from((await alice.createSignature(a)).signature) as unknown as number[] }),
    }
    for (const w of [hexWallet, bytesWallet]) {
      const p = await identityProfile({ bio: 'x', serial: SERIAL }, { wallet: w })
      expect(verifyIdentityProfile(toLockingScript(p))?.valid).toBe(true)
    }
  })

  it('refuses a signature made with another key than the identity it reported', async () => {
    const wrongCounterparty: IdentityProfileWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: (a) => alice.createSignature({ ...a, counterparty: 'self' }),
    }
    await expect(identityProfile({ displayName: 'Ada' }, { wallet: wrongCounterparty })).rejects.toThrow(/does not verify/)
    const otherIdentity: IdentityProfileWallet = {
      getPublicKey: (a) => bob.getPublicKey(a),
      createSignature: (a) => alice.createSignature(a),
    }
    await expect(identityProfile({ displayName: 'Ada' }, { wallet: otherIdentity })).rejects.toThrow(/does not verify/)
  })

  it('rejects a wallet that returns no identity key', async () => {
    const broken: IdentityProfileWallet = {
      getPublicKey: async () => ({ publicKey: 'nope' }),
      createSignature: (a) => alice.createSignature(a),
    }
    await expect(identityProfile({ displayName: 'Ada' }, { wallet: broken })).rejects.toThrow(SchemaError)
  })

  const bad: Array<[string, () => Promise<unknown>]> = [
    ['no fields at all', () => identityProfile({}, { wallet: alice })],
    ['only empty fields', () => identityProfile({ displayName: '', avatar: '', bio: '' }, { wallet: alice })],
    ['a name that is a separator', () => identityProfile({ displayName: '|' }, { wallet: alice })],
    ['a bio that is a separator', () => identityProfile({ displayName: 'a', bio: '|' }, { wallet: alice })],
    ['an app that is a separator', () => identityProfile({ displayName: 'a', app: '|' }, { wallet: alice })],
    ['a serial that is not hex', () => identityProfile({ displayName: 'a', serial: 'xyz12345' }, { wallet: alice })],
    ['a serial that is too short', () => identityProfile({ displayName: 'a', serial: 'abc' }, { wallet: alice })],
    ['a name that is not a string', () => identityProfile({ displayName: 5 as unknown as string }, { wallet: alice })],
  ]
  for (const [name, fn] of bad) it(`rejects ${name}`, async () => { await expect(fn()).rejects.toThrow(SchemaError) })

  it('keeps a value that merely contains a pipe', async () => {
    const p = await identityProfile({ displayName: 'a|b', bio: '||', serial: SERIAL }, { wallet: alice })
    expect(verifyIdentityProfile(toLockingScript(p))).toMatchObject({ valid: true })
    expect(p.fields['bio']).toBe('||')
  })

  it('writes long values with the right push opcodes', async () => {
    const p = await identityProfile({ bio: 'z'.repeat(70000), serial: SERIAL }, { wallet: alice })
    const script = toLockingScript(p).toHex()
    expect(script).toContain('4e') // OP_PUSHDATA4 for a value over 65,535 bytes
    expect(verifyIdentityProfile(script)).toMatchObject({ valid: true })
    expect(opReturnPushes(script)!.some((b) => b.length === 70000)).toBe(true)
  })
})

describe('verifyIdentityProfile()', () => {
  const SERIAL = '0123456789abcdef'
  const make = async (input: Parameters<typeof identityProfile>[0] = { displayName: 'Ada', bio: 'First programmer.', serial: SERIAL }) =>
    toLockingScript(await identityProfile(input, { wallet: alice })).toHex()

  it('detects a tampered field, a swapped identity and a changed schema version', async () => {
    const hex = await make()
    const swap = (from: string, to: string) => hex.replace(asHex(Utils.toArray(from, 'utf8')), asHex(Utils.toArray(to, 'utf8')))
    expect(verifyIdentityProfile(hex)?.valid).toBe(true)
    expect(verifyIdentityProfile(swap('First programmer.', 'First programmer!'))?.valid).toBe(false)
    expect(verifyIdentityProfile(swap(aliceKey, bobKey))?.valid).toBe(false)
    // schema_version "1" -> "2": 0131 -> 0132 (right after the field name).
    const v2 = hex.replace(asHex(Utils.toArray('schema_version', 'utf8')) + '0131', asHex(Utils.toArray('schema_version', 'utf8')) + '0132')
    expect(v2).not.toBe(hex)
    expect(verifyIdentityProfile(v2)?.valid).toBe(false)
  })

  it('does not accept a signature made for another serial', async () => {
    const hex = await make()
    const other = hex.replace(asHex(Utils.toArray(SERIAL, 'utf8')), asHex(Utils.toArray('fedcba9876543210', 'utf8')))
    expect(verifyIdentityProfile(other)?.valid).toBe(false)
  })

  it('returns null for scripts that are not identity profiles', async () => {
    expect(verifyIdentityProfile('76a914' + '00'.repeat(20) + '88ac')).toBeNull()
    expect(verifyIdentityProfile(toLockingScript(post({ app: 'x', text: 'hello' })))).toBeNull()
    // The older profile() record has no identity and no sig.
    expect(verifyIdentityProfile(toLockingScript(profile({ app: 'x', displayName: 'Ada' })))).toBeNull()
    expect(verifyIdentityProfile(await signPayload(profile({ app: 'x', displayName: 'Ada' }), { wallet: alice }))).toBeNull()
  })
})

describe('no fee rate', () => {
  it('appears nowhere in the schema module', () => {
    const dir = resolve(import.meta.dirname, '../src/schema')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      expect(src, f).not.toMatch(/feeUnit|feeModel|feeRate|satPerKb|sat\/kb/i)
    }
  })
})
