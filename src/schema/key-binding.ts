/**
 * peck-identity-v1 key binding: the record that ties a signing (posting) key
 * to the identity key that owns it, admitted by the overlay topic
 * `tm_key-binding`. A port of the peck.to v1 client's `bootstrapIdentity`
 * binding output, byte for byte, and of the overlay's reference issuer
 * (`buildBinding` in peck-overlay-schema `src/keybinding/binding.ts`).
 *
 * Why it matters: posts are AIP-signed by the login key ([1, 'identity'] /
 * '1' / 'self'), a key derived from the identity key, not the identity key
 * itself. Readers that need to know which identity wrote a post (author
 * resolution, tip attribution) look the signing address up in the overlay's
 * `signing_keys` table, and only an admitted binding puts a row there.
 *
 * ── The record ────────────────────────────────────────────────────────────
 * One OP_FALSE OP_RETURN output, MAP only, no `|` and no AIP section:
 *
 *   PROTO_MAP SET app <app> type keybinding schema_version 1
 *     subject <signing key> certifier <identity key> serial <hex>
 *     purpose <purpose> revocation <txid.vout> [boundAt <n>]
 *     sig <hex> subjectsig <hex>
 *
 * ── The two signatures ────────────────────────────────────────────────────
 * Both sign the same canonical preimage: the fields up to and including
 * `boundAt` (everything but the two signatures), as JSON with sorted keys and
 * no whitespace, UTF-8 encoded.
 *
 *   sig         the identity attests. A BRC-3 signature, publicly verifiable:
 *               createSignature({ protocolID: [1, 'keybinding'], keyID: serial,
 *                                 counterparty: 'anyone' })
 *   subjectsig  the signing key consents. Signed with the signing key's own
 *               derivation and verified raw against `subject`:
 *               createSignature({ protocolID: [1, 'identity'], keyID: '1',
 *                                 counterparty: 'self' })
 *
 * The overlay admits the record only when both verify, so nobody can bind a
 * key they do not control, or bind a key to an identity they do not own.
 * `counterparty: 'anyone'` is the wallet default for `createSignature` (v1
 * relies on it); it is sent explicitly here.
 *
 * ── Revocation ────────────────────────────────────────────────────────────
 * The overlay unbinds when the binding output or its `revocation` outpoint is
 * spent. v1 writes the null outpoint (64 zeros, `.0`), which nobody can spend;
 * so does this builder by default. The binding output itself is OP_RETURN,
 * also unspendable, so such a binding is permanent.
 */
