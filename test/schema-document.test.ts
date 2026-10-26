// Spec 09 (documents): the revision builder, the verifier, the canonical
// history and section quotes. The vectors come from the spec itself:
//   - 09 §7.2 / 00 §7.1: the complete 579-byte script, its 449-byte preimage,
//     digest and RFC 6979 signature, reproduced byte for byte;
//   - 09 §7.1: the push layout of revision 2 of spec 08, row by row, built
//     from a copy of the real 08 text (test/fixtures/documents);
//   - 09 §8: the slug table.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BSM,
  BigNumber,
  ECDSA,
  Hash,
  LockingScript,
  OP,
  PrivateKey,
  ProtoWallet,
  Transaction,
  Utils,
  type CreateSignatureArgs,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  PROTO_AIP,
  PROTO_B,
  PROTO_MAP,
  SchemaError,
  aipPreimage,
  documentHeadings,
  documentRevision,
  documentSha256,
  opReturnPushes,
  quote,
  quoteSection,
  reply,
  replySection,
  signPayload,
  slug,
  toLockingScript,
  verifyAip,
  verifyChain,
  verifyDocumentRevision,
  type AipWallet,
  type ChainEntry,
  type DocumentRevisionInput,
  type Push,
} from '../src/schema/index.js'

const fixture = (name: string) => resolve(import.meta.dirname, 'fixtures/documents', name)
const sha = (s: string) => Utils.toHex(Hash.sha256(Utils.toArray(s, 'utf8')))
const bytes = (s: string) => Utils.toArray(s, 'utf8')

// ── keys and wallets ────────────────────────────────────────────

/** 00 §7.1: SHA-256 of "overlay.social test vector 1". */
const TEST_KEY = PrivateKey.fromHex(sha('overlay.social test vector 1'))
const TEST_SIGNER = '03d7361ef48e4ae1dbf8588227be1fc1c58eb04656cf1c73782d3074396299f0a1'

/** A wallet that signs with one raw key (no BRC-42 derivation), as the spec's vector does. */
function rawKeyWallet(key: PrivateKey): AipWallet {
  return {
    getPublicKey: async () => ({ publicKey: key.toPublicKey().toString() }),
    createSignature: async (args: CreateSignatureArgs) => ({
      signature: ECDSA.sign(new BigNumber(args.hashToDirectlySign as number[]), key, true).toDER() as number[],
    }),
  }
}

const VECTOR_INPUT: DocumentRevisionInput = {
  app: 'overlay.social',
  doc: 'example.org/hello',
  rev: 2,
  prev: sha('placeholder for the txid of revision 1'),
  title: 'Hello',
  status: 'PUBLISHED',
  content: '# Hello\n\nSecond revision.\n',
  filename: 'hello.md',
}

async function signed(input: DocumentRevisionInput, key: PrivateKey = TEST_KEY): Promise<LockingScript> {
  return signPayload(documentRevision(input), { wallet: rawKeyWallet(key) })
}

/** Write pushes (strings, bytes, or the separator) as an OP_FALSE OP_RETURN script, without any checks. */
function script(pushes: Push[]): LockingScript {
  const s = new LockingScript()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  for (const p of pushes) s.writeBin(typeof p === 'string' ? (p === '|' ? [0x7c] : bytes(p)) : Array.from(p))
  return s
}

/** Sign raw pushes with BRC77 over the full preimage. */
function brc77(pushes: Push[], key = TEST_KEY): LockingScript {
  const signer = key.toPublicKey().toString()
  const head: Push[] = [...pushes, '|', PROTO_AIP, 'BRC77', signer]
  const preimage = head.flatMap((p) => (typeof p === 'string' ? (p === '|' ? [0x7c] : bytes(p)) : Array.from(p)))
  const sig = Utils.toBase64(key.sign(preimage).toDER() as number[])
  return script([...head, sig])
}

/** The data pushes of the vector record without its AIP section. */
function vectorPushes(overrides: Partial<Record<string, string>> = {}): Push[] {
  const content = overrides.content ?? (VECTOR_INPUT.content as string)
  const map: Record<string, string> = {
    app: 'overlay.social', type: 'post', kind: 'doc', doc: 'example.org/hello', rev: '2',
    prev: VECTOR_INPUT.prev!, title: 'Hello', status: 'PUBLISHED', sha256: sha(content),
  }
  for (const [k, v] of Object.entries(overrides)) if (k !== 'content' && v !== undefined) map[k] = v
  return [PROTO_B, content, 'text/markdown', 'utf-8', 'hello.md', '|', PROTO_MAP, 'SET', ...Object.entries(map).flat()]
}

// ── slugs ───────────────────────────────────────────────────────

