/**
 * The sender's side of a standard BRC-29 payment to a BRC-100 identity key.
 *
 * A tip pays the author's identity key (the `identityKey` the overlay returns
 * for each author), never the address a post was signed with. The payee key is
 * derived per payment from the sender's wallet:
 *
 *   key = wallet.getPublicKey({ protocolID: [2, '3241645161d8'],
 *                               keyID: '<derivationPrefix> <derivationSuffix>',
 *                               counterparty: <recipient identity key> })
 *
 * The output is a P2PKH to that key. The recipient's wallet finds the same key
 * with the sender as counterparty, so it can take the output in with
 * `internalizeAction` (protocol `wallet payment`) and the `remittance` below.
 * Getting the transaction and the remittance to the recipient (PeerPay /
 * MessageBox) is the caller's job.
 *
 * No fee rate is set here or anywhere in the SDK: the sender's wallet chooses
 * it when it builds the transaction.
 */
import {
  BigNumber,
  Curve,
  P2PKH,
  ProtoWallet,
  PublicKey,
  Random,
  Utils,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk'
import { SchemaError } from './bitcom.js'

/** The BRC-29 wallet-payment protocol. */
export const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

/**
 * The verifier a tip's key linkage is revealed to: the public key of private
 * key 1 (the BRC-100 "anyone" key). A linkage encrypted for it can be
 * decrypted by anyone, which is the point: the linkage is published in the
 * tip record for every reader to check.
 */
export const BRC29_LINKAGE_VERIFIER = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/
const LINKAGE_RE = /^[0-9a-fA-F]{64}$/

/** The one wallet call a BRC-29 output needs; any BRC-100 `WalletInterface` has it. */
export type Brc29Wallet = Pick<WalletInterface, 'getPublicKey'>

export interface Brc29OutputInput {
  /** The payee's identity key (66 hex characters). */
  recipientIdentityKey: string
  /** Satoshis to pay: a whole number, 1 or more. */
  satoshis: number
  /** Default: 10 random bytes, base64. Must not contain a space. */
  derivationPrefix?: string
  /** Default: 10 random bytes, base64. Must not contain a space. */
  derivationSuffix?: string
  /** The wallet's output description. Default "Payment". */
  outputDescription?: string
  /** Passed to the wallet as the calling app's originator, when set. */
  originator?: string
}

/** What the recipient's wallet needs to take the output in. */
export interface Brc29Remittance {
  derivationPrefix: string
  derivationSuffix: string
  /** The sender's identity key. */
  senderIdentityKey: string
}

/** An output for `createAction`, plus the remittance for the recipient. */
export interface Brc29Output {
  /** Locking script (hex): P2PKH to the derived payee key. */
  lockingScript: string
  satoshis: number
  outputDescription: string
  /** For the sender's wallet to keep with the output (JSON string). */
  customInstructions: string
  remittance: Brc29Remittance
}

const randomPart = () => Utils.toBase64(Random(10))

function part(name: string, v: string | undefined): string {
  if (v === undefined) return randomPart()
  if (v.length === 0 || /\s/.test(v)) throw new SchemaError(`${name} must be non-empty and contain no whitespace`)
  return v
}

/**
 * Build the BRC-29 payment output for a tip. `tip()` builds the whole tip,
 * including the key linkage readers need to count it. Use the returned fields as an
 * output of `createAction` (`lockingScript`, `satoshis`, `outputDescription`,
 * `customInstructions`) next to the signed payment record from `payment()`:
 *
 *   const record = await signPayload(payment({ app, targetTxid, recipient, amount }), { wallet })
 *   const pay = await brc29Output(wallet, { recipientIdentityKey: recipient, satoshis: amount })
 *   await wallet.createAction({
 *     description: 'Tip',
 *     outputs: [
 *       { lockingScript: record.toHex(), satoshis: 0, outputDescription: 'Tip record' },
 *       { lockingScript: pay.lockingScript, satoshis: pay.satoshis,
 *         outputDescription: pay.outputDescription, customInstructions: pay.customInstructions },
 *     ],
 *     options: { randomizeOutputs: false },
 *   })
 */
export async function brc29Output(wallet: Brc29Wallet, input: Brc29OutputInput): Promise<Brc29Output> {
  if (typeof input.recipientIdentityKey !== 'string' || !PUBKEY_RE.test(input.recipientIdentityKey)) {
    throw new SchemaError('recipientIdentityKey must be a compressed public key (66 hex characters)')
  }
  const recipient = input.recipientIdentityKey.toLowerCase()
  if (!Number.isSafeInteger(input.satoshis) || input.satoshis < 1) {
    throw new SchemaError('satoshis must be a whole number, 1 or more')
  }
  const derivationPrefix = part('derivationPrefix', input.derivationPrefix)
  const derivationSuffix = part('derivationSuffix', input.derivationSuffix)

  const payee = await wallet.getPublicKey(
    { protocolID: BRC29_PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: recipient },
    input.originator,
  )
  if (typeof payee.publicKey !== 'string' || !PUBKEY_RE.test(payee.publicKey)) {
    throw new SchemaError('the wallet did not return a compressed public key for the payee')
  }
  const sender = await wallet.getPublicKey({ identityKey: true }, input.originator)
  if (typeof sender.publicKey !== 'string' || !PUBKEY_RE.test(sender.publicKey)) {
    throw new SchemaError('the wallet did not return its identity key')
  }

  const lockingScript = new P2PKH().lock(PublicKey.fromString(payee.publicKey).toHash()).toHex()
  return {
    lockingScript,
    satoshis: input.satoshis,
    outputDescription: input.outputDescription ?? 'Payment',
    customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, payee: recipient }),
    remittance: { derivationPrefix, derivationSuffix, senderIdentityKey: sender.publicKey.toLowerCase() },
  }
}

