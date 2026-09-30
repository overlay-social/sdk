/**
 * `createDmClient()`: envelopes plus the message box transport, the way
 * peck.to's DM client speaks to it.
 *
 * ── Transport ─────────────────────────────────────────────────────────────
 * A message box (default https://msg.peck.to) stores messages per recipient
 * and box name until the recipient acknowledges them. Every HTTP call is a
 * POST with a JSON body, mutually authenticated with BRC-103/104 through
 * `AuthFetch` from @bsv/sdk and the user's wallet:
 *
 *   /sendMessage         { message: { recipient, messageBox, body, messageId, … } }
 *   /listMessages        { messageBox, offset }
 *   /acknowledgeMessage  { messageIds }
 *
 * DMs go into the box `dm_inbox` as the serialized envelope, with no further
 * encryption (the envelope already is), and with the message id set to the
 * on-chain transaction id when the sender wrote one. Without an id, the id is
 * the hex HMAC of JSON.stringify(body) under protocol [1, 'messagebox'], key
 * ID '1', counterparty = recipient (what the MessageBox client library
 * derives). Older clients wrapped the envelope once more in that library's
 * own layer, `{ "encryptedMessage": <base64> }` under the same protocol;
 * `list()` and `listen()` read both.
 *
 * ── Hosts ─────────────────────────────────────────────────────────────────
 * A user may advertise another message box host on the BSV overlay
 * (lookup service `ls_messagebox`). Like the MessageBox client library, the
 * client sends to the recipient's advertised host when there is one, and
 * lists and acknowledges on its own host plus every host the user
 * advertises. Pass `lookup: false` to use the configured host only.
 *
 * ── Live delivery ─────────────────────────────────────────────────────────
 * With a socket factory (`socket: AuthSocketClient` from
 * @bsv/authsocket-client), `listen()` joins the room `<identityKey>-<box>` on
 * the host's authenticated WebSocket and `sendLive()` delivers through it,
 * falling back to HTTP when the socket is down or the server does not
 * confirm in time. Typing and receipt signals ride the same socket in the
 * boxes `dm_typing` and `dm_receipt`.
 */
import {
  AuthFetch,
  LookupResolver,
  PushDrop,
  Random,
  Transaction,
  Utils,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk'
import {
  buildEnvelope,
  decryptText,
  identityKeyOf,
  isIdentityKey,
  openEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type DmEnvelope,
} from './envelope.js'
import { DmError } from './errors.js'
import { endpoint, normalizeAdvertisedHost, normalizeHost } from './host.js'

/** The message box peck.to uses. */
export const DEFAULT_DM_HOST = 'https://msg.peck.to'
/** Protocol of the message box's own layer (message ids, the older outer encryption). */
export const MESSAGEBOX_PROTOCOL: WalletProtocol = [1, 'messagebox']
export const MESSAGEBOX_KEY_ID = '1'
/** The box DMs are delivered to. */
export const DM_BOX = 'dm_inbox'
/** Typing signals. Never shown as messages; acknowledge them on sight. */
export const TYPING_BOX = 'dm_typing'
/** Delivery and read receipts. */
export const RECEIPT_BOX = 'dm_receipt'

const BOX_RE = /^[A-Za-z0-9_]{1,64}$/
const MAX_LIST_PAGES = 100
const DEFAULT_DISCOVERY_TTL_MS = 5 * 60_000
const DEFAULT_LIVE_AUTH_TIMEOUT_MS = 5_000
const DEFAULT_LIVE_ACK_TIMEOUT_MS = 10_000

// ── types ───────────────────────────────────────────────────────

/** A message as the box holds it, with the box's storage wrapper and the older outer layer removed. */
export interface MessageBoxRow {
  messageId: string
  /** The sender's identity key, as the message box authenticated it. */
  sender: string
  box: string
  /** The host the row came from. */
  host: string
  /** The body: parsed JSON when it is JSON (for DMs, the envelope), else the string. null when the outer layer did not decrypt. */
  body: unknown
  /** When the box stored it (ISO 8601), when the box says. */
  createdAt?: string
}

/** A DM that opened: the row plus its envelope and decrypted text. */
export interface DmMessage {
  messageId: string
  sender: string
  box: string
  host: string
  text: string
  /** The envelope's `sentAt`, or null when it has none. */
  sentAt: number | null
  envelope: DmEnvelope
  createdAt?: string
}

export interface SendResult {
  messageId: string
  /** The host the message went to. */
  host: string
}

export interface LiveSendResult extends SendResult {
  /** How it went: over the socket, or over HTTP after the socket did not confirm. */
  via: 'live' | 'http'
}

/** A typing or receipt signal: the plaintext of an envelope in `dm_typing` or `dm_receipt`. */
export type DmSignal =
  | { type: 'typing' }
  | { type: 'receipt'; state: ReceiptState; ids: string[] }

/** `fetched`: the peer's client pulled the message. `seen`: it was shown in an open conversation. */
export type ReceiptState = 'fetched' | 'seen'

/**
 * An authenticated socket, as `AuthSocketClient` from @bsv/authsocket-client
 * returns: socket.io events over a BRC-103 channel.
 */
export interface LiveSocket {
  readonly connected: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (data: any) => void): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, data?: any): unknown
  disconnect(): void
}

