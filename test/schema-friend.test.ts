import { PrivateKey, ProtoWallet, Utils, type CreateSignatureArgs } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  FRIEND_PROTOCOL,
  PROTO_MAP,
  SchemaError,
  friend,
  friendPreimage,
  opReturnPushes,
  post,
  toLockingScript,
  unfriend,
  verifyFriend,
  type FriendWallet,
  type SchemaPayload,
} from '../src/schema/index.js'

const texts = (p: SchemaPayload) => p.pushes.map((b) => Utils.toUTF8([...b]))
const asHex = (bytes: readonly number[]) => Utils.toHex([...bytes])

const alice = new ProtoWallet(new PrivateKey(2001))
const bob = new ProtoWallet(new PrivateKey(2002))
const aliceKey = (await alice.getPublicKey({ identityKey: true })).publicKey
const bobKey = (await bob.getPublicKey({ identityKey: true })).publicKey
const SERIAL = '0123456789abcdef'

/** A record script from its fields, in record order (for forging and for the cases a builder refuses). */
const scriptFrom = (fields: Readonly<Record<string, string>>) =>
  toLockingScript({
    pushes: [PROTO_MAP, 'SET', ...Object.entries(fields).flat()].map((x) => Utils.toArray(x, 'utf8')),
  }).toHex()

/** peck-overlay-schema src/identity/friend.ts `isValidFriendRecord`, reproduced: the overlay's admission test. */
async function overlayAdmits(f: Record<string, string>): Promise<boolean> {
  const t = f['type']?.toLowerCase()
  if (t !== 'friend' && t !== 'unfriend') return false
  if (f['schema_version'] !== '1') return false
  const re = /^0[23][0-9a-fA-F]{64}$/
  if (!re.test(f['identity'] || '') || !re.test(f['peer'] || '')) return false
  if (f['identity']!.toLowerCase() === f['peer']!.toLowerCase()) return false
  if (!f['sig'] || !f['serial']) return false
  const core: Record<string, string> = {}
  for (const k of ['app', 'type', 'schema_version', 'identity', 'peer', 'serial']) {
    if (f[k] !== undefined) core[k] = f[k]!
  }
  const preimage = Utils.toArray(JSON.stringify(core, Object.keys(core).sort()), 'utf8')
  try {
    const hex = f['sig']!
    const sig: number[] = []
    for (let i = 0; i < hex.length; i += 2) sig.push(parseInt(hex.slice(i, i + 2), 16))
    const r = await new ProtoWallet('anyone').verifySignature({
      data: preimage,
      signature: sig,
      protocolID: [1, 'friend'],
      keyID: f['serial']!,
      counterparty: f['identity']!,
    })
    return !!r.valid
  } catch {
    return false
  }
}