/** The one wallet call `brc29Linkage()` needs; any BRC-100 `WalletInterface` has it. */
export type Brc29LinkageWallet = Pick<WalletInterface, 'revealSpecificKeyLinkage'>

/**
 * Why a key linkage could not be had:
 *
 *   unsupported  the wallet has no `revealSpecificKeyLinkage`
 *   refused      the wallet threw (the user declined, or the wallet failed);
 *                the wallet's error is the `cause`
 *   invalid      the wallet answered, but the linkage does not decrypt to 32
 *                bytes, or does not derive the key the payment output pays
 */
export type Brc29LinkageErrorReason = 'unsupported' | 'refused' | 'invalid'

export class Brc29LinkageError extends Error {
  override readonly name = 'Brc29LinkageError'
  readonly reason: Brc29LinkageErrorReason

  constructor(reason: Brc29LinkageErrorReason, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.reason = reason
  }
}

export interface Brc29LinkageInput {
  /** The payee's identity key (66 hex characters), as given to `brc29Output()`. */
  recipientIdentityKey: string
  /** The output's derivation prefix (`remittance.derivationPrefix`). */
  derivationPrefix: string
  /** The output's derivation suffix (`remittance.derivationSuffix`). */
  derivationSuffix: string
  /** Passed to the wallet as the calling app's originator, when set. */
  originator?: string
}

function linkageBytes(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[]
  if (v instanceof Uint8Array) return Array.from(v)
  throw new Brc29LinkageError('invalid', 'the wallet returned the key linkage in an unknown format')
}

/**
 * The BRC-29 specific key linkage of one payment output, as 64 hex
 * characters: the scalar L such that the payee key is
 * `recipientIdentityKey + L·G` (BRC-42; L is the HMAC of the invoice number
 * `2-3241645161d8-<prefix> <suffix>` keyed by the sender/recipient ECDH
 * secret).
 *
 * One wallet call: `revealSpecificKeyLinkage` with counterparty the
 * recipient, protocol `BRC29_PROTOCOL`, key ID `<prefix> <suffix>` and
 * verifier `BRC29_LINKAGE_VERIFIER`. The wallet encrypts the linkage for the
 * verifier; since the verifier is the "anyone" key, this function decrypts it
 * here. Wallets with a permission layer may ask the user to approve revealing
 * a key linkage.
 *
 * Revealing L ties this one output to the recipient's identity key, for
 * everyone. It reveals nothing about other outputs and does not let anyone
 * spend the output (that takes the recipient's private key plus L).
 *
 * Throws `Brc29LinkageError` when the wallet lacks the call, refuses it or
 * answers with something that is not a linkage.
 */
