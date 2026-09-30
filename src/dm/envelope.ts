/**
 * DM envelopes: the encrypted unit peck.to clients exchange.
 *
 * ── The envelope ──────────────────────────────────────────────────────────
 * A JSON object, serialized with its keys in this order:
 *
 *   { "v": 1, "from": <sender identity key>, "to": <recipient identity key>,
 *     "ciphertext": <base64>, "sentAt": <unix milliseconds>, ...extra }
 *
 * `from` and `to` are compressed identity public keys (hex). `extra` fields,
 * when present, follow `sentAt` (group messages carry `group_id` and `epoch`).
 *
 * ── The encryption ────────────────────────────────────────────────────────
 * `ciphertext` is the base64 of what the sender's BRC-100 wallet returns from
 * `encrypt` over the UTF-8 bytes of the text, with protocol [2, 'peck dm'],
 * key ID '1' and counterparty = the recipient's identity key. That is BRC-2
 * encryption under a BRC-42 key both sides can derive: the recipient decrypts
 * with counterparty = the sender, and the sender can read its own message
 * back with counterparty = the recipient. The SDK never holds a key; it only
 * calls the wallet.
 *
 * ── Where envelopes travel ────────────────────────────────────────────────
 * The same serialized envelope goes to the recipient's message box (see
 * `createDmClient`) and, when the sender keeps a permanent copy, into an
 * on-chain Bitcoin Schema message (`envelopeMessage`) whose B content is the
 * envelope JSON. The transaction id doubles as the message box message id,
 * which is how clients tell the two copies of one message apart.
 */
import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { PIPE, PROTO_B, PROTO_MAP, payload, type SchemaPayload } from '../schema/bitcom.js'
import { DmError } from './errors.js'

/** BRC-42 protocol of the envelope key (security level 2: per counterparty). */
export const DM_PROTOCOL: WalletProtocol = [2, 'peck dm']
/** Key ID of the envelope key. */
export const DM_KEY_ID = '1'
/** The envelope version this SDK writes. */
export const DM_ENVELOPE_VERSION = 1

/** Keys an `extra` field may not use, because the envelope defines them. */
const RESERVED = new Set(['v', 'from', 'to', 'ciphertext', 'sentAt'])
const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/

/** A DM envelope (see the module comment). */
export interface DmEnvelope {
  v: number
  from: string
  to: string
  ciphertext: string
  /** Unix milliseconds on the sender's clock. Absent in some old envelopes. */
  sentAt?: number
  [extra: string]: unknown
}

/** The wallet calls envelopes need; any BRC-100 `WalletInterface` has them. */
export type DmWallet = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>

export interface WalletCallOptions {
  /** Passed to the wallet as the calling app's originator, when set. */
  originator?: string
}

export interface BuildEnvelopeInput {
  /** Recipient identity key. */
  to: string
  /** The message text (for signals and group posts, a JSON string). */
  text: string
  /** Sender identity key. Default: the wallet's identity key. */
  from?: string
  /** Default `Date.now()`. */
  sentAt?: number
  /** Extra fields written after `sentAt`, in order. */
  extra?: Record<string, unknown>
}

/** True for a compressed secp256k1 public key in hex. */
export function isIdentityKey(value: unknown): value is string {
  return typeof value === 'string' && PUBKEY_RE.test(value)
}

function requireKey(name: string, value: unknown): string {
  if (!isIdentityKey(value)) throw new DmError('invalid_argument', `${name} must be a compressed public key in hex`)
  return value
}

function bytesOf(value: unknown, what: string): number[] {
  if (Array.isArray(value)) return value as number[]
  if (value instanceof Uint8Array) return Array.from(value)
  throw new DmError('invalid_envelope', `the wallet returned ${what} in an unknown format`)
}

/** The wallet's identity key. */
export async function identityKeyOf(wallet: Pick<WalletInterface, 'getPublicKey'>, opts: WalletCallOptions = {}): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true }, opts.originator)
  return requireKey('the wallet identity key', publicKey)
}

/** Encrypt `text` for `counterparty` under the envelope key. Returns base64. */
export async function encryptText(
  wallet: Pick<WalletInterface, 'encrypt'>,
  text: string,
  counterparty: string,
  opts: WalletCallOptions = {},
): Promise<string> {
  requireKey('counterparty', counterparty)
  const { ciphertext } = await wallet.encrypt(
    { plaintext: Utils.toArray(text, 'utf8'), protocolID: DM_PROTOCOL, keyID: DM_KEY_ID, counterparty },
    opts.originator,
  )
  return Utils.toBase64(bytesOf(ciphertext, 'ciphertext'))
}

/**
 * Decrypt a base64 envelope ciphertext exchanged with `counterparty` (the
 * other party: the sender for a received message, the recipient for one's
 * own). Throws a `DmError` (`invalid_envelope`) when it does not decrypt.
 */