export type SocketFactory = (url: string, options: { wallet: WalletInterface; originator?: string }) => LiveSocket

export interface DmClientOptions {
  /** The user's BRC-100 wallet (for example from `connect()` in the `wallet` module). */
  wallet: WalletInterface
  /** Message box base URL. Default https://msg.peck.to. */
  host?: string
  /** Passed to the wallet and to the authenticated transport as the calling app's originator. */
  originator?: string
  /** The authenticated HTTP transport. Default: `new AuthFetch(wallet, undefined, undefined, originator)`. */
  authFetch?: Pick<AuthFetch, 'fetch'>
  /**
   * Where to look up advertised message box hosts. Default: a mainnet
   * `LookupResolver`, created on first use. `false` uses the configured host only.
   */
  lookup?: Pick<LookupResolver, 'query'> | false
  /** How long a host lookup is reused, in milliseconds. Default five minutes. */
  discoveryTtlMs?: number
  /** Opens the live socket. Without it, `listen()` rejects and `sendLive()` uses HTTP. */
  socket?: SocketFactory
  /** How long the socket has to authenticate. Default 5000 ms. */
  liveAuthTimeoutMs?: number
  /** How long `sendLive()` waits for the server to confirm before it falls back to HTTP. Default 10000 ms. */
  liveAckTimeoutMs?: number
  /** Clock for envelopes and signal ids. Default `Date.now`. */
  now?: () => number
}

export interface SendOptions {
  /** Default `dm_inbox`. */
  box?: string
  /** The message id, usually the txid of the on-chain copy. Default: derived (see the module comment). */
  messageId?: string
}

export interface RawSendInput {
  /** Recipient identity key. */
  to: string
  box: string
  /** The exact body to store. */
  body: string
  messageId?: string
  /**
   * Wrap the body in the message box's own encryption layer
   * (`{ encryptedMessage }`), as older clients did. Default false: envelopes
   * are already encrypted.
   */
  encrypt?: boolean
}

export interface ListenOptions {
  /** Called with rows that are not an envelope or did not decrypt, so the app can acknowledge them. */
  onUnreadable?: (row: MessageBoxRow) => void
  /** Called when a handler throws or a row cannot be processed. */
  onError?: (error: unknown) => void
}

