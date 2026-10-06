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
import { P2PKH, PublicKey, Random, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { SchemaError } from './bitcom.js'

/** The BRC-29 wallet-payment protocol. */
export const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/

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
 * Build the BRC-29 payment output for a tip. Use the returned fields as an
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