import {
  PrivateKey,
  PublicKey,
  Random,
  Signature,
  Utils,
  type LockingScript,
  type WalletCounterparty,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk'
import { PROTO_MAP, SchemaError, opReturnPushes, payload, type SchemaPayload } from './bitcom.js'
import { AIP_DEFAULT_COUNTERPARTY, AIP_DEFAULT_KEY_ID, AIP_DEFAULT_PROTOCOL, signatureBytes } from './aip.js'

/** The MAP `app` v1 writes for key bindings. The overlay does not check it. */
export const KEY_BINDING_APP = 'overlay.social'
/** BRC-43 protocol of the identity's (certifier's) signature. */
export const KEY_BINDING_PROTOCOL: WalletProtocol = [1, 'keybinding']
export const KEY_BINDING_SCHEMA_VERSION = '1'
/** The `purpose` v1 writes. */
export const KEY_BINDING_PURPOSE = 'social-posting'
/** The null outpoint v1 writes as `revocation`: nobody can spend it, so the binding is permanent. */
export const KEY_BINDING_NO_REVOCATION = `${'0'.repeat(64)}.0`
/** What v1 tells the wallet about the binding output. */
export const KEY_BINDING_OUTPUT_DESCRIPTION = 'key-binding'

// The fields the signatures cover, in the order the record writes them; `sig` and `subjectsig` follow.
const PREIMAGE_KEYS = ['app', 'type', 'schema_version', 'subject', 'certifier', 'serial', 'purpose', 'revocation', 'boundAt'] as const
const FIELD_ORDER = [...PREIMAGE_KEYS, 'sig', 'subjectsig'] as const

const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/
const SERIAL_RE = /^[0-9a-f]{8,64}$/
const OUTPOINT_RE = /^[0-9a-f]{64}\.\d+$/
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/

/** The two wallet calls a key binding needs; any BRC-100 `WalletInterface` has them. */
export type KeyBindingWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

/** A wallet key derivation: the signing key to bind. */
export interface KeyBindingSubjectKey {
  protocolID: WalletProtocol
  keyID: string
  counterparty: WalletCounterparty
}

export interface KeyBindingInput {
  /**
   * The signing key to bind, as the wallet derives it. Default: the AIP / login
   * key, [1, 'identity'] / '1' / 'self', the key every peck.to client signs
   * posts with. Bind the key your posts are signed with, or the binding is
   * for an address no post comes from.
   */
  subjectKey?: KeyBindingSubjectKey
  /**
   * The identity signature's key ID: 8 to 64 lowercase hex characters.
   * Default: 8 random bytes, hex (as v1). Fix it only for reproducible output.
   */
  serial?: string
  /** Default "social-posting", as v1. */
  purpose?: string
  /**
   * `<txid>.<vout>` whose spend unbinds the key. Default: the null outpoint,
   * as v1 (a permanent binding).
   */
  revocation?: string
  /** A non-negative integer hint (the overlay sorts by it; earliest wins). v1 leaves it out. */
  boundAt?: string
  /** MAP `app`. Default "overlay.social", as v1. */
  app?: string
}

export interface KeyBindingOptions {
  wallet: KeyBindingWallet
  /** Passed to the wallet as the calling app's originator, when set. */
  originator?: string
}

/** A signed key binding: the payload (use `toLockingScript()`) and what it binds. */
export interface KeyBinding extends SchemaPayload {
  /** Every MAP field written, including `sig` and `subjectsig`. */
  readonly fields: Readonly<Record<string, string>>
  /** The bound signing key (compressed public key, lowercase hex). */
  readonly subject: string
  /** The identity key it is bound to (lowercase hex). */
  readonly certifier: string
  /** P2PKH address of `subject`: what the overlay indexes the binding by (`signing_address`). */
  readonly signingAddress: string
}

/**
 * The canonical preimage both keys sign: the fields (all but the two
 * signatures) as JSON with sorted keys, UTF-8 encoded.
 */
export function keyBindingPreimage(fields: Readonly<Record<string, string | undefined>>): number[] {
  const core: Record<string, string> = {}
  for (const k of PREIMAGE_KEYS) {
    const v = fields[k]
    if (v !== undefined) core[k] = v
  }
  return Utils.toArray(JSON.stringify(core, Object.keys(core).sort()), 'utf8')
}

/** P2PKH address of a compressed public key, or null when it is not one. */
function addressOf(pubkey: string): string | null {
  try {
    return PublicKey.fromString(pubkey).toAddress()
  } catch {
    return null
  }
}

/** The key an 'anyone' verifier derives for the identity's signature (BRC-42 with the 'anyone' key). */
function certifierSigningKey(certifier: string, serial: string): PublicKey {
  const [level, name] = KEY_BINDING_PROTOCOL
  return PublicKey.fromString(certifier).deriveChild(new PrivateKey(1), `${level}-${name}-${serial}`)
}

function verifies(key: () => PublicKey, preimage: number[], sigHex: string): boolean {
  if (!HEX_RE.test(sigHex)) return false
  try {
    return key().verify(preimage, Signature.fromDER(Utils.toArray(sigHex, 'hex')))
  } catch {
    return false
  }
}

/**
 * The overlay's admission rule (peck-overlay-schema `isValidBinding`), minus
 * the UTXO liveness the overlay tracks itself.
 */
function bindingValid(f: Readonly<Record<string, string>>): boolean {
  if (f['type']?.toLowerCase() !== 'keybinding') return false
  if (f['schema_version'] !== KEY_BINDING_SCHEMA_VERSION) return false
  const subject = f['subject'] ?? ''
  const certifier = f['certifier'] ?? ''
  if (!PUBKEY_RE.test(subject) || !PUBKEY_RE.test(certifier)) return false
  if (subject.toLowerCase() === certifier.toLowerCase()) return false
  const sig = f['sig']
  const subjectsig = f['subjectsig']
  const serial = f['serial']
  if (!sig || !subjectsig || !serial) return false
  // The wallet's key derivation takes a key ID of 1 to 800 bytes; the overlay's verifier fails outside that.
  if (Utils.toArray(serial, 'utf8').length > 800) return false
  const preimage = keyBindingPreimage(f)
  return (
    verifies(() => PublicKey.fromString(subject), preimage, subjectsig) &&
    verifies(() => certifierSigningKey(certifier, serial), preimage, sig)
  )
}

function text(name: string, v: string | undefined, fallback: string): string {
  if (v === undefined) return fallback
  if (typeof v !== 'string' || v === '') throw new SchemaError(`${name} must be a non-empty string`)
  return v
}

const toHex = (bytes: readonly number[]) => Utils.toHex([...bytes])

async function walletKey(
  wallet: KeyBindingWallet,
  args: Parameters<KeyBindingWallet['getPublicKey']>[0],
  originator: string | undefined,
  what: string,
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey(args, originator)
  if (typeof publicKey !== 'string' || !PUBKEY_RE.test(publicKey)) {
    throw new SchemaError(`the wallet did not return its ${what}`)
  }
  return publicKey.toLowerCase()
}

/**
 * Build and sign a key binding through the wallet: the identity key attests
 * and the signing key consents. The wallet shows the two signature requests;
 * nothing is sent. Put the script in a zero-satoshi output (it can share a
 * transaction with the post it is for) and submit the transaction with
 * `submitToOverlay()` to the topic `tm_key-binding` (`OVERLAY_TOPICS.keyBinding`).
 *
 *   const binding = await keyBinding({}, { wallet })
 *   await wallet.createAction({
 *     description: 'Link posting key',
 *     outputs: [{ lockingScript: toLockingScript(binding).toHex(), satoshis: 0,
 *                 outputDescription: KEY_BINDING_OUTPUT_DESCRIPTION }],
 *   })
 *
 * Both signatures are checked exactly as the overlay checks them before the
 * record is returned, so a wallet that signs with other keys fails here, not
 * silently at the overlay.
 */
export async function keyBinding(input: KeyBindingInput, opts: KeyBindingOptions): Promise<KeyBinding> {
  const app = text('app', input.app, KEY_BINDING_APP)
  const purpose = text('purpose', input.purpose, KEY_BINDING_PURPOSE)
  const revocation = text('revocation', input.revocation, KEY_BINDING_NO_REVOCATION)
  if (!OUTPOINT_RE.test(revocation)) throw new SchemaError('revocation must be "<64 lowercase hex>.<vout>"')
  if (input.boundAt !== undefined && !/^\d+$/.test(input.boundAt)) throw new SchemaError('boundAt must be a non-negative integer')
  const serial = input.serial ?? toHex(Random(8))
  if (!SERIAL_RE.test(serial)) throw new SchemaError('serial must be 8 to 64 lowercase hex characters')
  const subjectKey: KeyBindingSubjectKey = input.subjectKey ?? {
    protocolID: AIP_DEFAULT_PROTOCOL,
    keyID: AIP_DEFAULT_KEY_ID,
    counterparty: AIP_DEFAULT_COUNTERPARTY,
  }

  const certifier = await walletKey(opts.wallet, { identityKey: true }, opts.originator, 'identity key')
  const subject = await walletKey(
    opts.wallet,
    { protocolID: subjectKey.protocolID, keyID: subjectKey.keyID, counterparty: subjectKey.counterparty },
    opts.originator,
    'signing key',
  )
  if (subject === certifier) throw new SchemaError('the signing key is the identity key itself: there is nothing to bind')

  const fields: Record<string, string> = {
    app,
    type: 'keybinding',
    schema_version: KEY_BINDING_SCHEMA_VERSION,
    subject,
    certifier,
    serial,
    purpose,
    revocation,
    ...(input.boundAt !== undefined ? { boundAt: input.boundAt } : {}),
  }
  const preimage = keyBindingPreimage(fields)
  const certified = await opts.wallet.createSignature(
    { data: preimage, protocolID: KEY_BINDING_PROTOCOL, keyID: serial, counterparty: 'anyone' },
    opts.originator,
  )
  fields.sig = toHex(signatureBytes(certified.signature))
  const consented = await opts.wallet.createSignature(
    { data: preimage, protocolID: subjectKey.protocolID, keyID: subjectKey.keyID, counterparty: subjectKey.counterparty },
    opts.originator,
  )
  fields.subjectsig = toHex(signatureBytes(consented.signature))
  if (!bindingValid(fields)) {
    throw new SchemaError('the wallet signatures do not verify against the keys it reported')
  }

  const pushes: string[] = [PROTO_MAP, 'SET']
  for (const k of FIELD_ORDER) {
    const v = fields[k]
    if (v !== undefined) pushes.push(k, v)
  }
  return { ...payload(pushes), fields, subject, certifier, signingAddress: addressOf(subject)! }
}

/** What `verifyKeyBinding()` found in a script. */
export interface KeyBindingCheck {
  /** Every MAP field in the record. */
  fields: Readonly<Record<string, string>>
  /** The signing key the record binds (as written). */
  subject: string
  /** The identity key it binds it to (as written). */
  certifier: string
  /** P2PKH address of `subject`, or null when `subject` is not a public key. */
  signingAddress: string | null
  /**
   * True when the overlay would admit the record: `schema_version` 1, two
   * different compressed keys, a serial, and both signatures verify over the
   * canonical preimage. The same test the overlay's topic manager applies.
   */
  valid: boolean
}

/**
 * Read a key binding out of an OP_RETURN script and check it the way the
 * overlay does. Returns null when the script is not a MAP `type=keybinding`
 * record.
 */
export function verifyKeyBinding(script: LockingScript | string | readonly number[]): KeyBindingCheck | null {
  const pushes = opReturnPushes(script)
  if (!pushes || pushes.length < 2) return null
  const t = pushes.map((b) => Utils.toUTF8(b))
  if (t[0] !== PROTO_MAP || t[1] !== 'SET') return null
  const fields: Record<string, string> = {}
  for (let i = 2; i + 1 < t.length; i += 2) fields[t[i]!] = t[i + 1]!
  if (fields['type']?.toLowerCase() !== 'keybinding') return null
  const subject = fields['subject'] ?? ''
  const certifier = fields['certifier'] ?? ''
  return {
    fields,
    subject,
    certifier,
    signingAddress: PUBKEY_RE.test(subject) ? addressOf(subject) : null,
    valid: bindingValid(fields),
  }
}