describe('slug (09 §8)', () => {
  it('reproduces the spec table', () => {
    expect(slug('## 2. Anchor transaction (normative)')).toBe('2-anchor-transaction-normative')
    expect(slug('### 7.1 Test vector (BRC77)')).toBe('71-test-vector-brc77')
    expect(slug('# 08 — State anchoring')).toBe('08--state-anchoring')
    expect(slug('## 5. `kind`')).toBe('5-kind')
  })

  it('takes bare heading text as well as a heading line', () => {
    expect(slug('2. Anchor transaction (normative)')).toBe('2-anchor-transaction-normative')
  })

  it('keeps Unicode letters and digits, drops the rest', () => {
    expect(slug('## Æble og Øl, på Åsen')).toBe('æble-og-øl-på-åsen')
    expect(slug('## Ünïcödé 日本語 ١٢٣')).toBe('ünïcödé-日本語-١٢٣')
    expect(slug('## under_score and-dash')).toBe('under_score-and-dash')
  })

  it('removes trailing # characters and whitespace from a heading line', () => {
    expect(slug('## Closed heading ##  ')).toBe('closed-heading')
  })

  it('numbers repeats -1, -2 and skips fenced code', () => {
    const md = [
      '# Title',
      '## Notes',
      '```',
      '## Not a heading',
      '~~~',
      '## Still code',
      '```',
      '## Notes',
      '~~~~ js',
      '# also code',
      '~~~~',
      '## Notes ##',
      '####### seven is not a heading',
      '#no space',
      '    # indented',
    ].join('\n')
    expect(documentHeadings(md).map((h) => [h.level, h.slug, h.line])).toEqual([
      [1, 'title', 0],
      [2, 'notes', 1],
      [2, 'notes-1', 7],
      [2, 'notes-2', 11],
    ])
  })

  it('slugs the headings of the real spec 08', () => {
    const md = readFileSync(fixture('08-state-anchoring.md'), 'utf8')
    const slugs = documentHeadings(md).map((h) => h.slug)
    expect(slugs[0]).toBe('08--state-anchoring')
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})

// ── the 09 §7.2 / 00 §7.1 vector ────────────────────────────────

describe('documentRevision: spec test vector (09 §7.2, 00 §7.1)', () => {
  const expectedHex = readFileSync(fixture('spec09-7.2-vector.hex'), 'utf8').trim()

  it('has the spec values', () => {
    expect(TEST_KEY.toPublicKey().toString()).toBe(TEST_SIGNER)
    expect(documentSha256(VECTOR_INPUT.content)).toBe('816bc0b1efa4e3bbfc90c1c9656ffcb5ae02ad98f3e93f5bd6f5b12408a179d9')
    expect(VECTOR_INPUT.prev).toBe('6ea5ee6d1b2326fc9461d91ac7c0517e931225f01fbd2170845b331928d1072c')
  })

  it('reproduces the 449-byte preimage and its digest', () => {
    const preimage = aipPreimage(documentRevision(VECTOR_INPUT), TEST_SIGNER)
    expect(preimage.length).toBe(449)
    expect(Utils.toHex(preimage.slice(0, 4))).toBe('31394878')
    expect(Utils.toHex(preimage.slice(-TEST_SIGNER.length))).toBe(Utils.toHex(bytes(TEST_SIGNER)))
    expect(Utils.toHex(Hash.sha256(preimage))).toBe('605388cc2d52242f6e3134940af503c7e1595ed3e3057dc379b3112f62e9f9a8')
  })

  it('reproduces the complete 579-byte locking script byte for byte', async () => {
    const s = await signed(VECTOR_INPUT)
    expect(s.toBinary().length).toBe(579)
    expect(s.toHex()).toBe(expectedHex)
    const sig = Utils.toUTF8(opReturnPushes(s)!.at(-1)!)
    expect(sig).toBe('MEQCIDz1HQ2/qm5g4MwDdftqGsx1RF6+/JXne8xVJ1k0WycwAiBwS45NuwiJQPwBV5t1qrTaW95z2hsaulgfNRwGhM8+Lg==')
  })

  it('verifies the spec script', () => {
    const c = verifyDocumentRevision(expectedHex)
    expect(c.errors).toEqual([])
    expect(c).toMatchObject({ ok: true, valid: true, sigOk: true, shaOk: true, algorithm: 'BRC77', signer: TEST_SIGNER })
    expect(c.fields).toEqual({
      app: 'overlay.social', type: 'post', kind: 'doc', doc: 'example.org/hello', rev: 2,
      prev: VECTOR_INPUT.prev, title: 'Hello', status: 'PUBLISHED',
      sha256: '816bc0b1efa4e3bbfc90c1c9656ffcb5ae02ad98f3e93f5bd6f5b12408a179d9',
      mediaType: 'text/markdown', encoding: 'utf-8', filename: 'hello.md',
    })
    expect(Utils.toUTF8(Array.from(c.content!))).toBe(VECTOR_INPUT.content)
    // The existing BRC77 verifier agrees.
    expect(verifyAip(expectedHex)).toEqual({ algorithm: 'BRC77', signer: TEST_SIGNER, valid: true })
  })

  it('writes rev as the data push 01 32, never OP_2', async () => {
    const hex = (await signed(VECTOR_INPUT)).toHex()
    expect(hex).toContain('03726576' + '0132') // 03 "rev" 01 "2"
    expect(hex).not.toContain('03726576' + '52')
  })
})

// ── the 09 §7.1 worked example: revision 2 of spec 08 ───────────

describe('documentRevision: worked example, revision 2 of spec 08 (09 §7.1)', () => {
  const text = readFileSync(fixture('08-state-anchoring.md'))
  const P = sha('txid of revision 1 of overlay.social/specs/08')
  const C = 'c'.repeat(40)
  const input: DocumentRevisionInput = {
    app: 'overlay.social',
    doc: 'overlay.social/specs/08',
    rev: 2,
    prev: P,
    title: 'State anchoring',
    status: 'IMPLEMENTED',
    content: new Uint8Array(text),
    filename: '08-state-anchoring.md',
    source: `https://github.com/overlay-social/specs/blob/${C}/specs/08-state-anchoring.md`,
    note: 'Verified against live code; plain-language summary.',
  }

  /** The raw script as a list of [opcode/length prefix hex, data] rows. */
  function rows(s: LockingScript): Array<[string, number[]]> {
    const bin = s.toBinary()
    const out: Array<[string, number[]]> = []
    let i = 2
    while (i < bin.length) {
      const op = bin[i]!
      let len: number
      let prefix: number[]
      if (op < 0x4c) { len = op; prefix = [op]; i += 1 }
      else if (op === 0x4c) { len = bin[i + 1]!; prefix = [op, len]; i += 2 }
      else if (op === 0x4d) { len = bin[i + 1]! | (bin[i + 2]! << 8); prefix = [op, bin[i + 1]!, bin[i + 2]!]; i += 3 }
      else throw new Error(`unexpected opcode ${op}`)
      out.push([Utils.toHex(prefix), bin.slice(i, i + len)])
      i += len
    }
    return out
  }

  const lenPrefix = (n: number) => Utils.toHex(n < 0x4c ? [n] : n <= 0xff ? [0x4c, n] : [0x4d, n & 0xff, n >> 8])

  it('lays out every push as the spec table shows, with the preimage boundaries', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const s = await signPayload(documentRevision(input), { wallet })
    const bin = s.toBinary()
    expect(Utils.toHex(bin.slice(0, 2))).toBe('006a') // not in the preimage
    const r = rows(s)
    const N = text.length
    expect(N).toBeGreaterThan(255)
    const H = Utils.toHex(Hash.sha256(Array.from(text)))
    const K = Utils.toUTF8(r[r.length - 2]![1])
    const t = (row: [string, number[]]) => [row[0], Utils.toUTF8(row[1])]
    const expected: Array<[string, string]> = [
      ['22', PROTO_B],
      [`4d${Utils.toHex([N & 0xff, N >> 8])}`, text.toString('utf8')],
      ['0d', 'text/markdown'],
      ['05', 'utf-8'],
      ['15', '08-state-anchoring.md'],
      ['01', '|'],
      ['22', PROTO_MAP],
      ['03', 'SET'],
      ['03', 'app'], ['0e', 'overlay.social'],
      ['04', 'type'], ['04', 'post'],
      ['04', 'kind'], ['03', 'doc'],
      ['03', 'doc'], ['17', 'overlay.social/specs/08'],
      ['03', 'rev'], ['01', '2'],
      ['04', 'prev'], ['40', P],
      ['05', 'title'], ['0f', 'State anchoring'],
      ['06', 'status'], ['0b', 'IMPLEMENTED'],
      ['06', 'sha256'], ['40', H],
      // `<len>`: the minimal push; the 113-byte URL needs OP_PUSHDATA1.
      ['06', 'source'], [lenPrefix(bytes(input.source!).length), input.source!],
      ['04', 'note'], [lenPrefix(bytes(input.note!).length), input.note!],
      ['01', '|'],
      ['22', PROTO_AIP],
      ['05', 'BRC77'],
      ['42', K],
    ]
    expect(r.slice(0, expected.length).map(t)).toEqual(expected)
    // Row 24: the signature, base64 DER, an OP_PUSHDATA1 push outside the preimage.
    expect(r.length).toBe(expected.length + 1)
    expect(r.at(-1)![0].slice(0, 2)).toBe('4c')
    // Rows 1-23 are the preimage: the content bytes of those pushes, nothing else.
    const preimage = r.slice(0, expected.length).flatMap((x) => x[1])
    expect(preimage).toEqual(aipPreimage(documentRevision(input), K))
    const c = verifyDocumentRevision(s)
    expect(c.errors).toEqual([])
    expect(c.ok).toBe(true)
    expect(c.signer).toBe(K)
    expect(c.fields!.sha256).toBe(H)
  })
})

// ── builder invariants ──────────────────────────────────────────

describe('documentRevision invariants (09 §2)', () => {
  const base: DocumentRevisionInput = { app: 'overlay.social', doc: 'example.org/a', rev: 1, status: 'DRAFT', content: '# A\n' }
  const bad = (patch: Record<string, unknown>) => () => documentRevision({ ...base, ...patch } as DocumentRevisionInput)

  it('builds revision 1 without prev and without optional keys', () => {
    const keys = opReturnPushes(toLockingScript(documentRevision(base)))!.map((p) => Utils.toUTF8(p))
    expect(keys).toEqual([PROTO_B, '# A\n', 'text/markdown', 'utf-8', '|', PROTO_MAP, 'SET',
      'app', 'overlay.social', 'type', 'post', 'kind', 'doc', 'doc', 'example.org/a', 'rev', '1',
      'status', 'DRAFT', 'sha256', sha('# A\n')])
  })

  it('enforces rev >= 1 and prev iff rev > 1', () => {
    expect(bad({ rev: 0 })).toThrow(SchemaError)
    expect(bad({ rev: 1.5 })).toThrow(SchemaError)
    expect(bad({ rev: '2' })).toThrow(SchemaError)
    expect(bad({ prev: 'a'.repeat(64) })).toThrow(/absent when rev is 1/)
    expect(bad({ rev: 2 })).toThrow(/prev is required/)
    expect(bad({ rev: 2, prev: 'xyz' })).toThrow(/prev is required/)
    expect(() => documentRevision({ ...base, rev: 2, prev: 'A'.repeat(64) })).not.toThrow()
  })

  it('rejects every forbidden key', () => {
    for (const key of ['context', 'subcontext', 'tx', 'txid', 'ref_txid', 'contextValue', 'reply', 'reply_tx',
      'replyTx', 'tx_id_reply', 'in_reply_to', 'inReplyTo', 'thread_root_tx', 'channel']) {
      expect(bad({ [key]: 'x' }), key).toThrow(/cannot carry MAP/)
    }
  })

  it('checks the document id grammar', () => {
    for (const doc of ['', '/a', 'a/', 'a//b', 'A/b', 'a b', 'x'.repeat(201), 'a/ø']) expect(bad({ doc }), doc).toThrow(SchemaError)
    for (const doc of ['a', 'overlay.social/specs/08', 'a-b_c.d~e/f', 'x'.repeat(200)]) expect(bad({ doc }), doc).not.toThrow()
  })

  it('checks status, title, note, source and content', () => {
    expect(bad({ status: 'Published' })).toThrow(/uppercase/)
    expect(bad({ status: 'IN REVIEW' })).toThrow(/uppercase/)
    expect(bad({ status: undefined })).toThrow(/uppercase/)
    expect(bad({ title: 'two\nlines' })).toThrow(/single line/)
    expect(bad({ note: 'a\rb' })).toThrow(/single line/)
    expect(bad({ title: '|' })).toThrow(/"\|"/)
    expect(bad({ title: '7c' })).toThrow(/7c/)
    expect(bad({ source: 'http://example.org/a.md' })).toThrow(/https/)
    expect(bad({ source: 'not a url' })).toThrow(/https/)
    expect(bad({ content: '' })).toThrow(/empty/)
    expect(bad({ content: '\uD800x' })).toThrow(/well-formed/)
    expect(bad({ content: [0xff, 0xfe] })).toThrow(/UTF-8/)
    expect(bad({ app: '' })).toThrow(SchemaError)
  })

  it('hashes the exact bytes: no normalization, line endings or trimming', () => {
    const nfc = 'é\r\n  '
    const nfd = 'é\r\n  '
    const a = verifyDocumentRevision(toLockingScript(documentRevision({ ...base, content: nfc })))
    const b = verifyDocumentRevision(toLockingScript(documentRevision({ ...base, content: nfd })))
    expect(a.fields!.sha256).toBe(sha(nfc))
    expect(b.fields!.sha256).toBe(sha(nfd))
    expect(a.fields!.sha256).not.toBe(b.fields!.sha256)
    expect(Array.from(a.content!)).toEqual(bytes(nfc))
  })
})

// ── round trip and tampering ────────────────────────────────────

describe('verifyDocumentRevision', () => {
  it('round-trips through a BRC-100 wallet (derived key)', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const s = await signPayload(documentRevision({ ...VECTOR_INPUT, source: 'https://example.org/hello.md', note: 'Second.' }), { wallet })
    const c = verifyDocumentRevision(s.toHex())
    expect(c.errors).toEqual([])
    expect(c.ok).toBe(true)
    expect(c.fields).toMatchObject({ rev: 2, source: 'https://example.org/hello.md', note: 'Second.' })
  })

  it('accepts a transaction and finds the revision output', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: await signed(VECTOR_INPUT), satoshis: 0 })
    for (const input of [tx, tx.toHex(), tx.toBinary()]) {
      const c = verifyDocumentRevision(input)
      expect(c.ok).toBe(true)
      expect(c.txid).toBe(tx.id('hex'))
      expect(c.outputIndex).toBe(0)
    }
  })

  it('rejects a transaction with two revision records', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: await signed(VECTOR_INPUT), satoshis: 0 })
    tx.addOutput({ lockingScript: await signed({ ...VECTOR_INPUT, doc: 'example.org/other' }), satoshis: 0 })
    const c = verifyDocumentRevision(tx)
    expect(c.valid).toBe(false)
    expect(c.ok).toBe(false)
    expect(c.errors[0]).toMatch(/2 kind doc records/)
  })

  it('tamper: changed content fails the signature and the sha256', async () => {
    const pushes = opReturnPushes(await signed(VECTOR_INPUT))!
    pushes[1] = bytes('# Hello\n\nSecond revision!\n')
    const c = verifyDocumentRevision(script(pushes))
    expect(c).toMatchObject({ ok: false, valid: false, sigOk: false, shaOk: false })
  })

  it('tamper: a changed MAP field (rev, prev, doc, status) fails the signature', async () => {
    const orig = opReturnPushes(await signed(VECTOR_INPUT))!
    const at = (k: string) => orig.findIndex((p) => Utils.toUTF8(p) === k) + 1
    for (const [k, v] of [['rev', '3'], ['prev', 'f'.repeat(64)], ['doc', 'example.org/evil'], ['status', 'WITHDRAWN']] as const) {
      const pushes = orig.map((p) => [...p])
      pushes[at(k)] = bytes(v)
      const c = verifyDocumentRevision(script(pushes))
      expect(c.sigOk, k).toBe(false)
      expect(c.valid, k).toBe(false)
      expect(c.shaOk, k).toBe(true)
    }
  })

  it('tamper: a body-only signature re-wrapped as another revision is rejected (BRC77 and BITCOIN_ECDSA)', () => {
    const body = bytes(VECTOR_INPUT.content as string)
    const record = vectorPushes({ rev: '3', prev: 'e'.repeat(64) })
    // BRC77 over the B content only.
    const brc = script([...record, '|', PROTO_AIP, 'BRC77', TEST_SIGNER, Utils.toBase64(TEST_KEY.sign(body).toDER() as number[])])
    // twetch style: BITCOIN_ECDSA over the B content only.
    const address = TEST_KEY.toPublicKey().toAddress()
    const bsm = script([...record, '|', PROTO_AIP, 'BITCOIN_ECDSA', address, BSM.sign(body, TEST_KEY, 'base64') as string])
    for (const s of [brc, bsm]) {
      const c = verifyDocumentRevision(s)
      expect(c.sigOk).toBe(false)
      expect(c.valid).toBe(false)
      expect(c.signer).toBeNull()
      expect(c.errors.join('\n')).toMatch(/B content alone is not accepted/)
    }
  })

  it('accepts BITCOIN_ECDSA over the whole record, with an address or a key as signer', () => {
    const record = vectorPushes()
    for (const signer of [TEST_KEY.toPublicKey().toAddress(), TEST_SIGNER]) {
      const head: Push[] = [...record, '|', PROTO_AIP, 'BITCOIN_ECDSA', signer]
      const preimage = head.flatMap((p) => (typeof p === 'string' ? (p === '|' ? [0x7c] : bytes(p)) : Array.from(p)))
      const c = verifyDocumentRevision(script([...head, BSM.sign(preimage, TEST_KEY, 'base64') as string]))
      expect(c.errors).toEqual([])
      expect(c).toMatchObject({ ok: true, algorithm: 'BITCOIN_ECDSA', signer: TEST_SIGNER })
    }
    const other = PrivateKey.fromRandom()
    const head: Push[] = [...record, '|', PROTO_AIP, 'BITCOIN_ECDSA', TEST_KEY.toPublicKey().toAddress()]
    const preimage = head.flatMap((p) => (typeof p === 'string' ? (p === '|' ? [0x7c] : bytes(p)) : Array.from(p)))
    expect(verifyDocumentRevision(script([...head, BSM.sign(preimage, other, 'base64') as string])).sigOk).toBe(false)
  })

  it('tamper: data appended after the signature fails (09 §11)', async () => {
    const pushes: Push[] = [...opReturnPushes(await signed(VECTOR_INPUT))!, '|', PROTO_MAP, 'SET', 'status', 'WITHDRAWN']
    const c = verifyDocumentRevision(script(pushes))
    expect(c.valid).toBe(false)
    expect(c.sigOk).toBe(false)
    expect(c.errors.join('\n')).toMatch(/last data push/)
  })

  it('a signed sha256 mismatch is valid but not ok (09 §3, §5)', () => {
    const c = verifyDocumentRevision(brc77(vectorPushes({ sha256: 'a'.repeat(64) })))
    expect(c).toMatchObject({ ok: false, valid: true, sigOk: true, shaOk: false })
    expect(c.errors.join('\n')).toMatch(/integrity/)
  })

  it('rejects signed records that break §2', () => {
    const cases: Array<[string, Push[]]> = [
      ['MAP content', [...vectorPushes(), 'content', 'x']],
      ['MAP channel', [...vectorPushes(), 'channel', 'x']],
      ['MAP context', [...vectorPushes(), 'context', 'tx']],
      ['rev 1 with prev', vectorPushes({ rev: '1' })],
      ['rev with leading zero', vectorPushes({ rev: '02' })],
      ['rev 0', vectorPushes({ rev: '0' })],
      ['uppercase prev', vectorPushes({ prev: 'A'.repeat(64) })],
      ['kind', vectorPushes({ kind: 'longform' })],
      ['type', vectorPushes({ type: 'reply' })],
      ['status', vectorPushes({ status: 'Published' })],
      ['doc', vectorPushes({ doc: 'Example.org/hello' })],
      ['title two lines', vectorPushes({ title: 'a\nb' })],
      ['source http', [...vectorPushes(), 'source', 'http://example.org']],
      ['duplicate key', [...vectorPushes(), 'rev', '2']],
      ['encoding', vectorPushes().map((p) => (p === 'utf-8' ? 'binary' : p))],
      ['no B', vectorPushes().slice(6)],
    ]
    for (const [name, pushes] of cases) {
      const c = verifyDocumentRevision(brc77(pushes))
      expect(c.valid, name).toBe(false)
      expect(c.errors.length, name).toBeGreaterThan(0)
    }
    // Missing prev on rev 2.
    const noPrev = vectorPushes()
    const i = noPrev.indexOf('prev')
    noPrev.splice(i, 2)
    expect(verifyDocumentRevision(brc77(noPrev)).valid).toBe(false)
  })

  it('rejects rev pushed as OP_2 and an unsigned record', async () => {
    const hex = (await signed(VECTOR_INPUT)).toHex().replace('037265760132', '0372657652')
    const c = verifyDocumentRevision(hex)
    expect(c.valid).toBe(false)
    expect(c.errors.join('\n')).toMatch(/not a data push/)
    const unsigned = verifyDocumentRevision(toLockingScript(documentRevision(VECTOR_INPUT)))
    expect(unsigned.valid).toBe(false)
    expect(unsigned.shaOk).toBe(true)
    expect(unsigned.errors.join('\n')).toMatch(/no AIP section/)
  })

  it('accepts MAP ADD tags between MAP SET and AIP, covered by the signature', () => {
    const c = verifyDocumentRevision(brc77([...vectorPushes(), '|', PROTO_MAP, 'ADD', 'tags', 'spec']))
    expect(c.errors).toEqual([])
    expect(c.ok).toBe(true)
  })

  it('rejects a non-minimal push', async () => {
    const s = await signed(VECTOR_INPUT)
    const bin = s.toBinary()
    // Re-encode the 5-byte push "utf-8" (05 ...) as OP_PUSHDATA1 05 ...
    const hex = Utils.toHex(bin).replace('057574662d38', '4c057574662d38')
    expect(verifyDocumentRevision(hex).valid).toBe(false)
  })
})