describe('friend()', () => {
  it('writes the fields in v1 order and ends with the signature, MAP only', async () => {
    const r = await friend({ peer: bobKey, serial: SERIAL }, { wallet: alice })
    const t = texts(r)
    expect(t.slice(0, 2)).toEqual([PROTO_MAP, 'SET'])
    expect(t.slice(2, -2)).toEqual([
      'app', 'overlay.social', 'type', 'friend', 'schema_version', '1',
      'identity', aliceKey, 'peer', bobKey, 'serial', SERIAL,
    ])
    expect(t.at(-2)).toBe('sig')
    expect(t.at(-1)).toMatch(/^30[0-9a-f]+$/)
    expect(t).not.toContain('|')
    expect(toLockingScript(r).toHex().startsWith('006a')).toBe(true)
  })

  it('round trip: the signature verifies, and the overlay admission test accepts it', async () => {
    const r = await friend({ peer: bobKey }, { wallet: alice })
    expect(verifyFriend(toLockingScript(r))).toMatchObject({ type: 'friend', identity: aliceKey, peer: bobKey, valid: true })
    expect(await overlayAdmits(r.fields as Record<string, string>)).toBe(true)
  })

  it('signs BRC-3 [1, friend] with the serial as key ID and counterparty anyone, over the canonical preimage', async () => {
    let asked: CreateSignatureArgs | undefined
    let originator: string | undefined
    const spy: FriendWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: (a, o) => { asked = a; originator = o; return alice.createSignature(a) },
    }
    const r = await friend({ peer: bobKey, serial: SERIAL }, { wallet: spy, originator: 'peck.to' })
    expect(FRIEND_PROTOCOL).toEqual([1, 'friend'])
    expect(asked).toMatchObject({ protocolID: [1, 'friend'], keyID: SERIAL, counterparty: 'anyone' })
    expect(originator).toBe('peck.to')
    expect(asked?.data).toEqual(friendPreimage(r.fields))
    expect(asked?.hashToDirectlySign).toBeUndefined()
    // Sorted keys, no whitespace: the same text the overlay hashes.
    expect(Utils.toUTF8(asked!.data!)).toBe(
      `{"app":"overlay.social","identity":"${aliceKey}","peer":"${bobKey}","schema_version":"1","serial":"${SERIAL}","type":"friend"}`,
    )
  })

  it('makes the same signature whether the counterparty is left out (as v1 does) or is anyone', async () => {
    const r = await friend({ peer: bobKey, serial: SERIAL }, { wallet: alice })
    const v1Style = await alice.createSignature({ data: friendPreimage(r.fields), protocolID: [1, 'friend'], keyID: SERIAL })
    expect(asHex(v1Style.signature)).toBe(r.fields['sig'])
  })

  it('takes the peer key in any case and writes it lowercase', async () => {
    const r = await friend({ peer: ` ${bobKey.toUpperCase()} `, serial: SERIAL }, { wallet: alice })
    expect(r.fields['peer']).toBe(bobKey)
    expect(await overlayAdmits(r.fields as Record<string, string>)).toBe(true)
  })

  it('uses a fresh random serial by default (16 hex characters, as v1)', async () => {
    const a = await friend({ peer: bobKey }, { wallet: alice })
    const b = await friend({ peer: bobKey }, { wallet: alice })
    expect(a.fields['serial']).toMatch(/^[0-9a-f]{16}$/)
    expect(a.fields['serial']).not.toBe(b.fields['serial'])
    expect(verifyFriend(toLockingScript(a))?.valid).toBe(true)
  })

  it('accepts a hex or Uint8Array signature from the wallet', async () => {
    const hexWallet: FriendWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: async (a) => ({ signature: asHex((await alice.createSignature(a)).signature) as unknown as number[] }),
    }
    const bytesWallet: FriendWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: async (a) => ({ signature: Uint8Array.from((await alice.createSignature(a)).signature) as unknown as number[] }),
    }
    for (const w of [hexWallet, bytesWallet]) {
      const r = await friend({ peer: bobKey, serial: SERIAL }, { wallet: w })
      expect(verifyFriend(toLockingScript(r))?.valid).toBe(true)
    }
  })

  it('refuses a signature made with another key than the identity it reported', async () => {
    const wrongCounterparty: FriendWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: (a) => alice.createSignature({ ...a, counterparty: 'self' }),
    }
    await expect(friend({ peer: bobKey }, { wallet: wrongCounterparty })).rejects.toThrow(/does not verify/)
    const otherIdentity: FriendWallet = {
      getPublicKey: (a) => bob.getPublicKey(a),
      createSignature: (a) => alice.createSignature(a),
    }
    await expect(friend({ peer: aliceKey }, { wallet: otherIdentity })).rejects.toThrow(/does not verify/)
  })

  it('rejects a wallet that returns no identity key', async () => {
    const broken: FriendWallet = {
      getPublicKey: async () => ({ publicKey: 'nope' }),
      createSignature: (a) => alice.createSignature(a),
    }
    await expect(friend({ peer: bobKey }, { wallet: broken })).rejects.toThrow(SchemaError)
  })

  it('does not ask the wallet to sign anything when the input is bad', async () => {
    let signed = 0
    const counting: FriendWallet = {
      getPublicKey: (a) => alice.getPublicKey(a),
      createSignature: (a) => { signed++; return alice.createSignature(a) },
    }
    await expect(friend({ peer: 'nope' }, { wallet: counting })).rejects.toThrow(SchemaError)
    await expect(friend({ peer: aliceKey }, { wallet: counting })).rejects.toThrow(/two different keys/)
    expect(signed).toBe(0)
  })

  const bad: Array<[string, () => Promise<unknown>]> = [
    ['no peer', () => friend({ peer: '' }, { wallet: alice })],
    ['a peer that is a P2PKH address', () => friend({ peer: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }, { wallet: alice })],
    ['an uncompressed peer key', () => friend({ peer: '04' + 'a'.repeat(128) }, { wallet: alice })],
    ['a peer key with the wrong prefix', () => friend({ peer: '05' + bobKey.slice(2) }, { wallet: alice })],
    ['a peer that is not a string', () => friend({ peer: 5 as unknown as string }, { wallet: alice })],
    ['the wallet as its own peer', () => friend({ peer: aliceKey }, { wallet: alice })],
    ['an app that is a separator', () => friend({ peer: bobKey, app: '|' }, { wallet: alice })],
    ['a serial that is not hex', () => friend({ peer: bobKey, serial: 'xyz12345' }, { wallet: alice })],
    ['a serial that is too short', () => friend({ peer: bobKey, serial: 'abc' }, { wallet: alice })],
  ]
  for (const [name, fn] of bad) it(`rejects ${name}`, async () => { await expect(fn()).rejects.toThrow(SchemaError) })
})

