// The message box client: wire compatibility with peck.to's deployed DM
// client (requests byte for byte, rows decoded the same), host discovery,
// errors and live delivery. The transport is a fake message box behind the
// authenticated-fetch seam; no network.
import type { AuthSocketClient } from '@bsv/authsocket-client'
import { Utils, type WalletInterface } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  DM_BOX,
  RECEIPT_BOX,
  TYPING_BOX,
  createDmClient,
  parseSignal,
  type DmClient,
  type DmClientOptions,
  type DmMessage,
  type MessageBoxRow,
  type SocketFactory,
} from '../src/dm/index.js'
import { ALICE, BOB, FakeBoxes, FakeSocket, advertisement, alice, bob, fakeLookup, fixture, json, tick } from './helpers/dm-fakes.js'

// Compile-time check: the socket factory the option expects is the one
// @bsv/authsocket-client exports.
const _authSocketFits: SocketFactory = null as unknown as typeof AuthSocketClient
void _authSocketFits

const HOST = 'https://msg.peck.to'

function client(wallet: WalletInterface, identityKey: string, boxes: FakeBoxes, extra: Partial<DmClientOptions> = {}): DmClient {
  return createDmClient({ wallet, authFetch: boxes.transport(identityKey), lookup: false, ...extra })
}

/** The rows the deployed client's list() returns, from our DmMessages. */
const asDeployedList = (ms: DmMessage[]) => ms.map((m) => ({ messageId: m.messageId, sender: m.sender, text: m.text, ts: m.sentAt }))

