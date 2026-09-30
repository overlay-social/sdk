import { Hash, PrivateKey, ProtoWallet, Utils, type CreateSignatureArgs, type GetPublicKeyArgs } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  PROTO_AIP,
  PROTO_B,
  PROTO_MAP,
  SchemaError,
  aipPreimage,
  follow,
  hashtags,
  like,
  message,
  opReturnPushes,
  payload,
  post,
  profile,
  quote,
  reply,
  repost,
  signPayload,
  tag,
  toLockingScript,
  unfollow,
  unlike,
  verifyAip,
  type AipWallet,
  type SchemaPayload,
} from '../src/schema/index.js'

const T1 = 'a'.repeat(64)
const T2 = 'B'.repeat(64)

/** The payload's pushes as text, for layout assertions. */
const texts = (p: SchemaPayload) => p.pushes.map((b) => Utils.toUTF8([...b]))

describe('builders: layouts', () => {
  it('post: B text section, MAP SET with content, channel, geo, mention, tags', () => {
    const p = post({
      app: 'peck.to',
      text: 'hello #bsv',
      channel: 'dev',
      geo: { lat: 59.91, lng: 10.75 },
      mentions: ['1Alice', '1Bob', '1Alice'],
      tags: ['bsv', ' bsv ', '', 'social'],
    })
    expect(texts(p)).toEqual([
      PROTO_B, 'hello #bsv', 'text/markdown', 'utf-8', 'post.md', '|',
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'post', 'content', 'hello #bsv',
      'context', 'channel', 'channel', 'dev',
      'lat', '59.91', 'lng', '10.75',
      'mention', '1Alice,1Bob',
      '|', PROTO_MAP, 'ADD', 'tags', 'bsv', 'social',
    ])
  })

  it('post with media: binary B section, text as the caption', () => {
    const data = new Uint8Array([0xff, 0xd8, 0x00, 0x7c, 0x01])
    const p = post({ app: 'peck.to', text: 'caption', media: { data, mediaType: 'image/jpeg', filename: 'a.jpg' } })
    expect(p.pushes[1]).toEqual([0xff, 0xd8, 0x00, 0x7c, 0x01])
    expect(texts(p).slice(2)).toEqual([
      'image/jpeg', 'binary', 'a.jpg', '|', PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'post', 'content', 'caption',
    ])
    const bare = post({ app: 'peck.to', media: { data, mediaType: 'image/png', filename: 'b.png' } })
    // No caption: no MAP content field.
    expect(texts(bare).slice(-6)).toEqual([PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'post'])
  })

  it('reply: context tx, tx and reply point at the parent (lowercased)', () => {
    expect(texts(reply({ app: 'peck.to', text: 'yes', parentTxid: T2 })).slice(6)).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'post', 'content', 'yes',
      'context', 'tx', 'tx', T2.toLowerCase(), 'reply', T2.toLowerCase(),
    ])
  })

  it('quote: type repost with own content and tx', () => {
    expect(texts(quote({ app: 'peck.to', text: 'look', targetTxid: T1 })).slice(6)).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'repost', 'content', 'look', 'tx', T1,
    ])
  })

  it('repost, like, unlike: MAP only', () => {
    expect(texts(repost({ app: 'peck.to', targetTxid: T1 }))).toEqual([PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'repost', 'tx', T1])
    expect(texts(like({ app: 'peck.to', targetTxid: T1 }))).toEqual([PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'like', 'tx', T1])
    expect(texts(unlike({ app: 'peck.to', targetTxid: T1 }))).toEqual([PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'unlike', 'tx', T1])
  })

  it('follow and unfollow: address, with an optional handle first', () => {
    expect(texts(follow({ app: 'peck.to', address: '1Target', handle: '@ada' }))).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'follow', 'handle', 'ada', 'address', '1Target',
    ])
    expect(texts(unfollow({ app: 'peck.to', address: '1Target' }))).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'unfollow', 'address', '1Target',
    ])
  })

  it('tag: lowercased comma-joined tags plus optional labels', () => {
    expect(texts(tag({ app: 'peck.agents', targetTxid: T1, tags: ['BSV', 'bsv', 'News'], lang: 'EN' }))).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.agents', 'type', 'tag', 'context', 'tx', 'tx', T1, 'tags', 'bsv,news', 'lang', 'en',
    ])
  })

  it('message: text/plain B section, then channel or recipient routing', () => {
    const head = [PROTO_B, 'hi', 'text/plain', 'utf-8', '|', PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'message']
    expect(texts(message({ app: 'peck.to', text: 'hi' }))).toEqual(head)
    expect(texts(message({ app: 'peck.to', text: 'hi', channel: 'dev' }))).toEqual([...head, 'context', 'channel', 'channel', 'dev'])
    expect(texts(message({ app: 'peck.to', text: 'hi', recipient: '02abc' }))).toEqual([...head, 'context', 'bapID', 'bapID', '02abc'])
  })

  it('profile: display_name, then only the fields that are set', () => {
    expect(texts(profile({ app: 'peck.to', displayName: 'Ada', bio: '', avatar: 'uhrp://x', certRef: T1 }))).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'profile', 'display_name', 'Ada', 'avatar', 'uhrp://x', 'cert_ref', T1,
    ])
  })

  it('hashtags() finds tags the way the web client does', () => {
    expect(hashtags('gm #BSV and #æøå_1, again #BSV #')).toEqual(['BSV', 'æøå_1'])
  })
})