describe('unfriend()', () => {
  it('is the same record with type unfriend, and the overlay admits it', async () => {
    const f = await friend({ peer: bobKey, serial: SERIAL }, { wallet: alice })
    const u = await unfriend({ peer: bobKey, serial: SERIAL }, { wallet: alice })
    expect(u.fields['type']).toBe('unfriend')
    expect({ ...u.fields, type: 'friend', sig: '' }).toEqual({ ...f.fields, sig: '' })
    // The type is signed, so the signature differs.
    expect(u.fields['sig']).not.toBe(f.fields['sig'])
    expect(verifyFriend(toLockingScript(u))).toMatchObject({ type: 'unfriend', identity: aliceKey, peer: bobKey, valid: true })
    expect(await overlayAdmits(u.fields as Record<string, string>)).toBe(true)
  })

  it('a friend signature cannot be replayed as an unfriend, or the other way round', async () => {
    const f = await friend({ peer: bobKey, serial: SERIAL }, { wallet: alice })
    expect(verifyFriend(scriptFrom(f.fields))?.valid).toBe(true)
    expect(verifyFriend(scriptFrom({ ...f.fields, type: 'unfriend' }))?.valid).toBe(false)
    const u = await unfriend({ peer: bobKey, serial: SERIAL }, { wallet: alice })
    expect(verifyFriend(scriptFrom({ ...u.fields, type: 'friend' }))?.valid).toBe(false)
  })
})

describe('verifyFriend()', () => {
  const make = async () => toLockingScript(await friend({ peer: bobKey, serial: SERIAL }, { wallet: alice })).toHex()

  it('detects a tampered peer, a swapped sender and another serial', async () => {
    const hex = await make()
    const swap = (from: string, to: string) => hex.replace(asHex(Utils.toArray(from, 'utf8')), asHex(Utils.toArray(to, 'utf8')))
    expect(verifyFriend(hex)?.valid).toBe(true)
    const carol = (await new ProtoWallet(new PrivateKey(2003)).getPublicKey({ identityKey: true })).publicKey
    expect(verifyFriend(swap(bobKey, carol))?.valid).toBe(false)
    // Someone else's side cannot be declared: the sender swapped to bob does not verify.
    expect(verifyFriend(swap(aliceKey, bobKey))?.valid).toBe(false)
    expect(verifyFriend(swap(SERIAL, 'fedcba9876543210'))?.valid).toBe(false)
  })

  it('does not accept a record with a changed schema version', async () => {
    const hex = await make()
    const name = asHex(Utils.toArray('schema_version', 'utf8'))
    const v2 = hex.replace(name + '0131', name + '0132')
    expect(v2).not.toBe(hex)
    expect(verifyFriend(v2)?.valid).toBe(false)
  })

  it('does not accept a record from a key to itself', async () => {
    // A signature by alice over alice -> alice would verify, but the overlay drops it.
    const fields = { app: 'overlay.social', type: 'friend', schema_version: '1', identity: aliceKey, peer: aliceKey, serial: SERIAL }
    const { signature } = await alice.createSignature({ data: friendPreimage(fields), protocolID: [1, 'friend'], keyID: SERIAL })
    expect(verifyFriend(scriptFrom({ ...fields, sig: asHex(signature) }))).toMatchObject({ valid: false })
  })

  it('returns null for scripts that are not friend records', async () => {
    expect(verifyFriend('76a914' + '00'.repeat(20) + '88ac')).toBeNull()
    expect(verifyFriend(toLockingScript(post({ app: 'x', text: 'hello' })))).toBeNull()
    // The older Bitcoin Schema friend (bapID + publicKey, no identity) is not a light record.
    const legacy = toLockingScript({
      pushes: [PROTO_MAP, 'SET', 'app', 'x', 'type', 'friend', 'bapID', 'abc', 'publicKey', bobKey].map((s) => Utils.toArray(s, 'utf8')),
    })
    expect(verifyFriend(legacy)).toBeNull()
    expect(opReturnPushes(legacy)).not.toBeNull()
  })
})