export async function brc29Linkage(wallet: Brc29LinkageWallet, input: Brc29LinkageInput): Promise<string> {
  if (typeof input.recipientIdentityKey !== 'string' || !PUBKEY_RE.test(input.recipientIdentityKey)) {
    throw new SchemaError('recipientIdentityKey must be a compressed public key (66 hex characters)')
  }
  const recipient = input.recipientIdentityKey.toLowerCase()
  const keyID = `${part('derivationPrefix', input.derivationPrefix ?? '')} ${part('derivationSuffix', input.derivationSuffix ?? '')}`
  if (typeof wallet?.revealSpecificKeyLinkage !== 'function') {
    throw new Brc29LinkageError('unsupported', 'the wallet cannot reveal a key linkage (no revealSpecificKeyLinkage)')
  }
  let revealed: Awaited<ReturnType<WalletInterface['revealSpecificKeyLinkage']>>
  try {
    revealed = await wallet.revealSpecificKeyLinkage(
      { counterparty: recipient, verifier: BRC29_LINKAGE_VERIFIER, protocolID: BRC29_PROTOCOL, keyID },
      input.originator,
    )
  } catch (cause) {
    throw new Brc29LinkageError('refused', 'the wallet did not reveal the key linkage', { cause })
  }
  const prover = revealed?.prover
  if (typeof prover !== 'string' || !PUBKEY_RE.test(prover)) {
    throw new Brc29LinkageError('invalid', 'the wallet did not say which key revealed the linkage')
  }
  let plain: number[]
  try {
    const { plaintext } = await new ProtoWallet('anyone').decrypt({
      ciphertext: linkageBytes(revealed.encryptedLinkage),
      protocolID: [2, `specific linkage revelation ${BRC29_PROTOCOL[0]} ${BRC29_PROTOCOL[1]}`],
      keyID,
      counterparty: prover.toLowerCase(),
    })
    plain = plaintext
  } catch (cause) {
    if (cause instanceof Brc29LinkageError) throw cause
    throw new Brc29LinkageError('invalid', 'the key linkage does not decrypt for the public verifier', { cause })
  }
  if (plain.length !== 32) {
    throw new Brc29LinkageError('invalid', `the key linkage is ${plain.length} bytes, not 32`)
  }
  return Utils.toHex(plain)
}

const curve = new Curve()

/**
 * The P2PKH locking script (hex) that a BRC-29 payment with linkage L pays:
 * to `recipientIdentityKey + L·G`. This is the check readers run on a tip
 * record's `paymail` and `linkage` fields; a tip is credited only if one of
 * its outputs has exactly this script. Throws `SchemaError` on a malformed
 * key, a linkage that is not 32 bytes of hex, a zero linkage or one at or
 * above the curve order.
 */
export function brc29PayeeScript(recipientIdentityKey: string, linkage: string): string {
  if (typeof recipientIdentityKey !== 'string' || !PUBKEY_RE.test(recipientIdentityKey)) {
    throw new SchemaError('recipientIdentityKey must be a compressed public key (66 hex characters)')
  }
  if (typeof linkage !== 'string' || !LINKAGE_RE.test(linkage)) {
    throw new SchemaError('linkage must be 32 bytes of hex (64 characters)')
  }
  const l = new BigNumber(linkage.toLowerCase(), 16)
  if (l.isZero() || l.cmp(curve.n) >= 0) throw new SchemaError('linkage is not a valid scalar')
  const key = recipientIdentityKey.toLowerCase()
  let r: PublicKey
  try {
    r = PublicKey.fromString(key)
  } catch {
    throw new SchemaError('recipientIdentityKey is not a point on the curve')
  }
  // fromString reduces an x coordinate at or above the field prime; such a
  // key is not canonical, and the readers reject it.
  if (Utils.toHex(r.encode(true) as number[]) !== key) {
    throw new SchemaError('recipientIdentityKey is not a canonical curve point')
  }
  const derived = r.add(curve.g.mul(l))
  if (derived.isInfinity()) throw new SchemaError('the derived key is the point at infinity')
  return new P2PKH().lock(PublicKey.fromString(Utils.toHex(derived.encode(true) as number[])).toHash()).toHex()
}