describe('builders: validation', () => {
  const bad: Array<[string, () => unknown]> = [
    ['missing app', () => like({ app: '', targetTxid: T1 })],
    ['bad txid', () => like({ app: 'x', targetTxid: 'abc' })],
    ['post without text or media', () => post({ app: 'x' })],
    ['empty media', () => post({ app: 'x', media: { data: [], mediaType: 'image/png', filename: 'a.png' } })],
    ['a value that is a separator', () => post({ app: 'x', text: '|' })],
    ['a separator tag', () => post({ app: 'x', text: 'hi', tags: ['|'] })],
    ['geo out of range', () => post({ app: 'x', text: 'hi', geo: { lat: 91, lng: 0 } })],
    ['geo not a number', () => post({ app: 'x', text: 'hi', geo: { lat: NaN, lng: 0 } })],
    ['channel and recipient', () => message({ app: 'x', text: 'hi', channel: 'a', recipient: 'b' })],
    ['tag without tags', () => tag({ app: 'x', targetTxid: T1, tags: [' '] })],
    ['tag with a comma', () => tag({ app: 'x', targetTxid: T1, tags: ['a,b'] })],
    ['follow without address', () => follow({ app: 'x', address: '' })],
    ['empty push', () => payload(['a', ''])],
  ]
  for (const [name, fn] of bad) {
    it(`rejects ${name}`, () => expect(fn).toThrow(SchemaError))
  }

  it('never writes an empty push', () => {
    const all = [
      post({ app: 'x', text: 'a', tags: [''], mentions: [''], channel: '' }),
      reply({ app: 'x', text: 'a', parentTxid: T1 }),
      profile({ app: 'x', displayName: 'a', avatar: '', bio: '' }),
      follow({ app: 'x', address: 'a', handle: '' }),
    ]
    for (const p of all) for (const push of p.pushes) expect(push.length).toBeGreaterThan(0)
  })
})

describe('script encoding', () => {
  it('writes OP_FALSE OP_RETURN, the separator as 01 7c, and minimal pushes', () => {
    const p = payload(['|', 'a'.repeat(75), 'b'.repeat(76), 'c'.repeat(256)])
    const hex = toLockingScript(p).toHex()
    expect(hex.startsWith('006a017c')).toBe(true)
    expect(hex).toContain(`4b${'61'.repeat(75)}`) // 75 bytes: direct length
    expect(hex).toContain(`4c4c${'62'.repeat(76)}`) // 76 bytes: OP_PUSHDATA1
    expect(hex).toContain(`4d0001${'63'.repeat(256)}`) // 256 bytes: OP_PUSHDATA2
    expect(opReturnPushes(hex)).toEqual(p.pushes)
  })

  it('reads pushes back and skips non-push opcodes', () => {
    expect(opReturnPushes('76a914' + '00'.repeat(20) + '88ac')).toBeNull()
    expect(opReturnPushes('006a0161007c0162')).toEqual([[0x61], [0x62]])
  })
})