export async function decryptText(
  wallet: Pick<WalletInterface, 'decrypt'>,
  ciphertext: string,
  counterparty: string,
  opts: WalletCallOptions = {},
): Promise<string> {
  requireKey('counterparty', counterparty)
  let plaintext: unknown
  try {
    const bytes = Utils.toArray(ciphertext, 'base64')
    ;({ plaintext } = await wallet.decrypt(
      { ciphertext: bytes, protocolID: DM_PROTOCOL, keyID: DM_KEY_ID, counterparty },
      opts.originator,
    ))
  } catch (e) {
    throw new DmError('invalid_envelope', 'the envelope did not decrypt for this counterparty', { cause: e })
  }
  return Utils.toUTF8(bytesOf(plaintext, 'plaintext'))
}

/** Encrypt `text` and wrap it in an envelope. */
export async function buildEnvelope(wallet: DmWallet, input: BuildEnvelopeInput, opts: WalletCallOptions = {}): Promise<DmEnvelope> {
  const to = requireKey('to', input.to)
  if (typeof input.text !== 'string') throw new DmError('invalid_argument', 'text must be a string')
  for (const k of Object.keys(input.extra ?? {})) {
    if (RESERVED.has(k)) throw new DmError('invalid_argument', `extra may not set the envelope field "${k}"`)
  }
  const from = input.from === undefined ? await identityKeyOf(wallet, opts) : requireKey('from', input.from)
  const ciphertext = await encryptText(wallet, input.text, to, opts)
  const sentAt = input.sentAt ?? Date.now()
  return { v: DM_ENVELOPE_VERSION, from, to, ciphertext, sentAt, ...input.extra }
}

/**
 * Read an envelope from a parsed object or a JSON string. Returns null for
 * anything that is not one: `v` a number, `ciphertext`, `from` and `to`
 * non-empty strings. Extra fields are kept.
 */
export function parseEnvelope(value: unknown): DmEnvelope | null {
  let v: unknown = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const e = v as Record<string, unknown>
  const str = (x: unknown) => typeof x === 'string' && x.length > 0
  if (typeof e.v !== 'number' || !str(e.ciphertext) || !str(e.from) || !str(e.to)) return null
  if (e.sentAt !== undefined && typeof e.sentAt !== 'number') return null
  return e as DmEnvelope
}

/**
 * The other party of an envelope from `me`'s point of view: the recipient of
 * one's own message, the sender of anyone else's. Keys compare
 * case-insensitively.
 */
export function envelopePeer(envelope: DmEnvelope, me: string): string {
  return envelope.from.toLowerCase() === me.toLowerCase() ? envelope.to : envelope.from
}

export interface OpenEnvelopeOptions extends WalletCallOptions {
  /**
   * The key to decrypt with. For a message box row, the sender the box
   * authenticated. Default: the other party, from `me`.
   */
  counterparty?: string
  /** The reader's identity key. Default: the wallet's. Unused when `counterparty` is set. */
  me?: string
}

/** Decrypt an envelope's text. Throws a `DmError` (`invalid_envelope`) when it does not open. */
export async function openEnvelope(
  wallet: Pick<WalletInterface, 'getPublicKey' | 'decrypt'>,
  envelope: DmEnvelope,
  opts: OpenEnvelopeOptions = {},
): Promise<string> {
  const counterparty = opts.counterparty ?? envelopePeer(envelope, opts.me ?? (await identityKeyOf(wallet, opts)))
  return decryptText(wallet, envelope.ciphertext, counterparty, opts)
}

/** The serialized envelope: exactly the bytes clients send and write on-chain. */
export function serializeEnvelope(envelope: DmEnvelope): string {
  return JSON.stringify(envelope)
}

/**
 * The on-chain copy of an envelope: a Bitcoin Schema message to the
 * recipient, laid out as peck.to writes it:
 *
 *   PROTO_B <serialized envelope> "text/plain" "UTF-8" |
 *   PROTO_MAP SET app <app> type message context bapID bapID <recipient>
 *
 * The encoding is written "UTF-8" (upper case), as peck.to's DM writer does;
 * `message()` in the `schema` module writes "utf-8", as its post and channel
 * writers do. Sign the payload with `signPayload` like any other.
 */
export function envelopeMessage(envelope: DmEnvelope, opts: { app?: string } = {}): SchemaPayload {
  if (!parseEnvelope(envelope)) throw new DmError('invalid_argument', 'not a DM envelope')
  const app = opts.app ?? 'peck.to'
  if (app.length === 0 || app === PIPE) throw new DmError('invalid_argument', 'app must be a non-empty name')
  return payload([
    PROTO_B, serializeEnvelope(envelope), 'text/plain', 'UTF-8', PIPE,
    PROTO_MAP, 'SET', 'app', app, 'type', 'message', 'context', 'bapID', 'bapID', envelope.to,
  ])
}
