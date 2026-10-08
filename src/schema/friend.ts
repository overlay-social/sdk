/**
 * Friend records: the mutual-consent friendship layer the overlay indexes in
 * the topic `tm_social-friend`. A port of the peck.to v1 client's friend
 * request / withdraw flow, byte for byte.
 *
 * Friendship is two one-way records, each signed by its own sender:
 *
 *   friend(A -> B)    A asks, or, if B already asked, accepts
 *   friend(B -> A)    B accepts (or asks)
 *   unfriend(A -> B)  A withdraws A's side
 *
 * The relation is active only while both directions are admitted and not
 * withdrawn. One side alone is a pending request; `getFriends()` in the read
 * client reports `mutual`, `pendingIn` and `pendingOut`. A record can only
 * speak for its own sender: the overlay checks the signature against
 * `identity`, so nobody can declare or withdraw someone else's side.
 *
 * Both keys are identity roots (the wallet's identity key), not posting keys.
 * The record carries consent and discovery only, no key material: a direct
 * message is encrypted with BRC-42 between the two identity keys anyway.
 *
 * ── The record ────────────────────────────────────────────────────────────
 * One OP_FALSE OP_RETURN output, MAP only, no `|` and no AIP section:
 *
 *   PROTO_MAP SET app <app> type friend|unfriend schema_version 1
 *     identity <sender identity key> peer <peer identity key> serial <hex> sig <hex>
 *
 * ── The signature ─────────────────────────────────────────────────────────
 * A BRC-3 signature, publicly verifiable, over the canonical preimage: the
 * fields up to and including `serial`, as JSON with sorted keys and no
 * whitespace, UTF-8 encoded.
 *
 *   createSignature({ data: preimage, protocolID: [1, 'friend'], keyID: serial,
 *                     counterparty: 'anyone' })
 *
 * `counterparty: 'anyone'` is the wallet default; it is sent explicitly here.
 */
