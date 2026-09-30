// Envelopes: round trips through two test wallets, and compatibility with
// envelopes produced by peck.to's deployed DM client (the fixture).
import { PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  DM_KEY_ID,
  DM_PROTOCOL,
  DmError,
  buildEnvelope,
  decryptText,
  encryptText,
  envelopeMessage,
  envelopePeer,
  identityKeyOf,
  openEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '../src/dm/index.js'
import { PIPE, PROTO_B, PROTO_MAP, opReturnPushes, signPayload, verifyAip } from '../src/schema/index.js'
import { ALICE, BOB, alice, bob, fixture } from './helpers/dm-fakes.js'

const utf8 = (s: string) => Utils.toArray(s, 'utf8')

describe('fixture identities', () => {
  it('derive from the seeds recorded in the fixture', async () => {
    expect(await identityKeyOf(alice)).toBe(ALICE)
    expect(await identityKeyOf(bob)).toBe(BOB)
  })
})

describe('buildEnvelope / openEnvelope', () => {
  it('round-trips between sender and recipient, and back to the sender', async () => {
    const text = 'Hei! Æøå 🐦 "quoted" \\ and a | pipe'
    const env = await buildEnvelope(alice, { to: BOB, text, sentAt: 1_790_000_000_000 })
    expect(env).toMatchObject({ v: 1, from: ALICE, to: BOB, sentAt: 1_790_000_000_000 })
    expect(await openEnvelope(bob, env)).toBe(text) // counterparty = sender
    expect(await openEnvelope(alice, env)).toBe(text) // counterparty = recipient
    expect(await decryptText(bob, env.ciphertext, ALICE)).toBe(text)
  })

  it('serializes with the field order peck.to writes, extras after sentAt', async () => {
    const env = await buildEnvelope(alice, { to: BOB, text: 'x', sentAt: 5, extra: { group_id: 'g1', epoch: 2 } })
    expect(Object.keys(env)).toEqual(['v', 'from', 'to', 'ciphertext', 'sentAt', 'group_id', 'epoch'])
    expect(serializeEnvelope(env)).toBe(
      `{"v":1,"from":"${ALICE}","to":"${BOB}","ciphertext":"${env.ciphertext}","sentAt":5,"group_id":"g1","epoch":2}`,
    )
  })

  it('refuses extras that would overwrite envelope fields', async () => {
    await expect(buildEnvelope(alice, { to: BOB, text: 'x', extra: { from: BOB } })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('refuses a recipient that is not an identity key', async () => {
    await expect(buildEnvelope(alice, { to: 'bob', text: 'x' })).rejects.toBeInstanceOf(DmError)
  })

  it('does not open for a third party', async () => {
    const carol = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface
    const env = await buildEnvelope(alice, { to: BOB, text: 'secret' })
    await expect(openEnvelope(carol, env)).rejects.toMatchObject({ code: 'invalid_envelope' })
    await expect(decryptText(bob, env.ciphertext, BOB)).rejects.toMatchObject({ code: 'invalid_envelope' })
  })

  it('asks the wallet with [2, "peck dm"], key ID "1", the counterparty and the originator', async () => {
    const calls: Array<{ method: string; args: Record<string, unknown>; originator?: string }> = []
    const spy = {
      getPublicKey: (a: never, o?: string) => (calls.push({ method: 'getPublicKey', args: a, originator: o }), alice.getPublicKey(a, o)),
      encrypt: (a: never, o?: string) => (calls.push({ method: 'encrypt', args: a, originator: o }), alice.encrypt(a, o)),
      decrypt: (a: never, o?: string) => (calls.push({ method: 'decrypt', args: a, originator: o }), alice.decrypt(a, o)),
    } as unknown as WalletInterface
    const env = await buildEnvelope(spy, { to: BOB, text: 'hi' }, { originator: 'peck.to' })
    await openEnvelope(spy, env, { originator: 'peck.to' })
    expect(calls.map((c) => c.method)).toEqual(['getPublicKey', 'encrypt', 'getPublicKey', 'decrypt'])
    expect(calls[0]!.args).toEqual({ identityKey: true })
    for (const c of calls.slice(1).filter((c) => c.method !== 'getPublicKey')) {
      expect(c.args).toMatchObject({ protocolID: DM_PROTOCOL, keyID: DM_KEY_ID, counterparty: BOB })
    }
    expect(DM_PROTOCOL).toEqual([2, 'peck dm'])
    expect(calls.every((c) => c.originator === 'peck.to')).toBe(true)
  })

  it('accepts a Uint8Array from the wallet', async () => {
    const u8 = {
      encrypt: async (a: never) => ({ ciphertext: Uint8Array.from((await alice.encrypt(a)).ciphertext) }),
      decrypt: async (a: never) => ({ plaintext: Uint8Array.from((await bob.decrypt(a)).plaintext) }),
    } as unknown as WalletInterface
    const b64 = await encryptText(u8, 'bytes', BOB)
    expect(await decryptText(u8, b64, ALICE)).toBe('bytes')
  })
})

describe('compatibility with the deployed peck.to client', () => {
  it('opens its envelope as the recipient and as the sender', async () => {
    const env = parseEnvelope(fixture.envelope)!
    expect(env).not.toBeNull()
    expect(await openEnvelope(bob, env)).toBe(fixture.text)
    expect(await openEnvelope(alice, env)).toBe(fixture.ownOpen)
  })

  it('opens its group envelope and keeps the extra fields', async () => {
    const env = parseEnvelope(fixture.groupEnvelope)!
    expect(env.group_id).toBe('g1')
    expect(env.epoch).toBe(2)
    expect(JSON.parse(await openEnvelope(bob, env))).toEqual({ type: 'post', group_id: 'g1', text: 'hi group' })
  })

  it('writes envelopes the same shape and size, byte for byte apart from the random ciphertext', async () => {
    const theirs = fixture.envelope
    const ours = await buildEnvelope(alice, { to: BOB, text: fixture.text, sentAt: theirs.sentAt })
    expect(Object.keys(ours)).toEqual(Object.keys(theirs))
    expect(Utils.toArray(ours.ciphertext, 'base64')).toHaveLength(Utils.toArray(theirs.ciphertext, 'base64').length)
    expect(serializeEnvelope({ ...ours, ciphertext: theirs.ciphertext })).toBe(JSON.stringify(theirs))
    // and the recipient's side of the deployed client reads ours the same way it reads its own
    expect(await decryptText(bob, ours.ciphertext, ALICE)).toBe(fixture.text)
  })

  it('agrees on the envelope key with the deployed client (same BRC-42 derivation)', async () => {
    // The deployed client's ciphertext decrypts under our derivation, and ours under the
    // raw wallet call the deployed client makes (protocol, key ID, counterparty).
    const raw = await bob.decrypt({ ciphertext: Utils.toArray(fixture.envelope.ciphertext, 'base64'), protocolID: [2, 'peck dm'], keyID: '1', counterparty: ALICE })
    expect(Utils.toUTF8(raw.plaintext)).toBe(fixture.text)
    const ours = await encryptText(alice, 'ours', BOB)
    const back = await bob.decrypt({ ciphertext: Utils.toArray(ours, 'base64'), protocolID: [2, 'peck dm'], keyID: '1', counterparty: ALICE })
    expect(Utils.toUTF8(back.plaintext)).toBe('ours')
  })
})

describe('parseEnvelope', () => {
  it('reads objects and JSON strings, and rejects everything else', () => {
    expect(parseEnvelope(JSON.stringify(fixture.envelope))).toEqual(fixture.envelope)
    expect(parseEnvelope({ v: 1, from: ALICE, to: BOB, ciphertext: 'AA==' })).not.toBeNull() // no sentAt: old envelopes
    for (const bad of [null, 'nope', '[]', 42, { v: '1', from: ALICE, to: BOB, ciphertext: 'x' }, { v: 1, from: ALICE, to: BOB }, { v: 1, from: ALICE, to: BOB, ciphertext: 'x', sentAt: 'now' }, { encryptedMessage: 'x' }]) {
      expect(parseEnvelope(bad)).toBeNull()
    }
  })

  it('names the other party', () => {
    expect(envelopePeer(fixture.envelope, ALICE)).toBe(BOB)
    expect(envelopePeer(fixture.envelope, BOB.toUpperCase())).toBe(ALICE)
  })
})

describe('envelopeMessage (the on-chain copy)', () => {
  it('lays the envelope out as peck.to writes a DM on-chain', () => {
    const p = envelopeMessage(fixture.envelope)
    const expected = [
      PROTO_B, JSON.stringify(fixture.envelope), 'text/plain', 'UTF-8', PIPE,
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'message', 'context', 'bapID', 'bapID', BOB,
    ].map((x) => (x === PIPE ? [0x7c] : utf8(x)))
    expect(p.pushes).toEqual(expected)
  })

  it('signs with AIP like any payload, and the B content reads back as the envelope', async () => {
    const script = await signPayload(envelopeMessage(fixture.envelope, { app: 'peck.to' }), { wallet: alice })
    expect(verifyAip(script)).toMatchObject({ algorithm: 'BRC77', valid: true })
    const pushes = opReturnPushes(script)!
    expect(parseEnvelope(Utils.toUTF8(pushes[1]!))).toEqual(fixture.envelope)
  })

  it('refuses a non-envelope', () => {
    expect(() => envelopeMessage({ v: 1 } as never)).toThrow(DmError)
  })
})