// ── canonical history ───────────────────────────────────────────

describe('verifyChain (09 §4)', () => {
  const DOC = 'example.org/chain'
  const author = TEST_KEY

  async function rev(n: number, prev: string | undefined, opts: { key?: PrivateKey; doc?: string; text?: string } = {}) {
    const s = await signed({
      app: 'overlay.social', doc: opts.doc ?? DOC, rev: n, ...(prev ? { prev } : {}),
      status: 'PUBLISHED', content: opts.text ?? `# Rev ${n}\n`, filename: 'chain.md',
    }, opts.key ?? author)
    const tx = new Transaction()
    tx.addOutput({ lockingScript: s, satoshis: 0 })
    return { txid: tx.id('hex'), tx }
  }
  const at = (h: number, i = 0) => ({ height: h, index: i })
  const opts = { doc: DOC, author: TEST_SIGNER }

  it('builds the history and head from prev links', async () => {
    const r1 = await rev(1, undefined)
    const r2 = await rev(2, r1.txid)
    const r3 = await rev(3, r2.txid)
    const entries: ChainEntry[] = [
      { txid: r3.txid, revision: r3.tx },
      { txid: r1.txid, revision: r1.tx, block: at(100) },
      { txid: r2.txid, revision: r2.tx, block: at(101, 5) },
    ]
    const c = verifyChain(entries, opts)
    expect(c.history.map((r) => r.rev)).toEqual([1, 2, 3])
    expect(c.head!.txid).toBe(r3.txid)
    expect(c).toMatchObject({ ok: true, forked: false, provisional: true, status: 'PUBLISHED' })
    expect(c.excluded).toEqual([])
    const confirmed = verifyChain(entries.slice(1), opts)
    expect(confirmed.provisional).toBe(false)
    expect(confirmed.head!.rev).toBe(2)
  })

  it('fork: the earlier successor wins, the other stays reachable with its descendants', async () => {
    const r1 = await rev(1, undefined)
    const a2 = await rev(2, r1.txid, { text: 'A' })
    const b2 = await rev(2, r1.txid, { text: 'B' })
    const b3 = await rev(3, b2.txid)
    const c = verifyChain([
      { txid: r1.txid, revision: r1.tx, block: at(100) },
      { txid: b2.txid, revision: b2.tx, block: at(102, 1) },
      { txid: a2.txid, revision: a2.tx, block: at(102, 0) },
      { txid: b3.txid, revision: b3.tx, block: at(103) },
    ], opts)
    expect(c.history.map((r) => r.txid)).toEqual([r1.txid, a2.txid])
    expect(c.forked).toBe(true)
    expect(c.offChain.map((r) => [r.txid, r.reason])).toEqual([[b2.txid, 'losing-successor'], [b3.txid, 'descendant']])
  })

  it('order: confirmed before unconfirmed, lower height, then lower txid among unconfirmed', async () => {
    const g1 = await rev(1, undefined, { text: 'one' })
    const g2 = await rev(1, undefined, { text: 'two' })
    const [lo, hi] = g1.txid < g2.txid ? [g1, g2] : [g2, g1]
    expect(verifyChain([{ txid: hi.txid, revision: hi.tx }, { txid: lo.txid, revision: lo.tx }], opts).head!.txid).toBe(lo.txid)
    const c = verifyChain([{ txid: lo.txid, revision: lo.tx }, { txid: hi.txid, revision: hi.tx, block: at(900) }], opts)
    expect(c.head!.txid).toBe(hi.txid)
    expect(c.offChain[0]).toMatchObject({ txid: lo.txid, reason: 'losing-genesis' })
    const d = verifyChain([{ txid: lo.txid, revision: lo.tx, block: at(5) }, { txid: hi.txid, revision: hi.tx, block: at(4, 99) }], opts)
    expect(d.head!.txid).toBe(hi.txid)
  })

  it('wrong signer: revisions by another identity are never in the series', async () => {
    const r1 = await rev(1, undefined)
    const evil = PrivateKey.fromRandom()
    const x2 = await rev(2, r1.txid, { key: evil })
    const c = verifyChain([
      { txid: r1.txid, revision: r1.tx, block: at(1) },
      { txid: x2.txid, revision: x2.tx, block: at(2) },
    ], opts)
    expect(c.head!.txid).toBe(r1.txid)
    expect(c.excluded).toEqual([expect.objectContaining({ txid: x2.txid, reason: 'other-author' })])
    // Bound through a key-binding, the second key belongs to the author.
    const bound = verifyChain([
      { txid: r1.txid, revision: r1.tx, block: at(1) },
      { txid: x2.txid, revision: x2.tx, block: at(2) },
    ], { ...opts, identityOf: (k) => (k === evil.toPublicKey().toString() ? TEST_SIGNER : k) })
    expect(bound.head!.txid).toBe(x2.txid)
  })

  it('gap: a revision whose prev is missing, or whose rev skips, is an orphan', async () => {
    const r1 = await rev(1, undefined)
    const r2 = await rev(2, r1.txid)
    const r3 = await rev(3, r2.txid)
    const skip = await rev(3, r1.txid, { text: 'skip' })
    const c = verifyChain([
      { txid: r1.txid, revision: r1.tx, block: at(1) },
      { txid: r3.txid, revision: r3.tx, block: at(3) },
      { txid: skip.txid, revision: skip.tx, block: at(4) },
    ], opts)
    expect(c.history.map((r) => r.txid)).toEqual([r1.txid])
    expect(c.offChain.map((r) => [r.txid, r.reason])).toEqual([[r3.txid, 'orphan'], [skip.txid, 'orphan']])
  })

  it('no genesis: no history, everything reachable', async () => {
    const r1 = await rev(1, undefined)
    const r2 = await rev(2, r1.txid)
    const c = verifyChain([{ txid: r2.txid, revision: r2.tx }], opts)
    expect(c).toMatchObject({ ok: false, head: null, status: null, history: [] })
    expect(c.offChain).toEqual([expect.objectContaining({ txid: r2.txid, reason: 'orphan' })])
  })

  it('excludes other documents, invalid revisions, txid mismatches and duplicates; keeps sha mismatches marked', async () => {
    const r1 = await rev(1, undefined)
    const other = await rev(1, undefined, { doc: 'example.org/other' })
    const bad = brc77(vectorPushes({ doc: DOC, rev: '2', prev: r1.txid, sha256: 'b'.repeat(64) }))
    const badTx = new Transaction()
    badTx.addOutput({ lockingScript: bad, satoshis: 0 })
    const forged = await rev(2, r1.txid, { text: 'forged' })
    const forgedPushes = opReturnPushes(forged.tx.outputs[0]!.lockingScript)!
    forgedPushes[1] = bytes('changed')
    const c = verifyChain([
      { txid: r1.txid, revision: r1.tx, block: at(1) },
      { txid: r1.txid, revision: r1.tx, block: at(1) },
      { txid: other.txid, revision: other.tx },
      { txid: 'f'.repeat(64), revision: forged.tx },
      { txid: forged.txid, revision: script(forgedPushes) },
      { txid: badTx.id('hex'), revision: badTx, block: at(2) },
    ], opts)
    expect(c.excluded.map((e) => e.reason)).toEqual(['duplicate', 'other-doc', 'txid-mismatch', 'invalid'])
    expect(c.history.map((r) => r.rev)).toEqual([1, 2])
    expect(c.integrityFailures).toEqual([badTx.id('hex')])
    expect(c.ok).toBe(false)
  })
})