export interface DmClient {
  /** The configured host. */
  readonly host: string
  /** The user's identity key. */
  me(): Promise<string>
  /** Encrypt `text` to `to` and wrap it in an envelope from the user. */
  envelope(to: string, text: string, extra?: Record<string, unknown>): Promise<DmEnvelope>
  /** Decrypt an envelope the user sent or received (for example an on-chain copy). */
  openEnvelope(envelope: DmEnvelope): Promise<string>
  /** Build an envelope and deliver it. */
  send(to: string, text: string, options?: SendOptions & { extra?: Record<string, unknown> }): Promise<SendResult & { envelope: DmEnvelope }>
  /** Deliver an envelope that is already built, e.g. the one written on-chain, with `messageId` = its txid. */
  sendEnvelope(envelope: DmEnvelope, options?: SendOptions): Promise<SendResult>
  /** Deliver an arbitrary body. */
  sendRaw(input: RawSendInput): Promise<SendResult>
  /** The DMs waiting in a box, decrypted, in the box's order. Rows that do not open are left out. */
  list(box?: string): Promise<DmMessage[]>
  /** Every row waiting in a box, undecrypted. */
  listRows(box?: string): Promise<MessageBoxRow[]>
  /** Open one row. Null when it is not an envelope or does not decrypt. */
  openRow(row: MessageBoxRow): Promise<DmMessage | null>
  /**
   * Remove rows from the box, on every host the user uses. This deletes them
   * for all of the user's devices, so acknowledge what was shown, not what
   * was fetched.
   */
  ack(messageIds: readonly string[]): Promise<void>
  /** Receive a box live. Resolves to an unsubscribe function once the room is joined. */
  listen(box: string, onMessage: (message: DmMessage) => void, options?: ListenOptions): Promise<() => void>
  /** Deliver over the live socket, falling back to HTTP. */
  sendLive(input: { to: string; box: string; body: string; messageId?: string }): Promise<LiveSendResult>
  /** True while the live socket is connected and authenticated. */
  isLive(): boolean
  /** Tell `to` the user is typing. Only over a live socket that is already up; resolves false otherwise. */
  sendTyping(to: string): Promise<boolean>
  /** Tell `to` which of their messages were fetched or seen. Only over a live socket that is already up. */
  sendReceipt(to: string, state: ReceiptState, ids: readonly string[]): Promise<boolean>
  /** Close the live socket. */
  close(): void
}

// ── helpers ─────────────────────────────────────────────────────

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function bytesOf(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[]
  if (value instanceof Uint8Array) return Array.from(value)
  throw new DmError('invalid_response', 'the wallet returned bytes in an unknown format')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function requireBox(box: unknown): string {
  if (typeof box !== 'string' || !BOX_RE.test(box)) {
    throw new DmError('invalid_argument', 'box must be 1–64 letters, digits or underscores')
  }
  return box
}

function requireRecipient(to: unknown): string {
  if (!isIdentityKey(to)) throw new DmError('invalid_argument', 'recipient must be a compressed public key in hex')
  return to
}

/** Read a typing or receipt signal from an envelope's text. Null for anything else. */
export function parseSignal(text: string): DmSignal | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(v)) return null
  if (v.type === 'typing') return { type: 'typing' }
  if (v.type === 'receipt' && (v.state === 'fetched' || v.state === 'seen') && Array.isArray(v.ids)) {
    return { type: 'receipt', state: v.state, ids: v.ids.map(String) }
  }
  return null
}

// ── the client ──────────────────────────────────────────────────

