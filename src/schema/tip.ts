/**
 * A whole tip in one call: the BRC-29 payment to the author's identity key,
 * its key linkage, and the signed `payment()` record that publishes it.
 *
 * Readers credit a BRC-29 tip only when the chain proves it reached the
 * author. To anyone but the sender and the recipient, a BRC-29 output looks
 * like the sender's change, so the record carries the output's specific key
 * linkage L (MAP `linkage`). A reader then recomputes the payee key as
 * `recipient identity key + L·G` and credits the satoshis of the output that
 * pays it. A record without the linkage is not credited.
 *
 * `tip()` therefore fails with `Brc29LinkageError` rather than build a tip
 * that readers would not count: if the wallet cannot or will not reveal the
 * linkage, or the linkage it reveals does not derive the key the output
 * pays, nothing is signed and no outputs are returned. A caller that wants
 * an uncounted tip anyway can still compose `payment()` and `brc29Output()`
 * by hand.
 *
 * No fee rate is set here or anywhere in the SDK: the sender's wallet chooses
 * it when it builds the transaction.
 */
import type { LockingScript, WalletInterface } from '@bsv/sdk'
import { signPayload, type AipSignOptions } from './aip.js'
import {
  Brc29LinkageError,
  brc29Linkage,
  brc29Output,
  brc29PayeeScript,
  type Brc29Output,
  type Brc29Remittance,
} from './brc29.js'
import { payment } from './builders.js'

/** The wallet calls a tip needs; any BRC-100 `WalletInterface` has them. */
export type TipWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature' | 'revealSpecificKeyLinkage'>

export interface TipInput {
  /** The MAP `app` value, e.g. "peck.to". */
  app: string
  /** The post being tipped (MAP `tx`). */
  targetTxid: string
  /** The author's identity key (66 hex characters): who is paid, written as MAP `paymail`. */
  recipientIdentityKey: string
  /** Satoshis to pay: a whole number, 1 or more. Written as MAP `value`. */
  satoshis: number
  /** Default: 10 random bytes, base64. Must not contain a space. */
  derivationPrefix?: string
  /** Default: 10 random bytes, base64. Must not contain a space. */
  derivationSuffix?: string
  /** The wallet's description of the payment output. Default "Payment". */
  outputDescription?: string
  /** The wallet's description of the record output. Default "Tip record". */
  recordDescription?: string
}

/** AIP signing options for the record (see `signPayload()`), with a wallet that can also reveal a linkage. */
export interface TipOptions extends Omit<AipSignOptions, 'wallet'> {
  wallet: TipWallet
}

/** One `createAction` output, as the wallet takes it. */
export interface TipActionOutput {
  lockingScript: string
  satoshis: number
  outputDescription: string
  customInstructions?: string
}

export interface Tip {
  /**
   * The two outputs for one `createAction`, in this order: the signed record
   * (0 sat), then the payment. Pass `options: { randomizeOutputs: false }`
   * if you rely on the order.
   */
  outputs: [TipActionOutput, TipActionOutput]
  /** The signed record's locking script. */
  record: LockingScript
  /** The BRC-29 payment output, as `brc29Output()` returns it. */
  payment: Brc29Output
  /** The key linkage written into the record (64 hex characters). */
  linkage: string
  /** What the recipient's wallet needs to take the payment in. */
  remittance: Brc29Remittance
}

/**
 * Build a tip that readers can prove and count:
 *
 *   const t = await tip({ app: 'peck.to', targetTxid, recipientIdentityKey, satoshis: 500 }, { wallet })
 *   await wallet.createAction({ description: 'Tip', outputs: t.outputs, options: { randomizeOutputs: false } })
 *   // then hand the transaction and t.remittance to the recipient (PeerPay / MessageBox)
 *
 * Wallet calls, in order: `getPublicKey` (payee key, then identity key),
 * `revealSpecificKeyLinkage` (once), then `getPublicKey` and
 * `createSignature` for the AIP signature. A refused linkage therefore never
 * reaches the signing prompt.
 *
 * Throws `SchemaError` on bad input and `Brc29LinkageError` when no valid
 * linkage can be had (see the module comment).
 */
export async function tip(input: TipInput, opts: TipOptions): Promise<Tip> {
  const { wallet, ...aip } = opts
  // Validate the record's fields before any wallet call.
  payment({ app: input.app, targetTxid: input.targetTxid, recipient: input.recipientIdentityKey, amount: input.satoshis })

  const pay = await brc29Output(wallet, {
    recipientIdentityKey: input.recipientIdentityKey,
    satoshis: input.satoshis,
    ...(input.derivationPrefix !== undefined ? { derivationPrefix: input.derivationPrefix } : {}),
    ...(input.derivationSuffix !== undefined ? { derivationSuffix: input.derivationSuffix } : {}),
    ...(input.outputDescription !== undefined ? { outputDescription: input.outputDescription } : {}),
    ...(opts.originator !== undefined ? { originator: opts.originator } : {}),
  })
  const recipient = input.recipientIdentityKey.toLowerCase()
  const linkage = await brc29Linkage(wallet, {
    recipientIdentityKey: recipient,
    derivationPrefix: pay.remittance.derivationPrefix,
    derivationSuffix: pay.remittance.derivationSuffix,
    ...(opts.originator !== undefined ? { originator: opts.originator } : {}),
  })
  let derived: string | undefined
  try {
    derived = brc29PayeeScript(recipient, linkage)
  } catch {
    derived = undefined
  }
  if (derived !== pay.lockingScript) {
    throw new Brc29LinkageError('invalid', 'the key linkage does not derive the key the payment output pays')
  }

  const record = await signPayload(
    payment({ app: input.app, targetTxid: input.targetTxid, recipient, amount: input.satoshis, linkage }),
    { wallet, ...aip },
  )
  return {
    outputs: [
      { lockingScript: record.toHex(), satoshis: 0, outputDescription: input.recordDescription ?? 'Tip record' },
      {
        lockingScript: pay.lockingScript,
        satoshis: pay.satoshis,
        outputDescription: pay.outputDescription,
        customInstructions: pay.customInstructions,
      },
    ],
    record,
    payment: pay,
    linkage,
    remittance: pay.remittance,
  }
}