describe('sending: requests match the deployed client byte for byte', () => {
  it('an envelope with messageId = txid (the dual-write path)', async () => {
    const boxes = new FakeBoxes()
    const res = await client(alice, ALICE, boxes).sendEnvelope(fixture.envelope, { messageId: fixture.txid })
    expect(res).toEqual({ messageId: fixture.txid, host: HOST })
    expect(boxes.calls).toEqual([{ as: ALICE, url: fixture.sendRawTxid.url, body: fixture.sendRawTxid.body }])
  })

  it('an envelope without a txid: the same HMAC message id', async () => {
    const boxes = new FakeBoxes()
    const res = await client(alice, ALICE, boxes).sendEnvelope(fixture.envelope2)
    expect(boxes.calls[0]!.body).toBe(fixture.sendRawHmac.body)
    expect(res.messageId).toBe(JSON.parse(fixture.sendRawHmac.body).message.messageId)
  })

  it('a group envelope into another box', async () => {
    const boxes = new FakeBoxes()
    await client(alice, ALICE, boxes).sendEnvelope(fixture.groupEnvelope, { box: 'grp_inbox' })
    expect(boxes.calls[0]!.body).toBe(fixture.sendGroup.body)
  })

  it('the older double layer: same message id and field order, and it opens on the other side', async () => {
    const theirs = JSON.parse(fixture.sendV1.body).message
    // Recover the inner body the deployed client encrypted, then send it the same way.
    const outer = JSON.parse(theirs.body).encryptedMessage as string
    const inner = Utils.toUTF8((await bob.decrypt({ ciphertext: Utils.toArray(outer, 'base64'), protocolID: [1, 'messagebox'], keyID: '1', counterparty: ALICE })).plaintext)
    const boxes = new FakeBoxes()
    await client(alice, ALICE, boxes).sendRaw({ to: BOB, box: DM_BOX, body: inner, encrypt: true })
    const ours = JSON.parse(boxes.calls[0]!.body).message
    expect(Object.keys(ours)).toEqual(Object.keys(theirs))
    expect(ours.messageId).toBe(theirs.messageId)
    expect(Object.keys(JSON.parse(ours.body))).toEqual(['encryptedMessage'])
    const [m] = await client(bob, BOB, boxes).list()
    expect(m!.text).toBe('v1 double layer')
  })

  it('send() builds the envelope and delivers it', async () => {
    const boxes = new FakeBoxes()
    const dm = client(alice, ALICE, boxes, { now: () => 1_790_000_000_000 })
    const res = await dm.send(BOB, 'hello bob')
    expect(res.envelope).toMatchObject({ v: 1, from: ALICE, to: BOB, sentAt: 1_790_000_000_000 })
    const sent = JSON.parse(boxes.calls[0]!.body).message
    expect(sent).toEqual({ recipient: BOB, messageBox: DM_BOX, body: JSON.stringify(res.envelope), messageId: res.messageId, skipEncryption: true })
    const [m] = await client(bob, BOB, boxes).list()
    expect(m).toMatchObject({ messageId: res.messageId, sender: ALICE, text: 'hello bob', sentAt: 1_790_000_000_000, box: DM_BOX, host: HOST })
  })

  it('validates its arguments', async () => {
    const dm = client(alice, ALICE, new FakeBoxes())
    await expect(dm.sendRaw({ to: 'nobody', box: DM_BOX, body: 'x' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(dm.sendRaw({ to: BOB, box: 'bad-box', body: 'x' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(dm.sendRaw({ to: BOB, box: DM_BOX, body: '  ' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(dm.sendEnvelope({ nope: true } as never)).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(dm.ack([])).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('listing: rows decode as the deployed client decodes them', () => {
  const replay = (response: unknown) => {
    const boxes = new FakeBoxes()
    boxes.override = (url) => (url.endsWith('/listMessages') ? json(response) : undefined)
    return boxes
  }

  it('dm_inbox: an envelope with a txid id, one with an HMAC id, and one in the older double layer', async () => {
    const boxes = replay(fixture.list.response)
    const msgs = await client(bob, BOB, boxes).list()
    expect(asDeployedList(msgs)).toEqual(fixture.list.decoded)
    expect(boxes.calls[0]).toEqual({ as: BOB, url: fixture.list.request.url, body: fixture.list.request.body })
    expect(msgs[0]!.envelope).toEqual(fixture.envelope)
    expect(msgs[0]!.createdAt).toBe('2026-10-01T00:00:01.000Z')
  })

  it('grp_inbox', async () => {
    const boxes = replay(fixture.listGroup.response)
    expect(asDeployedList(await client(bob, BOB, boxes).list('grp_inbox'))).toEqual(fixture.listGroup.decoded)
    expect(boxes.calls[0]!.body).toBe(fixture.listGroup.request.body)
  })

  it('rows stored by the live socket (no storage wrapper) decode too', async () => {
    const raw = fixture.live.incoming.map((m) => ({ messageId: m.messageId, sender: m.sender, body: m.body }))
    const msgs = await client(bob, BOB, replay({ status: 'success', messages: raw })).list()
    expect(msgs.map((m) => ({ messageId: m.messageId, sender: m.sender, text: m.text }))).toEqual(fixture.live.opened)
  })

  it('list() leaves out what does not open; listRows() and openRow() show it', async () => {
    const response = {
      status: 'success',
      messages: [
        (fixture.list.response.messages as Array<Record<string, unknown>>)[0],
        { messageId: 'junk', sender: ALICE, body: JSON.stringify({ message: 'not json at all' }) },
        { messageId: 'wrong-key', sender: BOB, body: JSON.stringify({ message: JSON.stringify(fixture.envelope) }) },
        { messageId: 'bad-outer', sender: ALICE, body: JSON.stringify({ message: JSON.stringify({ encryptedMessage: 'AAAA' }) }) },
      ],
    }
    const dm = client(bob, BOB, replay(response))
    expect((await dm.list()).map((m) => m.messageId)).toEqual([fixture.txid])
    const rows = await dm.listRows()
    expect(rows.map((r) => r.messageId)).toEqual([fixture.txid, 'junk', 'wrong-key', 'bad-outer'])
    expect(rows[1]!.body).toBe('not json at all')
    expect(rows[3]!.body).toBeNull()
    expect(await dm.openRow(rows[2]!)).toBeNull() // the box says Bob sent it: the counterparty is wrong
  })

  it('follows pages when the box pages', async () => {
    const all = fixture.list.response.messages
    const boxes = new FakeBoxes()
    boxes.override = (url, body) => {
      if (!url.endsWith('/listMessages')) return undefined
      const offset = (body as { offset: number }).offset
      return json({ status: 'success', messages: all.slice(offset, offset + 2), hasMore: offset + 2 < all.length, nextOffset: offset + 2 })
    }
    const msgs = await client(bob, BOB, boxes).list()
    expect(msgs).toHaveLength(3)
    expect(boxes.calls.map((c) => JSON.parse(c.body).offset)).toEqual([0, 2])
  })

  it('opens an on-chain copy of the user\'s own message', async () => {
    expect(await client(alice, ALICE, new FakeBoxes()).openEnvelope(fixture.envelope)).toBe(fixture.text)
  })
})

describe('acknowledging', () => {
  it('sends the deployed client\'s request body and removes the rows', async () => {
    const boxes = new FakeBoxes()
    await client(alice, ALICE, boxes).sendEnvelope(fixture.envelope, { messageId: fixture.list.decoded[0]!.messageId })
    boxes.rows.push(
      { ...boxes.rows[0]!, messageId: fixture.list.decoded[1]!.messageId },
      { ...boxes.rows[0]!, messageId: fixture.list.decoded[2]!.messageId },
    )
    const dm = client(bob, BOB, boxes)
    await dm.ack(fixture.list.decoded.map((m) => m.messageId))
    expect(boxes.calls.at(-1)).toEqual({ as: BOB, url: fixture.ack.url, body: fixture.ack.body })
    expect(await dm.list()).toEqual([])
  })

  it('throws when no host acknowledged', async () => {
    const dm = client(bob, BOB, new FakeBoxes())
    await expect(dm.ack(['missing'])).rejects.toMatchObject({ code: 'http', status: 400, serverCode: 'ERR_INVALID_ACKNOWLEDGMENT' })
  })
})

describe('errors', () => {
  const failing = (res: () => Response | Promise<Response>) => createDmClient({ wallet: alice, lookup: false, authFetch: { fetch: async () => res() } })

  it('a refusal carries the box\'s code and status', async () => {
    const dm = failing(() => json({ status: 'error', code: 'ERR_DELIVERY_BLOCKED', description: 'Blocked recipients: x' }, 403))
    await expect(dm.sendRaw({ to: BOB, box: DM_BOX, body: 'x', messageId: 'm' })).rejects.toMatchObject({
      name: 'DmError', code: 'http', status: 403, serverCode: 'ERR_DELIVERY_BLOCKED', message: 'Blocked recipients: x',
    })
  })

  it('a 200 with status error is a server error', async () => {
    await expect(failing(() => json({ status: 'error', description: 'nope' })).listRows()).rejects.toMatchObject({ code: 'server' })
  })

  it('no answer is a network error', async () => {
    const dm = failing(() => { throw new TypeError('fetch failed') })
    await expect(dm.list()).rejects.toMatchObject({ code: 'network' })
  })

  it('an answer without messages is an invalid response', async () => {
    await expect(failing(() => json({ status: 'success' })).list()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('needs a wallet and a valid host', () => {
    expect(() => createDmClient({ wallet: undefined as never })).toThrow(/wallet/)
    expect(() => createDmClient({ wallet: alice, host: 'ftp://x' })).toThrow(/HTTP/)
    expect(createDmClient({ wallet: alice, host: 'https://box.example.org/base/' }).host).toBe('https://box.example.org/base')
  })
})

describe('advertised hosts', () => {
  const OTHER = 'https://box.example.org'

  it('sends to the recipient\'s advertised host and lists and acks on every host the user uses', async () => {
    const lookup = fakeLookup({ [BOB]: [await advertisement(bob, BOB, OTHER)] })
    const boxes = new FakeBoxes()
    const res = await client(alice, ALICE, boxes, { lookup }).sendEnvelope(fixture.envelope, { messageId: fixture.txid })
    expect(res.host).toBe(OTHER)
    expect(boxes.calls[0]!.url).toBe(`${OTHER}/sendMessage`)
    expect(boxes.calls[0]!.body).toBe(fixture.sendRawTxid.body)
    expect(lookup.queries[0]).toEqual({ service: 'ls_messagebox', query: { identityKey: BOB } })

    // Bob also has one on the default host; the same id on both hosts is one message.
    boxes.rows.push({ ...boxes.rows[0]!, host: HOST })
    boxes.rows.push({ ...boxes.rows[0]!, host: HOST, messageId: 'only-on-default' })
    const dm = client(bob, BOB, boxes, { lookup })
    const listed = await dm.list()
    expect(listed.map((m) => [m.messageId, m.host])).toEqual([[fixture.txid, HOST], ['only-on-default', HOST]])
    const hostsListed = boxes.calls.filter((c) => c.url.endsWith('/listMessages')).map((c) => new URL(c.url).origin)
    expect(hostsListed.sort()).toEqual([OTHER, HOST].sort())
    await dm.ack(['only-on-default']) // not on OTHER (400 there), fine on the default host
    expect(boxes.rows.map((r) => r.messageId)).not.toContain('only-on-default')
  })

  it('ignores advertisements for local or non-https hosts, and unreadable outputs', async () => {
    const lookup = fakeLookup({
      [BOB]: [
        await advertisement(bob, BOB, 'http://box.example.org'),
        await advertisement(bob, BOB, 'https://localhost:8080'),
        await advertisement(bob, BOB, 'https://10.0.0.5'),
        { beef: [1, 2, 3], outputIndex: 0 },
      ],
    })
    const boxes = new FakeBoxes()
    const res = await client(alice, ALICE, boxes, { lookup }).sendEnvelope(fixture.envelope, { messageId: fixture.txid })
    expect(res.host).toBe(HOST)
  })

  it('falls back to the configured host when the lookup fails, and reuses answers for the TTL', async () => {
    let t = 0
    let calls = 0
    const lookup = { query: async () => { calls++; throw new Error('overlay down') } }
    const boxes = new FakeBoxes()
    const dm = client(alice, ALICE, boxes, { lookup, now: () => t })
    expect((await dm.sendEnvelope(fixture.envelope2)).host).toBe(HOST)
    expect(calls).toBe(1)
    const ok = fakeLookup({})
    const cached = client(alice, ALICE, boxes, { lookup: ok, now: () => t })
    await cached.sendEnvelope(fixture.envelope2, { messageId: 'a' })
    await cached.sendEnvelope(fixture.envelope2, { messageId: 'b' })
    expect(ok.queries).toHaveLength(1)
    t += 5 * 60_000
    await cached.sendEnvelope(fixture.envelope2, { messageId: 'c' })
    expect(ok.queries).toHaveLength(2)
  })
})

describe('live delivery', () => {
  function liveSetup(opts: { ackSends?: boolean; auth?: FakeSocket['auth'] } = {}) {
    const sockets: FakeSocket[] = []
    const opened: Array<{ url: string; options: unknown }> = []
    const factory: SocketFactory = (url, options) => {
      const s = new FakeSocket()
      if (opts.ackSends === false) s.ackSends = false
      if (opts.auth !== undefined) s.auth = opts.auth
      opened.push({ url, options })
      sockets.push(s)
      setTimeout(() => s.connect(), 0)
      return s
    }
    return { sockets, opened, factory }
  }

  it('joins the room and delivers incoming rows opened, as the deployed client does', async () => {
    const { sockets, opened, factory } = liveSetup()
    const dm = client(bob, BOB, new FakeBoxes(), { socket: factory, originator: 'peck.to' })
    const got: DmMessage[] = []
    const unreadable: MessageBoxRow[] = []
    await dm.listen(DM_BOX, (m) => got.push(m), { onUnreadable: (r) => unreadable.push(r) })
    const s = sockets[0]!
    expect(opened[0]).toEqual({ url: HOST, options: { wallet: bob, originator: 'peck.to' } })
    expect(s.emitted[0]).toEqual({ event: 'authenticated', data: { identityKey: BOB } })
    expect(s.emitted.filter((e) => e.event === 'joinRoom')).toEqual(fixture.live.joinRoom)
    expect(dm.isLive()).toBe(true)

    for (const m of fixture.live.incoming) s.fire(`sendMessage-${BOB}-dm_inbox`, m)
    s.fire(`sendMessage-${BOB}-dm_inbox`, { sender: ALICE, messageId: 'junk', body: 'hello?' })
    await tick()
    await tick()
    expect(got.map((m) => ({ messageId: m.messageId, sender: m.sender, text: m.text }))).toEqual(fixture.live.opened)
    expect(unreadable.map((r) => r.messageId)).toEqual(['junk'])
  })

  it('joins again after a reconnect, and leaves when the last listener goes', async () => {
    const { sockets, factory } = liveSetup()
    const dm = client(bob, BOB, new FakeBoxes(), { socket: factory })
    const off = await dm.listen(DM_BOX, () => {})
    await dm.listen(TYPING_BOX, () => {})
    const s = sockets[0]!
    s.drop()
    expect(dm.isLive()).toBe(false)
    s.connect()
    await tick()
    const joins = s.emitted.filter((e) => e.event === 'joinRoom').map((e) => e.data)
    expect(joins).toEqual([`${BOB}-dm_inbox`, `${BOB}-dm_typing`, `${BOB}-dm_inbox`, `${BOB}-dm_typing`])
    expect(sockets).toHaveLength(1)
    off()
    expect(s.emitted.at(-1)).toEqual({ event: 'leaveRoom', data: `${BOB}-dm_inbox` })
    dm.close()
    expect(s.disconnected).toBe(true)
  })

  it('sends a typing ping exactly as the deployed client emits it', async () => {
    const { sockets, factory } = liveSetup()
    const dm = client(alice, ALICE, new FakeBoxes(), { socket: factory })
    await dm.listen(DM_BOX, () => {})
    const body = JSON.stringify(fixture.live.typing.envelope)
    const res = await dm.sendLive({ to: BOB, box: TYPING_BOX, body, messageId: fixture.live.typing.messageId })
    expect(res).toEqual({ messageId: fixture.live.typing.messageId, host: HOST, via: 'live' })
    expect(sockets[0]!.emitted.filter((e) => e.event === 'sendMessage')).toEqual(fixture.live.typing.emitted)
  })

  it('falls back to HTTP when the server does not confirm in time', async () => {
    const { factory } = liveSetup({ ackSends: false })
    const boxes = new FakeBoxes()
    const dm = client(alice, ALICE, boxes, { socket: factory, liveAckTimeoutMs: 20 })
    const res = await dm.sendLive({ to: BOB, box: DM_BOX, body: JSON.stringify(fixture.envelope2) })
    expect(res.via).toBe('http')
    expect(boxes.calls[0]!.body).toBe(fixture.sendRawHmac.body)
  })

  it('without a socket: listen() rejects, sendLive() uses HTTP, signals are not sent', async () => {
    const boxes = new FakeBoxes()
    const dm = client(alice, ALICE, boxes)
    await expect(dm.listen(DM_BOX, () => {})).rejects.toMatchObject({ code: 'no_socket' })
    expect((await dm.sendLive({ to: BOB, box: DM_BOX, body: 'x', messageId: 'm1' })).via).toBe('http')
    expect(await dm.sendTyping(BOB)).toBe(false)
    expect(await dm.sendReceipt(BOB, 'seen', ['m1'])).toBe(false)
    expect(boxes.calls).toHaveLength(1)
  })

  it('asks the server again after an authentication timeout', async () => {
    const { sockets, factory } = liveSetup({ auth: null })
    const dm = client(bob, BOB, new FakeBoxes(), { socket: factory, liveAuthTimeoutMs: 20 })
    await expect(dm.listen(DM_BOX, () => {})).rejects.toMatchObject({ code: 'live_unavailable' })
    sockets[0]!.auth = 'success'
    await dm.listen(DM_BOX, () => {})
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.emitted.filter((e) => e.event === 'authenticated')).toHaveLength(2)
    expect(dm.isLive()).toBe(true)
  })

  it('reports a socket the server refuses', async () => {
    const { factory } = liveSetup({ auth: 'failed' })
    const dm = client(bob, BOB, new FakeBoxes(), { socket: factory })
    await expect(dm.listen(DM_BOX, () => {})).rejects.toMatchObject({ code: 'live_unavailable' })
  })

  it('typing and receipt signals round-trip through the live room', async () => {
    const { sockets, factory } = liveSetup()
    const a = client(alice, ALICE, new FakeBoxes(), { socket: factory, now: () => 1_790_000_000_000 })
    const b = client(bob, BOB, new FakeBoxes(), { socket: factory })
    await a.listen(DM_BOX, () => {})
    const signals: Array<{ box: string; text: string }> = []
    await b.listen(TYPING_BOX, (m) => signals.push({ box: m.box, text: m.text }))
    await b.listen(RECEIPT_BOX, (m) => signals.push({ box: m.box, text: m.text }))
    expect(await a.sendTyping(BOB)).toBe(true)
    expect(await a.sendReceipt(BOB, 'seen', ['m1', 'm2'])).toBe(true)
    const sent = sockets[0]!.emitted.filter((e) => e.event === 'sendMessage').map((e) => e.data as { roomId: string; message: { messageId: string; recipient: string; body: string } })
    expect(sent.map((d) => d.roomId)).toEqual([`${BOB}-dm_typing`, `${BOB}-dm_receipt`])
    expect(sent[0]!.message.messageId).toMatch(/^t[0-9a-z]+[0-9a-f]{6}$/)
    expect(sent[1]!.message.messageId).toMatch(/^r/)
    // play the server: deliver both into Bob's rooms
    for (const d of sent) sockets[1]!.fire(`sendMessage-${d.roomId}`, { sender: ALICE, messageId: d.message.messageId, body: d.message.body })
    await tick()
    await tick()
    expect(signals).toEqual([
      { box: TYPING_BOX, text: '{"type":"typing"}' },
      { box: RECEIPT_BOX, text: '{"type":"receipt","state":"seen","ids":["m1","m2"]}' },
    ])
    expect(signals.map((s) => parseSignal(s.text))).toEqual([{ type: 'typing' }, { type: 'receipt', state: 'seen', ids: ['m1', 'm2'] }])
    // the deployed client's typing envelope reads as a typing signal too
    const theirs = await b.openRow({ messageId: 't', sender: ALICE, box: TYPING_BOX, host: HOST, body: fixture.live.typing.envelope })
    expect(parseSignal(theirs!.text)).toEqual({ type: 'typing' })
  })

  it('parseSignal ignores anything that is not a signal', () => {
    for (const t of ['hi', '{}', '{"type":"receipt","state":"read","ids":[]}', '{"type":"receipt","state":"seen"}', '[]']) {
      expect(parseSignal(t)).toBeNull()
    }
  })
})
