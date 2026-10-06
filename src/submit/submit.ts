/**
 * `submitToOverlay()`: send a signed transaction from the browser to the
 * overlay, so it is admitted and indexed now instead of when a chain scan
 * reaches it.
 *
 * What it sends: `POST {overlay}/submit`, the overlay engine's BRC-22 entry
 * point. The body is the transaction as BEEF (the wallet's Atomic BEEF from
 * `createAction` works as is), `content-type: application/octet-stream`, and
 * the topics in an `x-topics` header as a JSON array. The overlay checks the
 * merkle proofs, asks each topic's manager which outputs it admits, then
 * answers with the admittance result (a STEAK: topic to admitted output
 * indexes) and indexes the admitted outputs.
 *
 * Why `/submit` and not `/submit-tx`: `/submit-tx` skips the engine, so it
 * checks no proofs, asks no topic manager and indexes every OP_RETURN output
 * it finds, and identity records (profile, handle, key binding, friend) are
 * not dispatched at all. `/submit` is the path the rest of peck.to uses.
 *
 * The overlay answers as soon as the admittance result is ready and indexes
 * right after, so a read of the same record immediately afterwards can still
 * come back empty. Render the new record optimistically.
 *
 * This is not a broadcaster: the user's wallet pays for and broadcasts the
 * transaction (`createAction`). The overlay broadcasts too when it has not been
 * seen yet, and treats "already known" as fine.
 */
import { OverlaySubmitError } from './errors.js'

// Not imported from the read client: that would pull its whole bundle into the page that submits.
const DEFAULT_OVERLAY_URL = 'https://overlay.peck.to'

/**
 * The overlay topics a browser client writes to. The overlay runs more
 * (`GET /listTopicManagers`); these are the ones the SDK's builders target.
 */
export const OVERLAY_TOPICS = {
  /**
   * Bitcoin Schema social records: post, reply, quote, repost, like, unlike,
   * follow, unfollow, message, payment (tip) and the older `profile`. The
   * default.
   */
  content: 'tm_social-content',
  /** The same topic manager under its old name. Same admission, kept for old submitters. */
  contentLegacy: 'peck-schema',
  /** The peck-identity-v1 profile written by `identityProfile()`. */
  identityProfile: 'tm_identity-profile',
  /** An identity handle claim. */
  identityHandle: 'tm_identity-handle',
  /** A key binding (links a signing key to an identity key). */
  keyBinding: 'tm_key-binding',
  /** A friend request or a withdrawal. */
  friend: 'tm_social-friend',
} as const

export type OverlayTopic = (typeof OVERLAY_TOPICS)[keyof typeof OVERLAY_TOPICS]

/** How long the overlay has to answer. It verifies proofs and may broadcast first, so this is generous. */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000

/** What one topic did with the transaction. */
export interface TopicAdmittance {
  /** Indexes of the transaction's outputs that the topic admitted. */
  outputsToAdmit: number[]
  /** Indexes of inputs the topic kept as coins. Social records spend none. */
  coinsToRetain: number[]
  /** Indexes of inputs whose coins the topic dropped, when the overlay says. */
  coinsRemoved?: number[]
}

/** The overlay's admittance result: one entry per topic that was submitted. */
export type Steak = Record<string, TopicAdmittance>

/**
 * A transaction object from `@bsv/sdk` whose inputs are linked to their source
 * transactions (and so, up the chain, to merkle proofs). Anything with these
 * two methods works, and the SDK is not imported here.
 */
export interface TransactionLike {
  toAtomicBEEF(): number[]
  id(encoding: 'hex'): string
}

/** The part of a BRC-100 `createAction` result that matters here. `tx` is Atomic BEEF. */
export interface ActionResultLike {
  txid?: string
  tx?: number[] | Uint8Array
}

/**
 * What can be submitted:
 *  - BEEF or Atomic BEEF as bytes (`Uint8Array` or `number[]`) or as hex;
 *  - a `Transaction` whose inputs carry their source transactions;
 *  - the whole result of `wallet.createAction()`.
 * A raw transaction without its ancestors is not enough: the overlay needs the
 * merkle proofs to admit it.
 */
export type SubmitInput = Uint8Array | readonly number[] | string | TransactionLike | ActionResultLike

export interface SubmitOptions {
  /** Topics to submit to. Default `[OVERLAY_TOPICS.content]`. Use `OVERLAY_TOPICS` for the names. */
  topics?: readonly string[]
  /** Overlay base URL. Default `https://overlay.peck.to`. */
  overlayUrl?: string
  /** fetch to use. Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Milliseconds the overlay has to answer. Default 30000; 0 for no limit. */
  timeoutMs?: number
  /**
   * Aborts the request. The call then rejects with the signal's own reason,
   * exactly like `fetch`, not with an `OverlaySubmitError`.
   */
  signal?: AbortSignal
  /**
   * Throw `not_admitted` when no topic admitted any output. Default true.
   * Set it to false to submit a transaction the overlay may already have: it
   * answers a repeat submission with an empty result, which looks the same as
   * a refusal.
   */
  requireAdmission?: boolean
}