export function createDmClient(options: DmClientOptions): DmClient {
  const { wallet, originator, socket: socketFactory } = options
  if (!wallet || typeof wallet.encrypt !== 'function') throw new DmError('invalid_argument', 'a BRC-100 wallet is required')
  const host = normalizeHost(options.host ?? DEFAULT_DM_HOST)
  const now = options.now ?? Date.now
  const discoveryTtl = options.discoveryTtlMs ?? DEFAULT_DISCOVERY_TTL_MS
  const authTimeout = options.liveAuthTimeoutMs ?? DEFAULT_LIVE_AUTH_TIMEOUT_MS
  const ackTimeout = options.liveAckTimeoutMs ?? DEFAULT_LIVE_ACK_TIMEOUT_MS
  const wopts = { originator }

  let authFetch = options.authFetch
  const transport = () => (authFetch ??= new AuthFetch(wallet, undefined, undefined, originator))

  let myKey: Promise<string> | undefined
  const me = (): Promise<string> => {
    myKey ??= identityKeyOf(wallet, wopts).catch((e: unknown) => {
      myKey = undefined
      throw e
    })
    return myKey
  }

  // ── HTTP ──

  async function post(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await transport().fetch(endpoint(base, path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new DmError('network', `could not reach the message box at ${base}`, { cause: e })
    }
    let data: unknown
    try {
      data = await res.json()
    } catch {
      data = undefined
    }
    const serverCode = isObject(data) && typeof data.code === 'string' ? data.code : undefined
    const description = isObject(data) && typeof data.description === 'string' ? data.description : undefined
    if (!res.ok) {
      throw new DmError('http', description ?? `the message box answered ${path} with HTTP ${res.status}`, {
        status: res.status,
        serverCode,
      })
    }
    if (!isObject(data)) throw new DmError('invalid_response', `the message box answered ${path} with something that is not JSON`, { status: res.status })
    if (data.status === 'error') {
      throw new DmError('server', description ?? `the message box refused ${path}`, { status: res.status, serverCode })
    }
    return data
  }

  // ── host discovery ──

  let resolver: Pick<LookupResolver, 'query'> | undefined
  const discovered = new Map<string, { at: number; hosts: string[] }>()

  async function advertisedHosts(identityKey: string): Promise<string[]> {
    if (options.lookup === false) return []
    const hit = discovered.get(identityKey)
    if (hit && now() - hit.at < discoveryTtl) return hit.hosts
    const hosts: string[] = []
    try {
      resolver ??= options.lookup ?? new LookupResolver({ networkPreset: 'mainnet' })
      const answer = await resolver.query({ service: 'ls_messagebox', query: { identityKey } })
      if (answer.type !== 'output-list') return []
      for (const out of answer.outputs) {
        try {
          const tx = Transaction.fromBEEF(out.beef)
          const script = tx.outputs[out.outputIndex]?.lockingScript
          if (!script) continue
          const hostField = PushDrop.decode(script).fields[1]
          if (!hostField || hostField.length === 0) continue
          const h = normalizeAdvertisedHost(Utils.toUTF8(hostField))
          if (h && !hosts.includes(h)) hosts.push(h)
        } catch {
          // not a readable advertisement: skip it, as the MessageBox client does
        }
      }
    } catch {
      return [] // lookup failed: use the configured host, and ask again next time
    }
    discovered.set(identityKey, { at: now(), hosts })
    return hosts
  }

  async function sendHost(recipient: string): Promise<string> {
    return (await advertisedHosts(recipient))[0] ?? host
  }

  async function myHosts(): Promise<string[]> {
    return Array.from(new Set([host, ...(await advertisedHosts(await me()))]))
  }

  // ── rows ──

  async function hmacId(body: string, recipient: string): Promise<string> {
    const { hmac } = await wallet.createHmac(
      {
        data: Array.from(new TextEncoder().encode(JSON.stringify(body))),
        protocolID: MESSAGEBOX_PROTOCOL,
        keyID: MESSAGEBOX_KEY_ID,
        counterparty: recipient,
      },
      originator,
    )
    return Utils.toHex(bytesOf(hmac))
  }

  /** Strip the box's `{ message }` storage wrapper and the older `{ encryptedMessage }` layer. */
  async function decodeBody(raw: unknown, sender: string): Promise<unknown> {
    const parsed = typeof raw === 'string' ? tryParse(raw) : raw
    let content = parsed
    if (isObject(parsed) && 'message' in parsed) {
      content = typeof parsed.message === 'string' ? tryParse(parsed.message) : parsed.message
    }
    if (isObject(content) && typeof content.encryptedMessage === 'string') {
      try {
        const { plaintext } = await wallet.decrypt(
          {
            ciphertext: Utils.toArray(content.encryptedMessage, 'base64'),
            protocolID: MESSAGEBOX_PROTOCOL,
            keyID: MESSAGEBOX_KEY_ID,
            counterparty: sender,
          },
          originator,
        )
        return tryParse(Utils.toUTF8(bytesOf(plaintext)))
      } catch {
        return null
      }
    }
    return content
  }

  async function toRow(m: unknown, box: string, from: string): Promise<MessageBoxRow | null> {
    if (!isObject(m) || m.messageId == null) return null
    const sender = typeof m.sender === 'string' ? m.sender : ''
    const row: MessageBoxRow = {
      messageId: String(m.messageId),
      sender,
      box,
      host: from,
      body: await decodeBody(m.body, sender),
    }
    if (typeof m.createdAt === 'string') row.createdAt = m.createdAt
    return row
  }

  async function openRow(row: MessageBoxRow): Promise<DmMessage | null> {
    const envelope = parseEnvelope(row.body)
    if (!envelope) return null
    // The box authenticated the sender; the envelope's `from` is only a claim.
    const counterparty = isIdentityKey(row.sender) ? row.sender : envelope.from
    let text: string
    try {
      text = await decryptText(wallet, envelope.ciphertext, counterparty, wopts)
    } catch {
      return null
    }
    const message: DmMessage = {
      messageId: row.messageId,
      sender: row.sender || envelope.from,
      box: row.box,
      host: row.host,
      text,
      sentAt: typeof envelope.sentAt === 'number' && envelope.sentAt ? envelope.sentAt : null,
      envelope,
    }
    if (row.createdAt) message.createdAt = row.createdAt
    return message
  }

  async function fetchPages(base: string, box: string): Promise<unknown[]> {
    const out: unknown[] = []
    let offset = 0
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const data = await post(base, '/listMessages', { messageBox: box, offset })
      if (!Array.isArray(data.messages)) {
        throw new DmError('invalid_response', 'the message box answered /listMessages without a messages list')
      }
      out.push(...data.messages)
      if (data.hasMore !== true) break
      const next = Number(data.nextOffset)
      const limit = Number(data.limit)
      offset = Number.isSafeInteger(next) && next > offset
        ? next
        : offset + (data.messages.length || (Number.isSafeInteger(limit) && limit > 0 ? limit : 1000))
    }
    return out
  }

  async function listRows(box: string = DM_BOX): Promise<MessageBoxRow[]> {
    requireBox(box)
    const hosts = await myHosts()
    const settled = await Promise.allSettled(hosts.map((h) => fetchPages(h, box)))
    const seen = new Set<string>()
    const rows: MessageBoxRow[] = []
    let answered = 0
    let firstError: unknown
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!
      if (s.status === 'rejected') {
        firstError ??= s.reason
        continue
      }
      answered++
      for (const m of s.value) {
        const row = await toRow(m, box, hosts[i]!)
        if (!row || seen.has(row.messageId)) continue
        seen.add(row.messageId)
        rows.push(row)
      }
    }
    if (answered === 0) throw firstError
    return rows
  }

  async function sendRaw(input: RawSendInput): Promise<SendResult> {
    const to = requireRecipient(input.to)
    const box = requireBox(input.box)
    if (typeof input.body !== 'string' || input.body.trim() === '') throw new DmError('invalid_argument', 'body must be a non-empty string')
    if (input.messageId !== undefined && (typeof input.messageId !== 'string' || input.messageId.trim() === '')) {
      throw new DmError('invalid_argument', 'messageId must be a non-empty string')
    }
    const messageId = input.messageId ?? (await hmacId(input.body, to))
    let message: Record<string, unknown>
    if (input.encrypt) {
      const { ciphertext } = await wallet.encrypt(
        { plaintext: Utils.toArray(input.body, 'utf8'), protocolID: MESSAGEBOX_PROTOCOL, keyID: MESSAGEBOX_KEY_ID, counterparty: to },
        originator,
      )
      const body = JSON.stringify({ encryptedMessage: Utils.toBase64(bytesOf(ciphertext)) })
      message = { recipient: to, messageBox: box, body, messageId }
    } else {
      // Same fields, in the same order, as peck.to's client sends.
      message = { recipient: to, messageBox: box, body: input.body, messageId, skipEncryption: true }
    }
    const target = await sendHost(to)
    await post(target, '/sendMessage', { message })
    return { messageId, host: target }
  }

  async function sendEnvelope(envelope: DmEnvelope, opts: SendOptions = {}): Promise<SendResult> {
    if (!parseEnvelope(envelope)) throw new DmError('invalid_argument', 'not a DM envelope')
    return sendRaw({ to: envelope.to, box: opts.box ?? DM_BOX, body: serializeEnvelope(envelope), messageId: opts.messageId })
  }

  async function envelope(to: string, text: string, extra?: Record<string, unknown>): Promise<DmEnvelope> {
    return buildEnvelope(wallet, { to, text, from: await me(), sentAt: now(), extra }, wopts)
  }

  async function ack(messageIds: readonly string[]): Promise<void> {
    if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.some((id) => typeof id !== 'string' || id === '')) {
      throw new DmError('invalid_argument', 'messageIds must be a non-empty list of ids')
    }
    const hosts = await myHosts()
    const settled = await Promise.allSettled(hosts.map((h) => post(h, '/acknowledgeMessage', { messageIds: [...messageIds] })))
    const ok = settled.some((s) => s.status === 'fulfilled')
    if (!ok) throw (settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason
  }

  // ── live ──

  type Subscriber = { onMessage: (m: DmMessage) => void } & ListenOptions
  let socket: LiveSocket | undefined
  let authed = false
  let authWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  const subscriptions = new Map<string, Set<Subscriber>>()
  const boundRooms = new Set<string>()
  const boundAcks = new Set<string>()
  const pendingAcks = new Map<string, Map<string, (ok: boolean) => void>>()

  function settleAuth(err?: unknown) {
    const waiters = authWaiters
    authWaiters = []
    for (const w of waiters) {
      if (err === undefined) w.resolve()
      else w.reject(err)
    }
  }

  async function ensureSocket(): Promise<LiveSocket> {
    if (!socketFactory) throw new DmError('no_socket', 'live delivery needs a socket factory (the `socket` option)')
    const identityKey = await me()
    if (!socket) {
      const s = socketFactory(host, { wallet, originator })
      socket = s
      s.on('connect', () => {
        authed = false
        s.emit('authenticated', { identityKey })
      })
      s.on('authenticationSuccess', () => {
        authed = true
        // After a reconnect the server has forgotten the rooms: join them again.
        for (const box of subscriptions.keys()) s.emit('joinRoom', `${identityKey}-${box}`)
        settleAuth()
      })
      s.on('authenticationFailed', () => {
        authed = false
        settleAuth(new DmError('live_unavailable', 'the message box refused the live socket'))
      })
      s.on('disconnect', () => {
        authed = false
      })
      if (s.connected) s.emit('authenticated', { identityKey })
    }
    const s = socket
    if (authed) return s
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        authWaiters = authWaiters.filter((w) => w.resolve !== done)
        reject(new DmError('live_unavailable', 'the live socket did not authenticate in time'))
      }, authTimeout)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      authWaiters.push({
        resolve: done,
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
    return s
  }

  async function dispatch(box: string, data: unknown) {
    const subs = subscriptions.get(box)
    if (!subs || subs.size === 0) return
    let row: MessageBoxRow | null = null
    let message: DmMessage | null = null
    try {
      row = await toRow(data, box, host)
      if (row) message = await openRow(row)
    } catch (e) {
      for (const s of subs) s.onError?.(e)
      return
    }
    if (!row) return
    for (const s of subs) {
      try {
        if (message) s.onMessage(message)
        else s.onUnreadable?.(row)
      } catch (e) {
        s.onError?.(e)
      }
    }
  }

  async function listen(box: string, onMessage: (m: DmMessage) => void, opts: ListenOptions = {}): Promise<() => void> {
    requireBox(box)
    if (typeof onMessage !== 'function') throw new DmError('invalid_argument', 'onMessage must be a function')
    const s = await ensureSocket()
    const identityKey = await me()
    const room = `${identityKey}-${box}`
    const eventName = `sendMessage-${room}`
    if (!boundRooms.has(eventName)) {
      boundRooms.add(eventName)
      s.on(eventName, (data: unknown) => {
        void dispatch(box, data)
      })
    }
    let subs = subscriptions.get(box)
    if (!subs) {
      subs = new Set()
      subscriptions.set(box, subs)
      s.emit('joinRoom', room)
    }
    const sub: Subscriber = { onMessage, ...opts }
    subs.add(sub)
    return () => {
      const set = subscriptions.get(box)
      if (!set) return
      set.delete(sub)
      if (set.size === 0) {
        subscriptions.delete(box)
        if (socket === s) s.emit('leaveRoom', room)
      }
    }
  }

  function awaitAck(s: LiveSocket, roomId: string, messageId: string): Promise<boolean> {
    const event = `sendMessageAck-${roomId}`
    if (!boundAcks.has(event)) {
      boundAcks.add(event)
      s.on(event, (resp: unknown) => {
        const waiting = pendingAcks.get(roomId)
        if (!waiting || waiting.size === 0) return
        const id = isObject(resp) && typeof resp.messageId === 'string' ? resp.messageId : undefined
        const key = id !== undefined && waiting.has(id) ? id : id === undefined ? waiting.keys().next().value : undefined
        if (key === undefined) return
        const settle = waiting.get(key)!
        waiting.delete(key)
        settle(isObject(resp) && resp.status === 'success')
      })
    }
    return new Promise<boolean>((resolve) => {
      let waiting = pendingAcks.get(roomId)
      if (!waiting) pendingAcks.set(roomId, (waiting = new Map()))
      const timer = setTimeout(() => {
        waiting!.delete(messageId)
        resolve(false)
      }, ackTimeout)
      waiting.set(messageId, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
    })
  }

  async function sendLive(input: { to: string; box: string; body: string; messageId?: string }): Promise<LiveSendResult> {
    const to = requireRecipient(input.to)
    const box = requireBox(input.box)
    if (typeof input.body !== 'string' || input.body.trim() === '') throw new DmError('invalid_argument', 'body must be a non-empty string')
    const messageId = input.messageId ?? (await hmacId(input.body, to))
    let s: LiveSocket | undefined
    if (socketFactory) {
      try {
        s = await ensureSocket()
      } catch {
        s = undefined
      }
    }
    if (s && s.connected && authed) {
      const roomId = `${to}-${box}`
      const confirmed = awaitAck(s, roomId, messageId)
      s.emit('sendMessage', { roomId, message: { messageId, recipient: to, body: input.body } })
      if (await confirmed) return { messageId, host, via: 'live' }
    }
    return { ...(await sendRaw({ to, box, body: input.body, messageId })), via: 'http' }
  }

  const isLive = () => !!socket && socket.connected && authed

  async function sendSignal(to: string, box: string, prefix: string, signal: DmSignal): Promise<boolean> {
    requireRecipient(to)
    if (!isLive()) return false
    const env = await envelope(to, JSON.stringify(signal))
    const messageId = prefix + now().toString(36) + Utils.toHex(Random(3))
    await sendLive({ to, box, body: serializeEnvelope(env), messageId })
    return true
  }

  return {
    host,
    me,
    envelope,
    openEnvelope: async (env) => openEnvelope(wallet, env, { ...wopts, me: await me() }),
    send: async (to, text, opts = {}) => {
      const env = await envelope(to, text, opts.extra)
      const result = await sendEnvelope(env, opts)
      return { ...result, envelope: env }
    },
    sendEnvelope,
    sendRaw,
    list: async (box = DM_BOX) => {
      const out: DmMessage[] = []
      for (const row of await listRows(box)) {
        const m = await openRow(row)
        if (m) out.push(m)
      }
      return out
    },
    listRows,
    openRow,
    ack,
    listen,
    sendLive,
    isLive,
    sendTyping: (to) => sendSignal(to, TYPING_BOX, 't', { type: 'typing' }),
    sendReceipt: async (to, state, ids) => {
      if (state !== 'fetched' && state !== 'seen') throw new DmError('invalid_argument', 'state must be fetched or seen')
      if (!Array.isArray(ids) || ids.length === 0) throw new DmError('invalid_argument', 'ids must be a non-empty list')
      return sendSignal(to, RECEIPT_BOX, 'r', { type: 'receipt', state, ids: ids.map(String) })
    },
    close: () => {
      const s = socket
      socket = undefined
      authed = false
      boundRooms.clear()
      boundAcks.clear()
      subscriptions.clear()
      for (const waiting of pendingAcks.values()) for (const settle of waiting.values()) settle(false)
      pendingAcks.clear()
      settleAuth(new DmError('live_unavailable', 'the client was closed'))
      s?.disconnect()
    },
  }
}