describe('AIP signing through a BRC-100 wallet', () => {
  const key = PrivateKey.fromRandom()
  const wallet = new ProtoWallet(key)

  it('signs with the default derivation and verifies', async () => {
    const script = await signPayload(post({ app: 'peck.to', text: 'signed' }), { wallet })
    const check = verifyAip(script)
    expect(check).toMatchObject({ algorithm: 'BRC77', valid: true })
    const { publicKey } = await wallet.getPublicKey({ protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })
    expect(check?.signer).toBe(publicKey)
    // The signing key is the derived key, not the identity key.
    expect(publicKey).not.toBe(key.toPublicKey().toString())
  })

  it('ends with | PROTO_AIP BRC77 <key> <base64 DER>', async () => {
    const script = await signPayload(like({ app: 'peck.to', targetTxid: T1 }), { wallet })
    const tail = opReturnPushes(script)!.slice(-5).map((b) => Utils.toUTF8(b))
    expect(tail.slice(0, 3)).toEqual(['|', PROTO_AIP, 'BRC77'])
    expect(tail[3]).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(Utils.toArray(tail[4]!, 'base64')[0]).toBe(0x30) // DER sequence
  })

  it('uses the derivation it is given, on both calls', async () => {
    const calls: Array<GetPublicKeyArgs | CreateSignatureArgs> = []
    const spy: AipWallet = {
      getPublicKey: (a) => { calls.push(a); return wallet.getPublicKey(a) },
      createSignature: (a) => { calls.push(a); return wallet.createSignature(a) },
    }
    const script = await signPayload(like({ app: 'x', targetTxid: T1 }), {
      wallet: spy, protocolID: [2, 'peck bio profile'], keyID: '7', counterparty: 'self',
    })
    expect(verifyAip(script)?.valid).toBe(true)
    for (const c of calls) expect(c).toMatchObject({ protocolID: [2, 'peck bio profile'], keyID: '7', counterparty: 'self' })
  })

  it('covers raw media bytes in the preimage, not a text rendering of them', async () => {
    const data = new Uint8Array([0, 1, 2, 0x7c, 255])
    const p = post({ app: 'x', media: { data, mediaType: 'image/png', filename: 'a.png' } })
    const script = await signPayload(p, { wallet })
    const signer = verifyAip(script)!.signer
    const pre = aipPreimage(p, signer)
    expect(pre.slice(PROTO_B.length, PROTO_B.length + 5)).toEqual([0, 1, 2, 0x7c, 255])
    expect(verifyAip(script)?.valid).toBe(true)
  })

  it('refuses a signature made with a different key than the one reported', async () => {
    // The classic mismatch: getPublicKey defaults to counterparty 'self',
    // createSignature to 'anyone'. A wallet that drops the counterparty signs
    // with another key; the builder must not embed that signature.
    const mismatched: AipWallet = {
      getPublicKey: (a) => wallet.getPublicKey(a),
      createSignature: ({ counterparty: _ignored, ...a }) => wallet.createSignature({ ...a, counterparty: 'anyone' }),
    }
    await expect(signPayload(like({ app: 'x', targetTxid: T1 }), { wallet: mismatched })).rejects.toThrow(/does not verify/)
  })

  it('accepts a hex or Uint8Array signature from the wallet', async () => {
    const asHex: AipWallet = {
      getPublicKey: (a) => wallet.getPublicKey(a),
      createSignature: async (a) => ({ signature: Utils.toHex((await wallet.createSignature(a)).signature) as unknown as number[] }),
    }
    const asBytes: AipWallet = {
      getPublicKey: (a) => wallet.getPublicKey(a),
      createSignature: async (a) => ({ signature: Uint8Array.from((await wallet.createSignature(a)).signature) as unknown as number[] }),
    }
    for (const w of [asHex, asBytes]) {
      expect(verifyAip(await signPayload(like({ app: 'x', targetTxid: T1 }), { wallet: w }))?.valid).toBe(true)
    }
  })

  it('rejects a wallet that returns no usable public key', async () => {
    const broken: AipWallet = {
      getPublicKey: async () => ({ publicKey: 'nope' }),
      createSignature: (a) => wallet.createSignature(a),
    }
    await expect(signPayload(like({ app: 'x', targetTxid: T1 }), { wallet: broken })).rejects.toThrow(SchemaError)
  })

  it('detects tampering and unsigned scripts', async () => {
    const script = await signPayload(post({ app: 'x', text: 'original' }), { wallet })
    const tampered = script.toHex().replace(Utils.toHex(Utils.toArray('original', 'utf8')), Utils.toHex(Utils.toArray('0riginal', 'utf8')))
    expect(verifyAip(tampered)?.valid).toBe(false)
    expect(verifyAip(toLockingScript(post({ app: 'x', text: 'unsigned' })))).toBeNull()
  })

  it('signs the digest of the full preimage', async () => {
    let asked: number[] | undefined
    const spy: AipWallet = {
      getPublicKey: (a) => wallet.getPublicKey(a),
      createSignature: (a) => { asked = a.hashToDirectlySign; return wallet.createSignature(a) },
    }
    const p = like({ app: 'x', targetTxid: T1 })
    const script = await signPayload(p, { wallet: spy })
    expect(asked).toEqual(Hash.sha256(aipPreimage(p, verifyAip(script)!.signer)))
  })
})
