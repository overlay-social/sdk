/**
 * peck-identity-v1 profile: the light, self-attested profile the overlay
 * resolves into `{ display_name, avatar, bio }` for an identity key. A port of
 * the peck.to v1 client's `setIdentityProfile`, byte for byte. It is not the
 * older `profile()` builder (a MAP `type=profile` signed with AIP by the
 * posting key); this record is signed by the identity itself and is admitted
 * by the overlay topic `tm_identity-profile`.
 *
 * ── The record ────────────────────────────────────────────────────────────
 * One OP_FALSE OP_RETURN output, MAP only, no `|` and no AIP section:
 *
 *   PROTO_MAP SET app <app> type profile schema_version 1 identity <identity key>
 *     [display_name <name>] [avatar <ref>] [bio <text>] serial <hex> sig <hex>
 *
 * (fields in that order; omitted ones are left out, never written empty).
 *
 * ── The signature ─────────────────────────────────────────────────────────
 * `identity` is the wallet's root identity key. The signature is a BRC-3
 * signature, publicly verifiable, over the canonical preimage: the fields up
 * to and including `serial`, as JSON with sorted keys and no whitespace,
 * UTF-8 encoded.
 *
 *   createSignature({ data: preimage, protocolID: [1, 'profile'], keyID: serial,
 *                     counterparty: 'anyone' })
 *
 * `counterparty: 'anyone'` is the wallet default for `createSignature`; it is
 * sent explicitly here. A verifier derives the signing key from `identity`
 * with the 'anyone' key, protocol [1, 'profile'] and the serial as key ID
 * (`verifyIdentityProfile()` does this; the overlay does the same).
 *
 * Latest admitted record per identity wins, so a record replaces the whole
 * profile: send every field you want to keep.
 */
import { PrivateKey, PublicKey, Random, Signature, Utils, type LockingScript, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { PIPE, PROTO_MAP, SchemaError, opReturnPushes, payload, type SchemaPayload } from './bitcom.js'
import { signatureBytes } from './aip.js'

/** The MAP `app` v1 writes for identity profiles. */
export const IDENTITY_PROFILE_APP = 'overlay.social'
/** BRC-43 protocol of the profile signature. */
export const IDENTITY_PROFILE_PROTOCOL: WalletProtocol = [1, 'profile']
export const IDENTITY_PROFILE_SCHEMA_VERSION = '1'

// The fields the signature covers, in the order the record writes them; `sig` follows.
const PREIMAGE_KEYS = ['app', 'type', 'schema_version', 'identity', 'display_name', 'avatar', 'bio', 'serial'] as const

const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/
const SERIAL_RE = /^[0-9a-f]{8,64}$/

/** The two wallet calls the profile needs; any BRC-100 `WalletInterface` has them. */
export type IdentityProfileWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

export interface IdentityProfileInput {
  /** Shown as the name. Written as given (not trimmed); left out when empty. */
  displayName?: string
  /** Picture reference or URL (uhrp://…, https://…, data:image/…). Left out when empty. */
  avatar?: string
  bio?: string
  /** MAP `app`. Default "overlay.social", as v1. */
  app?: string
  /**
   * The signature's key ID: 8 to 64 lowercase hex characters. Default: 8
   * random bytes, hex (as v1). Fix it only for reproducible output.
   */
  serial?: string
}

export interface IdentityProfileOptions {
  wallet: IdentityProfileWallet
  /** Passed to the wallet as the calling app's originator, when set. */
  originator?: string
}

/** A signed profile: the payload (use `toLockingScript()`) and the fields it carries. */
export interface IdentityProfile extends SchemaPayload {
  /** Every MAP field written, including `sig`. */
  readonly fields: Readonly<Record<string, string>>
}

/**
 * The canonical preimage the identity signs: the fields (all but `sig`) as
 * JSON with sorted keys, UTF-8 encoded.
 */
export function identityProfilePreimage(fields: Readonly<Record<string, string | undefined>>): number[] {
  const core: Record<string, string> = {}
  for (const k of PREIMAGE_KEYS) {
    const v = fields[k]
    if (v !== undefined) core[k] = v
  }
  return Utils.toArray(JSON.stringify(core, Object.keys(core).sort()), 'utf8')
}

/** The key an 'anyone' verifier derives for a profile signature (BRC-42 with the 'anyone' key). */
function signingKey(identity: string, serial: string): PublicKey {
  const [level, name] = IDENTITY_PROFILE_PROTOCOL
  return PublicKey.fromString(identity).deriveChild(new PrivateKey(1), `${level}-${name}-${serial}`)
}

function signatureValid(fields: Readonly<Record<string, string>>): boolean {
  const { identity, serial, sig } = fields
  if (!identity || !PUBKEY_RE.test(identity) || !serial || !sig || sig.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(sig)) return false
  try {
    return signingKey(identity, serial).verify(identityProfilePreimage(fields), Signature.fromDER(Utils.toArray(sig, 'hex')))
  } catch {
    return false
  }
}

function value(name: string, v: string | undefined): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new SchemaError(`${name} must be a string`)
  // A value that is exactly "|" is the same push as a section separator.
  if (v === PIPE) throw new SchemaError(`${name} cannot be "|"`)
  return v
}