// ── section quotes and replies ──────────────────────────────────

describe('quoteSection / replySection (09 §8)', () => {
  const T = 'ab'.repeat(32)
  const map = (p: ReturnType<typeof quote>) => {
    const s = p.pushes.map((x) => Utils.toUTF8([...x]))
    return s.slice(s.indexOf('SET') + 1)
  }

  it('quote: type repost, own text, tx <revision>, section <slug>', () => {
    const p = quoteSection({ app: 'peck.to', text: 'See this', revisionTxid: T, section: slug('## 4.3 Canonical history') })
    expect(map(p)).toEqual(['app', 'peck.to', 'type', 'repost', 'content', 'See this', 'tx', T, 'section', '43-canonical-history'])
  })

  it('reply: type post, context tx, tx and reply <revision>, section <slug>', () => {
    const p = replySection({ app: 'peck.to', text: 'Question', revisionTxid: T, section: 'notes-1' })
    expect(map(p)).toEqual(['app', 'peck.to', 'type', 'post', 'content', 'Question', 'context', 'tx', 'tx', T, 'reply', T, 'section', 'notes-1'])
  })

  it('without a section points at the whole revision, identical to quote() and reply()', () => {
    expect(quoteSection({ app: 'a', text: 't', revisionTxid: T })).toEqual(quote({ app: 'a', text: 't', targetTxid: T }))
    expect(replySection({ app: 'a', text: 't', revisionTxid: T })).toEqual(reply({ app: 'a', text: 't', parentTxid: T }))
  })

  it('section is written before tags and checked as a slug', () => {
    const p = quoteSection({ app: 'a', text: 't', revisionTxid: T, section: 'x', tags: ['spec'] })
    const s = p.pushes.map((x) => Utils.toUTF8([...x]))
    expect(s.slice(-7)).toEqual(['section', 'x', '|', PROTO_MAP, 'ADD', 'tags', 'spec'])
    for (const section of ['', 'Has Caps', 'has space', 'a.b', '7c']) {
      expect(() => quoteSection({ app: 'a', text: 't', revisionTxid: T, section }), section).toThrow(SchemaError)
    }
  })
})