export interface SubmitResult {
  /** The transaction id, when it could be known from the input. */
  txid?: string
  /** The topics that were submitted. */
  topics: string[]
  /** The overlay's admittance result, as it sent it. */
  steak: Steak
  /** True when at least one topic admitted at least one output. */
  admitted: boolean
  /** The topics that admitted at least one output. */
  admittedTopics: string[]
}

// ── input ───────────────────────────────────────────────────────

const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/
// Printable ASCII, no spaces: topic names go in an HTTP header.
const TOPIC_RE = /^[\x21-\x7e]+$/

function bad(message: string, cause?: unknown): OverlaySubmitError {
  return new OverlaySubmitError('invalid_input', message, cause === undefined ? {} : { cause })
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim()
  if (!HEX_RE.test(clean)) throw bad('the transaction string is not hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Hex of the bytes in reverse order: a txid is shown in the reverse of the order it is hashed and stored in. */
function toHexReversed(bytes: Uint8Array): string {
  let s = ''
  for (let i = bytes.length - 1; i >= 0; i--) s += (bytes[i] as number).toString(16).padStart(2, '0')
  return s
}

function fromNumbers(values: readonly number[]): Uint8Array {
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0 || v > 255) throw bad('the transaction array holds a value that is not a byte')
  }
  return Uint8Array.from(values)
}

/** BEEF V1, BEEF V2 and Atomic BEEF (BRC-95) start with these four bytes. */
function beefKind(bytes: Uint8Array): 'v1' | 'v2' | 'atomic' | null {
  if (bytes.length < 4) return null
  const [a, b, c, d] = bytes as unknown as [number, number, number, number]
  if (c === 0xbe && d === 0xef && b === 0x00) {
    if (a === 0x01) return 'v1'
    if (a === 0x02) return 'v2'
  }
  if (a === 0x01 && b === 0x01 && c === 0x01 && d === 0x01) return 'atomic'
  return null
}

function resolveInput(input: SubmitInput): { bytes: Uint8Array; txid?: string } {
  let bytes: Uint8Array
  let txid: string | undefined
  if (typeof input === 'string') {
    bytes = fromHex(input)
  } else if (input instanceof Uint8Array) {
    bytes = input
  } else if (Array.isArray(input)) {
    bytes = fromNumbers(input as readonly number[])
  } else if (input !== null && typeof input === 'object') {
    const tx = input as Partial<TransactionLike>
    if (typeof tx.toAtomicBEEF === 'function') {
      try {
        bytes = Uint8Array.from(tx.toAtomicBEEF())
        txid = typeof tx.id === 'function' ? tx.id('hex') : undefined
      } catch (e) {
        throw bad(`the transaction cannot be written as BEEF (are its source transactions linked?): ${(e as Error)?.message ?? e}`, e)
      }
    } else {
      const action = input as ActionResultLike
      if (action.tx === undefined || action.tx === null) {
        throw new OverlaySubmitError(
          'no_transaction',
          'the wallet result has no transaction to submit (the wallet kept it, or only returned the txid)',
          action.txid === undefined ? {} : { txid: action.txid },
        )
      }
      bytes = action.tx instanceof Uint8Array ? action.tx : fromNumbers(action.tx)
      txid = action.txid
    }
  } else {
    throw bad('submit a BEEF (bytes or hex), a Transaction, or a createAction result')
  }

  const kind = beefKind(bytes)
  if (kind === null) {
    throw bad('this is not BEEF: the overlay needs the transaction with its merkle proofs, not a raw transaction')
  }
  // BRC-95 stores the subject txid right after the marker, in internal byte order (reversed from how it is shown).
  if (kind === 'atomic' && bytes.length >= 36) txid = toHexReversed(bytes.subarray(4, 36))
  return txid === undefined ? { bytes } : { bytes, txid }
}

function resolveTopics(topics: readonly string[] | undefined): string[] {
  if (topics === undefined) return [OVERLAY_TOPICS.content]
  if (!Array.isArray(topics) || topics.length === 0) throw bad('topics must be a non-empty array')
  const out: string[] = []
  for (const t of topics as unknown[]) {
    if (typeof t !== 'string' || !TOPIC_RE.test(t)) throw bad(`not a topic name: ${JSON.stringify(t)}`)
    if (!out.includes(t)) out.push(t)
  }
  return out
}