import { PrivateKey, PublicKey, Random, Signature, Utils, type LockingScript, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { PIPE, PROTO_MAP, SchemaError, opReturnPushes, payload, type SchemaPayload } from './bitcom.js'
import { signatureBytes } from './aip.js'

/** The MAP `app` v1 writes for friend records. */
export const FRIEND_APP = 'overlay.social'
/** BRC-43 protocol of the friend signature. */
export const FRIEND_PROTOCOL: WalletProtocol = [1, 'friend']
export const FRIEND_SCHEMA_VERSION = '1'

// The fields the signature covers, in the order the record writes them; `sig` follows.
const PREIMAGE_KEYS = ['app', 'type', 'schema_version', 'identity', 'peer', 'serial'] as const

const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/
const SERIAL_RE = /^[0-9a-f]{8,64}$/

/** The two wallet calls a friend record needs; any BRC-100 `WalletInterface` has them. */
export type FriendWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

export interface FriendInput {
  /** The other side's identity key (compressed, 66 hex characters). Not a posting key or an address. */
  peer: string
  /** MAP `app`. Default "overlay.social", as v1. */
  app?: string
  /**
   * The signature's key ID: 8 to 64 lowercase hex characters. Default: 8
   * random bytes, hex (as v1). Fix it only for reproducible output.
   */
  serial?: string
}

export interface FriendOptions {
  wallet: FriendWallet
  /** Passed to the wallet as the calling app's originator, when set. */
  originator?: string
}

/** A signed friend or unfriend record: the payload (use `toLockingScript()`) and the fields it carries. */
export interface FriendRecord extends SchemaPayload {
  /** Every MAP field written, including `sig`. */
  readonly fields: Readonly<Record<string, string>>
}

/**
 * The canonical preimage the sender signs: the fields (all but `sig`) as
 * JSON with sorted keys, UTF-8 encoded.
 */
export function friendPreimage(fields: Readonly<Record<string, string | undefined>>): number[] {
  const core: Record<string, string> = {}
  for (const k of PREIMAGE_KEYS) {
    const v = fields[k]
    if (v !== undefined) core[k] = v
  }
  return Utils.toArray(JSON.stringify(core, Object.keys(core).sort()), 'utf8')
}

/** The key an 'anyone' verifier derives for a friend signature (BRC-42 with the 'anyone' key). */
function signingKey(identity: string, serial: string): PublicKey {
  const [level, name] = FRIEND_PROTOCOL
  return PublicKey.fromString(identity).deriveChild(new PrivateKey(1), `${level}-${name}-${serial}`)
}

function signatureValid(fields: Readonly<Record<string, string>>): boolean {
  const { identity, serial, sig } = fields
  if (!identity || !PUBKEY_RE.test(identity) || !serial || !sig || sig.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(sig)) return false
  try {
    return signingKey(identity, serial).verify(friendPreimage(fields), Signature.fromDER(Utils.toArray(sig, 'hex')))
  } catch {
    return false
  }
}

function app(v: string | undefined): string {
  if (v === undefined || v === null || v === '') return FRIEND_APP
  if (typeof v !== 'string') throw new SchemaError('app must be a string')
  if (v === PIPE) throw new SchemaError('app cannot be "|"')
  return v
}

const toHex = (bytes: readonly number[]) => Utils.toHex([...bytes])

async function build(type: 'friend' | 'unfriend', input: FriendInput, opts: FriendOptions): Promise<FriendRecord> {
  const peer = typeof input.peer === 'string' ? input.peer.trim().toLowerCase() : ''
  if (!PUBKEY_RE.test(peer)) {
    throw new SchemaError('peer must be an identity key: 66 hex characters starting with 02 or 03')
  }
  const serial = input.serial ?? toHex(Random(8))
  if (!SERIAL_RE.test(serial)) throw new SchemaError('serial must be 8 to 64 lowercase hex characters')

  const { publicKey } = await opts.wallet.getPublicKey({ identityKey: true }, opts.originator)
  if (typeof publicKey !== 'string' || !PUBKEY_RE.test(publicKey)) {
    throw new SchemaError('the wallet did not return its identity key')
  }
  const identity = publicKey.toLowerCase()
  // The overlay drops a record where both sides are the same key.
  if (identity === peer) throw new SchemaError('peer is the wallet identity key: a friend record needs two different keys')

  const fields: Record<string, string> = {
    app: app(input.app),
    type,
    schema_version: FRIEND_SCHEMA_VERSION,
    identity,
    peer,
    serial,
  }
  const { signature } = await opts.wallet.createSignature(
    { data: friendPreimage(fields), protocolID: FRIEND_PROTOCOL, keyID: serial, counterparty: 'anyone' },
    opts.originator,
  )
  fields.sig = toHex(signatureBytes(signature))
  if (!signatureValid(fields)) {
    throw new SchemaError('the wallet signature does not verify against the identity key it reported')
  }

  const pushes: string[] = [PROTO_MAP, 'SET']
  for (const k of [...PREIMAGE_KEYS, 'sig'] as const) pushes.push(k, fields[k]!)
  return { ...payload(pushes), fields }
}

/**
 * A friend request, or the accept of one: this wallet's identity says it
 * consents to being friends with `peer`. The wallet shows the signature
 * request; nothing is sent. Give the script to `createAction` (one
 * zero-satoshi output) and submit the transaction with `submitToOverlay()` to
 * the topic `tm_social-friend`.
 *
 *   const rec = await friend({ peer: peerIdentityKey }, { wallet })
 *   const action = await wallet.createAction({
 *     description: 'Friend request',
 *     outputs: [{ lockingScript: toLockingScript(rec).toHex(), satoshis: 0, outputDescription: 'social-friend' }],
 *   })
 *   await submitToOverlay(action, { topics: [OVERLAY_TOPICS.friend] })
 *
 * Whether it is a request or an accept depends on the other side: if `peer`
 * already sent one, this one completes the pair.
 */
export function friend(input: FriendInput, opts: FriendOptions): Promise<FriendRecord> {
  return build('friend', input, opts)
}

/**
 * Withdraw this wallet's side: a request not yet accepted, or a friendship.
 * The other side's record stays, so they still consent and this wallet can
 * accept again later with another `friend()`.
 */
export function unfriend(input: FriendInput, opts: FriendOptions): Promise<FriendRecord> {
  return build('unfriend', input, opts)
}

/** What `verifyFriend()` found in a script. */
export interface FriendCheck {
  /** `friend` or `unfriend`, as written (lowercased). */
  type: 'friend' | 'unfriend'
  /** Every MAP field in the record. */
  fields: Readonly<Record<string, string>>
  /** The sender: the identity key that signed the record. */
  identity: string
  /** The identity key the record is addressed to. */
  peer: string
  /**
   * True when the record is a well-formed friend record (`schema_version` 1,
   * two different compressed keys, a `serial`) and its signature verifies for
   * `identity`. The same test the overlay applies before it admits one.
   */
  valid: boolean
}

/**
 * Read a friend or unfriend record out of an OP_RETURN script and check its
 * signature. Returns null when the script is not a MAP `type=friend` or
 * `type=unfriend` record with an `identity`, a `peer` and a `sig`. (The older
 * Bitcoin Schema friend record, which has no `identity`, is not one.)
 */
export function verifyFriend(script: LockingScript | string | readonly number[]): FriendCheck | null {
  const pushes = opReturnPushes(script)
  if (!pushes || pushes.length < 2) return null
  const text = pushes.map((b) => Utils.toUTF8(b))
  if (text[0] !== PROTO_MAP || text[1] !== 'SET') return null
  const rest = text.slice(2)
  if (rest.length % 2 !== 0 || rest.includes(PIPE)) return null
  const fields: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) fields[rest[i]!] = rest[i + 1]!
  const type = fields['type']?.toLowerCase()
  if ((type !== 'friend' && type !== 'unfriend') || !fields['identity'] || !fields['peer'] || !fields['sig']) return null
  const valid =
    fields['schema_version'] === FRIEND_SCHEMA_VERSION &&
    PUBKEY_RE.test(fields['peer']) &&
    fields['identity'].toLowerCase() !== fields['peer'].toLowerCase() &&
    signatureValid(fields)
  return { type, fields, identity: fields['identity'], peer: fields['peer'], valid }
}
