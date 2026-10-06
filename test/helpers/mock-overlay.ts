// A stand-in for the overlay's `POST /submit`, served over real HTTP so a test
// exercises the same bytes, headers and JSON a browser would. It mirrors, in
// the same order:
//
//   peck-overlay-schema src/server.ts:1137   express.raw on /submit (BEEF bytes)
//   peck-overlay-schema src/server.ts:1514   topics = JSON.parse(x-topics), default ["peck-schema"]
//   peck-overlay-schema src/server.ts:1523   empty body: 400 { error: 'Empty BEEF body' }
//   @bsv/overlay Engine.submit               unsupported topic -> throw, SPV check -> throw,
//                                            then identifyAdmissibleOutputs per topic
//   peck-overlay-schema PeckSchemaTopicManager.ts:157-173 admission: an OP_RETURN with MAP and a valid type
//   peck-overlay-schema src/server.ts:1534-1536  any throw: 400 { error: message }
//
// The SPV step checks scripts only (no chain tracker), and every topic runs the
// social-content admission, which is enough for the SDK's records. A repeat
// submission of the same txid and topic gets an empty result, as the engine's
// duplicate check does (Engine.js:130-143).
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { PROTO_MAP, opReturnPushes, toLockingScript, type SchemaPayload } from '../../src/schema/index.js'

// PeckSchemaTopicManager.ts:26-34 (the subset the SDK writes).
const VALID_TYPES = new Set(['post', 'reply', 'like', 'unlike', 'follow', 'unfollow', 'repost', 'payment', 'message', 'profile'])
const SOCIAL_TOPICS = new Set(['tm_social-content', 'peck-schema'])
const KNOWN_TOPICS = new Set([...SOCIAL_TOPICS, 'tm_identity-profile', 'tm_identity-handle', 'tm_key-binding', 'tm_social-friend'])

export interface Received {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

export interface MockOverlay {
  url: string
  received: Received[]
  /** Answer the next request with this status and body instead of running the engine. */
  failNext(status: number, body: string): void
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function admissibleOutputs(tx: Transaction): number[] {
  const out: number[] = []
  tx.outputs.forEach((o, i) => {
    const pushes = o.lockingScript ? opReturnPushes(o.lockingScript) : null
    if (!pushes) return
    const text = pushes.map((p) => Buffer.from(p).toString('utf8'))
    const at = text.indexOf(PROTO_MAP)
    if (at < 0 || text[at + 1] !== 'SET') return
    for (let j = at + 2; j + 1 < text.length && text[j] !== '|'; j += 2) {
      if (text[j] === 'type' && VALID_TYPES.has((text[j + 1] ?? '').toLowerCase())) out.push(i)
    }
  })
  return out
}

export async function startMockOverlay(): Promise<MockOverlay> {
  const received: Received[] = []
  const seen = new Set<string>()
  let forced: { status: number; body: string } | null = null

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req)
    received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
    const send = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
      res.end(text)
    }
    if (forced) {
      const f = forced
      forced = null
      return send(f.status, f.body)
    }
    if (req.method !== 'POST' || req.url !== '/submit') return send(404, JSON.stringify({ error: 'not found' }))
    try {
      const topics = JSON.parse((req.headers['x-topics'] as string | undefined) || '["peck-schema"]') as string[]
      if (body.length === 0) return send(400, JSON.stringify({ error: 'Empty BEEF body' }))
      for (const t of topics) {
        if (!KNOWN_TOPICS.has(t)) throw new Error(`This server does not support this topic: ${t}`)
      }
      const tx = Transaction.fromBEEF(Array.from(body))
      if (!(await tx.verify('scripts only'))) throw new Error('Unable to verify SPV information.')
      const txid = tx.id('hex')
      const steak: Record<string, { outputsToAdmit: number[]; coinsToRetain: number[] }> = {}
      for (const t of topics) {
        const key = `${txid}:${t}`
        const dupe = seen.has(key)
        seen.add(key)
        steak[t] = { outputsToAdmit: !dupe && SOCIAL_TOPICS.has(t) ? admissibleOutputs(tx) : [], coinsToRetain: [] }
      }
      return send(200, JSON.stringify(steak))
    } catch (e) {
      return send(400, JSON.stringify({ error: (e as Error).message }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    failNext(status, text) {
      forced = { status, body: text }
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

/**
 * A transaction the way a wallet hands it back: one OP_RETURN record spending
 * a (fake) confirmed parent, so its Atomic BEEF carries the parent and a
 * merkle path. `salt` makes each call a different transaction.
 */
export async function walletLikeTransaction(record: SchemaPayload, salt = 1): Promise<Transaction> {
  const key = new PrivateKey(7000 + salt)
  const parent = new Transaction(1, [], [{ lockingScript: new P2PKH().lock(key.toPublicKey().toHash()), satoshis: 1000 + salt }], 0)
  parent.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: parent.id('hex'), txid: true }]])
  const tx = new Transaction(
    1,
    [{ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key), sequence: 0xffffffff }],
    [{ lockingScript: toLockingScript(record), satoshis: 0 }],
    0,
  )
  await tx.sign()
  return tx
}