// ── output ──────────────────────────────────────────────────────

function isIntArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => Number.isInteger(n))
}

/** The overlay's STEAK, or null when the body is not one. */
function parseSteak(body: unknown): Steak | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const steak: Steak = {}
  for (const [topic, value] of Object.entries(body)) {
    if (value === null || typeof value !== 'object') return null
    const v = value as Record<string, unknown>
    if (!isIntArray(v.outputsToAdmit)) return null
    steak[topic] = {
      outputsToAdmit: v.outputsToAdmit,
      coinsToRetain: isIntArray(v.coinsToRetain) ? v.coinsToRetain : [],
      ...(isIntArray(v.coinsRemoved) ? { coinsRemoved: v.coinsRemoved } : {}),
    }
  }
  return Object.keys(steak).length > 0 ? steak : null
}

function errorText(body: unknown, raw: string): string | undefined {
  if (body && typeof body === 'object') {
    const e = (body as { error?: unknown }).error
    if (typeof e === 'string' && e) return e
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  }
  const text = raw.trim()
  return text ? text.slice(0, 200) : undefined
}

function httpError(status: number, detail: string | undefined, txid: string | undefined): OverlaySubmitError {
  const base = txid === undefined ? { status } : { status, txid }
  const msg = detail ?? `overlay answered HTTP ${status}`
  if (/does not support this topic/i.test(msg)) return new OverlaySubmitError('unsupported_topic', msg, base)
  // The engine's "Unable to verify SPV information." and the SDK's verify() messages
  // ("Invalid merkle path for transaction <txid>", "Verification failed because ...").
  if (/\bSPV\b|merkle path|merkle proof|Verification failed/i.test(msg)) return new OverlaySubmitError('spv_failed', msg, base)
  return new OverlaySubmitError(status >= 500 ? 'server' : 'rejected', msg, base)
}

// ── the call ────────────────────────────────────────────────────

/**
 * Submit a signed transaction to the overlay.
 *
 *   const action = await wallet.createAction({ description: 'Post', outputs })
 *   const result = await submitToOverlay(action)
 *   result.admittedTopics // ['tm_social-content']
 *
 * Resolves with the overlay's admittance result. Rejects with an
 * `OverlaySubmitError` (see its `code`) when the request cannot be made, the
 * overlay refuses it, or no topic admits anything.
 */
export async function submitToOverlay(input: SubmitInput, options: SubmitOptions = {}): Promise<SubmitResult> {
  const { bytes, txid } = resolveInput(input)
  const topics = resolveTopics(options.topics)
  const baseUrl = options.overlayUrl ?? DEFAULT_OVERLAY_URL
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw bad('overlayUrl must be a URL string')
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/submit`
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS
  const doFetch = options.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(i, init))
  const withTxid = txid === undefined ? {} : { txid }

  const outer = options.signal
  if (outer?.aborted) throw outer.reason
  const ctrl = new AbortController()
  let timedOut = false
  const onAbort = () => ctrl.abort(outer?.reason)
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    : undefined

  const fail = (e: unknown): never => {
    if (outer?.aborted) throw outer.reason
    if (timedOut) {
      throw new OverlaySubmitError('timeout', `no answer from ${url} within ${timeoutMs} ms`, { ...withTxid, cause: e })
    }
    throw new OverlaySubmitError('network', `could not reach ${url}: ${(e as Error)?.message ?? e}`, { ...withTxid, cause: e })
  }

  try {
    let res: Response
    let text: string
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-topics': JSON.stringify(topics),
          accept: 'application/json',
        },
        body: bytes as BodyInit,
        signal: ctrl.signal,
      })
      text = await res.text()
    } catch (e) {
      return fail(e)
    }

    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }

    if (!res.ok) throw httpError(res.status, errorText(parsed, text), txid)

    const steak = parseSteak(parsed)
    if (steak === null) {
      throw new OverlaySubmitError('invalid_response', `unexpected answer from ${url}: not an admittance result`, {
        status: res.status,
        ...withTxid,
      })
    }
    const admittedTopics = Object.keys(steak).filter((t) => (steak[t]?.outputsToAdmit.length ?? 0) > 0)
    const admitted = admittedTopics.length > 0
    if (!admitted && options.requireAdmission !== false) {
      throw new OverlaySubmitError(
        'not_admitted',
        `the overlay took the transaction but ${topics.join(', ')} admitted none of its outputs (it is not a record they index, or the overlay already had it)`,
        { status: res.status, steak, ...withTxid },
      )
    }
    return { ...withTxid, topics, steak, admitted, admittedTopics }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}
