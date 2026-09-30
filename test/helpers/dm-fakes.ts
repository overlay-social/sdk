// Test doubles for the dm module: the two fixture identities, a fake
// authenticated transport that behaves like a message box, a fake overlay
// lookup and a fake live socket.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hash, PrivateKey, ProtoWallet, PushDrop, Transaction, Utils, type LockingScript, type LookupAnswer, type WalletInterface } from '@bsv/sdk'
import type { DmEnvelope } from '../../src/dm/index.js'

export interface Recorded { url: string; body: string }

export interface DmFixture {
  keys: { alice: { seed: string; identityKey: string }; bob: { seed: string; identityKey: string } }
  host: string
  text: string
  txid: string
  envelope: DmEnvelope
  sendRawTxid: Recorded
  envelope2: DmEnvelope
  sendRawHmac: Recorded
  sendV1: Recorded
  groupEnvelope: DmEnvelope
  sendGroup: Recorded
  list: { request: Recorded; response: { messages: unknown[] }; decoded: Array<{ messageId: string; sender: string; text: string; ts: number | null }> }
  listGroup: { request: Recorded; response: { messages: unknown[] }; decoded: Array<{ messageId: string; sender: string; text: string; ts: number | null }> }
  ack: Recorded
  ownOpen: string
  live: {
    typing: { envelope: DmEnvelope; messageId: string; emitted: Array<{ event: string; data: unknown }> }
    joinRoom: Array<{ event: string; data: unknown }>
    incoming: Array<{ sender: string; messageId: string; body: string }>
    opened: Array<{ messageId: string; sender: string; text: string }>
  }
}

export const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/dm/peck-dm-live.json'), 'utf8'),
) as DmFixture

export function keyFromSeed(seed: string): PrivateKey {
  return new PrivateKey(Utils.toHex(Hash.sha256(Utils.toArray(seed, 'utf8'))), 16)
}

export const alice = new ProtoWallet(keyFromSeed(fixture.keys.alice.seed)) as unknown as WalletInterface
export const bob = new ProtoWallet(keyFromSeed(fixture.keys.bob.seed)) as unknown as WalletInterface
export const ALICE = fixture.keys.alice.identityKey
export const BOB = fixture.keys.bob.identityKey

// ── a message box ───────────────────────────────────────────────

export interface StoredRow { host: string; recipient: string; box: string; messageId: string; sender: string; body: string; createdAt: string }

/** Shared storage for several fake hosts, so one test can send as Alice and list as Bob. */
export class FakeBoxes {
  rows: StoredRow[] = []
  calls: Array<{ as: string; url: string; body: string }> = []
  /** Per-URL overrides: return a Response to answer instead of the box. */
  override?: (url: string, body: unknown) => Response | undefined
  private clock = Date.parse('2026-10-01T00:00:00Z')

  transport(identityKey: string) {
    return {
      fetch: async (url: string, init?: { body?: unknown }): Promise<Response> => {
        const raw = String(init?.body ?? '')
        this.calls.push({ as: identityKey, url, body: raw })
        const body = JSON.parse(raw) as Record<string, unknown>
        const custom = this.override?.(url, body)
        if (custom) return custom
        const u = new URL(url)
        const host = u.origin
        if (u.pathname === '/sendMessage') {
          const m = body.message as { recipient: string; messageBox: string; body: string; messageId: string }
          if (!this.rows.some((r) => r.messageId === m.messageId)) {
            this.rows.push({
              host, recipient: m.recipient, box: m.messageBox, messageId: m.messageId, sender: identityKey,
              body: JSON.stringify({ message: m.body }), createdAt: new Date((this.clock += 1000)).toISOString(),
            })
          }
          return json({ status: 'success', message: 'Your message has been sent to 1 recipient(s).', results: [{ recipient: m.recipient, messageId: m.messageId }] })
        }
        if (u.pathname === '/listMessages') {
          const messages = this.rows
            .filter((r) => r.host === host && r.recipient === identityKey && r.box === body.messageBox)
            .map((r) => ({ messageId: r.messageId, body: r.body, sender: r.sender, createdAt: r.createdAt, updatedAt: r.createdAt }))
          return json({ status: 'success', messages })
        }
        if (u.pathname === '/acknowledgeMessage') {
          const ids = body.messageIds as string[]
          const before = this.rows.length
          this.rows = this.rows.filter((r) => !(r.host === host && r.recipient === identityKey && ids.includes(r.messageId)))
          if (this.rows.length === before) return json({ status: 'error', code: 'ERR_INVALID_ACKNOWLEDGMENT', description: 'Message not found!' }, 400)
          return json({ status: 'success' })
        }
        return json({ status: 'error', code: 'ERR_NOT_FOUND', description: 'no route' }, 404)
      },
    }
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ── overlay lookup ──────────────────────────────────────────────

/** A `tm_messagebox`-style advertisement: a PushDrop output with fields [identityKey, host]. */
export async function advertisement(wallet: WalletInterface, identityKey: string, host: string): Promise<{ beef: number[]; outputIndex: number }> {
  const script: LockingScript = await new PushDrop(wallet).lock(
    [Utils.toArray(identityKey, 'hex'), Utils.toArray(host, 'utf8')],
    [1, 'messagebox advertisement'],
    '1',
    'anyone',
    true,
  )
  const tx = new Transaction()
  tx.addOutput({ lockingScript: script, satoshis: 1 })
  return { beef: tx.toBEEF(), outputIndex: 0 }
}

export function fakeLookup(byKey: Record<string, Array<{ beef: number[]; outputIndex: number }>>) {
  const queries: unknown[] = []
  return {
    queries,
    async query(q: { service: string; query: unknown }): Promise<LookupAnswer> {
      queries.push(q)
      const key = (q.query as { identityKey: string }).identityKey
      return { type: 'output-list', outputs: byKey[key] ?? [] }
    },
  }
}

// ── live socket ─────────────────────────────────────────────────

/** A socket that records emits and lets the test play the server. */
export class FakeSocket {
  connected = false
  emitted: Array<{ event: string; data: unknown }> = []
  handlers = new Map<string, Array<(data: unknown) => void>>()
  /** Answer `authenticated` with success (default) or failure; null: never answer. */
  auth: 'success' | 'failed' | null = 'success'
  /** Confirm `sendMessage` (default) or stay silent. */
  ackSends = true
  disconnected = false

  on(event: string, cb: (data: unknown) => void) {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string, data?: unknown) {
    this.emitted.push({ event, data })
    if (event === 'authenticated' && this.auth) {
      queueMicrotask(() => this.fire(this.auth === 'success' ? 'authenticationSuccess' : 'authenticationFailed', { status: this.auth }))
    }
    if (event === 'sendMessage' && this.ackSends) {
      const d = data as { roomId: string; message: { messageId: string } }
      queueMicrotask(() => this.fire(`sendMessageAck-${d.roomId}`, { status: 'success', messageId: d.message.messageId }))
    }
    return this
  }

  fire(event: string, data?: unknown) {
    for (const cb of this.handlers.get(event) ?? []) cb(data)
  }

  connect() {
    this.connected = true
    this.fire('connect')
  }

  drop() {
    this.connected = false
    this.fire('disconnect', 'transport close')
  }

  disconnect() {
    this.disconnected = true
    this.connected = false
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0))