const toHex = (bytes: readonly number[]) => Utils.toHex([...bytes])

/**
 * Build and sign an identity profile through the wallet. The wallet shows the
 * signature request; nothing is sent. Give the script to `createAction` (one
 * zero-satoshi output) and submit the transaction to the overlay topic
 * `tm_identity-profile`.
 *
 *   const profile = await identityProfile({ displayName, avatar, bio }, { wallet })
 *   await wallet.createAction({
 *     description: 'Set profile',
 *     outputs: [{ lockingScript: toLockingScript(profile).toHex(), satoshis: 0, outputDescription: 'identity-profile' }],
 *   })
 *
 * The signature is checked against the identity key before it is used, so a
 * wallet that signs with another key fails here, not at the overlay.
 */
export async function identityProfile(input: IdentityProfileInput, opts: IdentityProfileOptions): Promise<IdentityProfile> {
  const app = value('app', input.app) ?? IDENTITY_PROFILE_APP
  const displayName = value('displayName', input.displayName)
  const avatar = value('avatar', input.avatar)
  const bio = value('bio', input.bio)
  if (displayName === undefined && avatar === undefined && bio === undefined) {
    // The newest record replaces the profile, so an empty one would blank it.
    throw new SchemaError('a profile needs at least one of displayName, avatar and bio')
  }
  const serial = input.serial ?? toHex(Random(8))
  if (!SERIAL_RE.test(serial)) throw new SchemaError('serial must be 8 to 64 lowercase hex characters')

  const { publicKey } = await opts.wallet.getPublicKey({ identityKey: true }, opts.originator)
  if (typeof publicKey !== 'string' || !PUBKEY_RE.test(publicKey)) {
    throw new SchemaError('the wallet did not return its identity key')
  }
  const identity = publicKey.toLowerCase()

  const fields: Record<string, string> = {
    app,
    type: 'profile',
    schema_version: IDENTITY_PROFILE_SCHEMA_VERSION,
    identity,
    ...(displayName !== undefined ? { display_name: displayName } : {}),
    ...(avatar !== undefined ? { avatar } : {}),
    ...(bio !== undefined ? { bio } : {}),
    serial,
  }
  const { signature } = await opts.wallet.createSignature(
    { data: identityProfilePreimage(fields), protocolID: IDENTITY_PROFILE_PROTOCOL, keyID: serial, counterparty: 'anyone' },
    opts.originator,
  )
  fields.sig = toHex(signatureBytes(signature))
  if (!signatureValid(fields)) {
    throw new SchemaError('the wallet signature does not verify against the identity key it reported')
  }

  const pushes: string[] = [PROTO_MAP, 'SET']
  for (const k of [...PREIMAGE_KEYS, 'sig'] as const) {
    const v = fields[k]
    if (v !== undefined) pushes.push(k, v)
  }
  return { ...payload(pushes), fields }
}

/** What `verifyIdentityProfile()` found in a script. */
export interface IdentityProfileCheck {
  /** Every MAP field in the record. */
  fields: Readonly<Record<string, string>>
  /** The identity key the profile claims to be for. */
  identity: string
  /**
   * True when the record is a well-formed peck-identity-v1 profile
   * (`schema_version` 1, a compressed `identity` key, a `serial`) and its
   * signature verifies for that identity. The same test the overlay applies.
   */
  valid: boolean
}

/**
 * Read an identity-profile record out of an OP_RETURN script and check its
 * signature. Returns null when the script is not a MAP `type=profile` record
 * with an `identity` and a `sig` (for example the older `profile()` record).
 */
export function verifyIdentityProfile(script: LockingScript | string | readonly number[]): IdentityProfileCheck | null {
  const pushes = opReturnPushes(script)
  if (!pushes || pushes.length < 2) return null
  const text = pushes.map((b) => Utils.toUTF8(b))
  if (text[0] !== PROTO_MAP || text[1] !== 'SET') return null
  const rest = text.slice(2)
  if (rest.length % 2 !== 0 || rest.includes(PIPE)) return null
  const fields: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) fields[rest[i]!] = rest[i + 1]!
  if (fields['type']?.toLowerCase() !== 'profile' || !fields['identity'] || !fields['sig']) return null
  const valid = fields['schema_version'] === IDENTITY_PROFILE_SCHEMA_VERSION && signatureValid(fields)
  return { fields, identity: fields['identity'], valid }
}
