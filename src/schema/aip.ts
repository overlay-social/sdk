/**
 * AIP (Author Identity Protocol) signing and verification, BRC77 algorithm.
 *
 * ── The full preimage ─────────────────────────────────────────────────────
 * The signed message is built from the output script's data pushes after
 * OP_FALSE OP_RETURN, in order, from the first push up to and including the
 * AIP signing-key push (the push right after the algorithm marker "BRC77"):
 *
 *   <B section> | <MAP section(s)> | PROTO_AIP "BRC77" <signing key hex>
 *
 * Concatenate the data bytes of those pushes. Push opcodes and length
 * prefixes are not included, nor are OP_FALSE and OP_RETURN, nor the
 * signature push itself. Each section separator contributes its single data
 * byte 0x7c. Binary pushes (an image in the B section) contribute their raw
 * bytes, never a hex or base64 rendering of them.
 *
 * The digest is one SHA-256 of that byte string. The signature is ECDSA over
 * the digest by the signing key, DER-encoded, and the script carries it as a
 * base64 string push. There is no Bitcoin Signed Message prefix and no
 * recovery byte: the signing key is written out, so verifiers check the
 * signature against it directly.
 *
 * This is the byte string the Bitcom AIP "BITCOIN_ECDSA" canonical form signs
 * too; only the digest and signature encoding differ. The overlay's indexer
 * verifies exactly this (`aip_verified`).
 *
 * ── The signing key ───────────────────────────────────────────────────────
 * The key is a BRC-42 key the user's BRC-100 wallet derives. The default is
 * protocol [1, 'identity'], key ID '1', counterparty 'self', which is what the
 * peck.to clients sign with, so posts from every client carry the same key
 * for the same person. The SDK never holds a private key: it asks the wallet
 * for the public key and for a signature over the digest, with the same
 * protocol, key ID and counterparty on both calls. (Left unset, getPublicKey
 * defaults the counterparty to 'self' and createSignature to 'anyone', which
 * derives two different keys; so both are always sent.)
 */
import { Hash, PublicKey, Signature, Utils, type LockingScript, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { PIPE, PROTO_AIP, SchemaError, opReturnPushes, toBytes, toLockingScript, type SchemaPayload } from './bitcom.js'

/** The AIP algorithm marker this SDK writes. */
export const AIP_ALGORITHM = 'BRC77'
/** Default BRC-42 derivation of the AIP signing key. */
export const AIP_DEFAULT_PROTOCOL: WalletProtocol = [1, 'identity']
export const AIP_DEFAULT_KEY_ID = '1'
export const AIP_DEFAULT_COUNTERPARTY = 'self'

const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/

/** The two wallet calls AIP signing needs; any BRC-100 `WalletInterface` has them. */
export type AipWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

export interface AipSignOptions {
  wallet: AipWallet
  /** BRC-42 protocol of the signing key. Default [1, 'identity']. */
  protocolID?: WalletProtocol
  /** Default '1'. */
  keyID?: string
  /** Default 'self'. */
  counterparty?: string
  /** Passed to the wallet as the calling app's originator, when set. */
  originator?: string
}

/** The AIP header pushes that precede the signature: `| PROTO_AIP "BRC77" <key>`. */
function aipHeader(signingKey: string): number[][] {
  return [toBytes(PIPE), toBytes(PROTO_AIP), toBytes(AIP_ALGORITHM), toBytes(signingKey)]
}

/**
 * The full preimage (see the module comment) for a payload signed by
 * `signingKey`: the payload's push bytes, then `|`, PROTO_AIP, "BRC77" and the
 * key, concatenated.
 */
export function aipPreimage(p: SchemaPayload, signingKey: string): number[] {
  const out: number[] = []
  for (const push of [...p.pushes, ...aipHeader(signingKey)]) {
    for (const b of push) out.push(b)
  }
  return out
}

function signatureBytes(sig: unknown): number[] {
  if (Array.isArray(sig)) return sig as number[]
  if (sig instanceof Uint8Array) return Array.from(sig)
  if (typeof sig === 'string' && /^[0-9a-fA-F]+$/.test(sig) && sig.length % 2 === 0) return Utils.toArray(sig, 'hex')
  throw new SchemaError('the wallet returned a signature in an unknown format')
}

/**
 * Sign a payload with AIP (BRC77) through the wallet and return the complete
 * locking script: the payload, then `| PROTO_AIP "BRC77" <key> <signature>`.
 * The signature is checked against the key before it is used, so a wallet
 * that signs with a different key than it reported fails here instead of
 * producing a post nobody can verify.
 */
export async function signPayload(p: SchemaPayload, opts: AipSignOptions): Promise<LockingScript> {
  const protocolID = opts.protocolID ?? AIP_DEFAULT_PROTOCOL
  const keyID = opts.keyID ?? AIP_DEFAULT_KEY_ID
  const counterparty = opts.counterparty ?? AIP_DEFAULT_COUNTERPARTY
  const { publicKey } = await opts.wallet.getPublicKey({ protocolID, keyID, counterparty }, opts.originator)
  if (typeof publicKey !== 'string' || !PUBKEY_RE.test(publicKey)) {
    throw new SchemaError('the wallet did not return a compressed public key for the AIP signing key')
  }
  const signingKey = publicKey.toLowerCase()
  const preimage = aipPreimage(p, signingKey)
  const { signature } = await opts.wallet.createSignature(
    { hashToDirectlySign: Hash.sha256(preimage), protocolID, keyID, counterparty },
    opts.originator,
  )
  const der = signatureBytes(signature)
  let valid = false
  try {
    valid = PublicKey.fromString(signingKey).verify(preimage, Signature.fromDER(der))
  } catch {
    valid = false
  }
  if (!valid) {
    throw new SchemaError('the wallet signature does not verify against the AIP signing key it reported')
  }
  return toLockingScript({
    pushes: [...p.pushes, ...aipHeader(signingKey), Utils.toArray(Utils.toBase64(der), 'utf8')],
  })
}

/** What `verifyAip()` found in a script's AIP section. */
export interface AipCheck {
  /** The algorithm marker, e.g. "BRC77" or "BITCOIN_ECDSA". */
  algorithm: string
  /** The signing key (BRC77) or address (BITCOIN_ECDSA) as written. */
  signer: string
  /**
   * True when the signature verifies over the full preimage. Only BRC77 is
   * checked here; other algorithms report false.
   */
  valid: boolean
}

/**
 * Find the AIP section of an OP_RETURN script and check its signature.
 * Returns null when the script has no AIP section.
 */
export function verifyAip(script: LockingScript | string | readonly number[]): AipCheck | null {
  const pushes = opReturnPushes(script)
  if (!pushes) return null
  const text = (b: readonly number[] | undefined) => (b ? Utils.toUTF8([...b]) : '')
  let at = -1
  for (let i = 1; i < pushes.length; i++) {
    if (text(pushes[i]) === PROTO_AIP && text(pushes[i - 1]) === PIPE) {
      at = i
      break
    }
  }
  if (at < 0 || at + 3 >= pushes.length) return null
  const algorithm = text(pushes[at + 1])
  const signer = text(pushes[at + 2])
  if (algorithm !== AIP_ALGORITHM || !PUBKEY_RE.test(signer)) return { algorithm, signer, valid: false }
  const preimage = pushes.slice(0, at + 3).flat()
  let valid = false
  try {
    const der = Utils.toArray(text(pushes[at + 3]), 'base64')
    valid = PublicKey.fromString(signer).verify(preimage, Signature.fromDER(der))
  } catch {
    valid = false
  }
  return { algorithm, signer, valid }
}
