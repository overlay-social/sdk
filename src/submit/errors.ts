/**
 * One error shape for everything that can go wrong when a signed transaction
 * is handed to the overlay.
 *
 * `code` says what to do about it:
 *
 *   invalid_input      nothing was sent: the argument is not BEEF, the topics
 *                      or the URL are unusable
 *   no_transaction     nothing was sent: a wallet result carried no
 *                      transaction (the wallet kept it, or only returned the
 *                      txid); the overlay finds that transaction on chain
 *   network            no HTTP response (offline, DNS, CORS, refused)
 *   timeout            the client's own timeout fired before the overlay answered
 *   unsupported_topic  the overlay does not run one of the topics (a bug in the caller)
 *   spv_failed         the overlay could not verify the transaction (merkle
 *                      proofs, source transactions or scripts); a bad merkle
 *                      path can be transient right after a new block
 *   rejected           the overlay refused the request (HTTP 4xx), e.g. bad BEEF
 *   server             the overlay or the proxy in front of it failed (HTTP 5xx)
 *   invalid_response   a 2xx answer that is not an admittance result
 *   not_admitted       the overlay took the transaction but no topic admitted
 *                      any output: it is not a record those topics index, or
 *                      the overlay already had this transaction
 *
 * The overlay may add messages, so treat an unknown situation like `rejected`
 * (4xx) or `server` (5xx).
 */
import type { Steak } from './submit.js'

export type OverlaySubmitErrorCode =
  | 'invalid_input'
  | 'no_transaction'
  | 'network'
  | 'timeout'
  | 'unsupported_topic'
  | 'spv_failed'
  | 'rejected'
  | 'server'
  | 'invalid_response'
  | 'not_admitted'

export class OverlaySubmitError extends Error {
  override readonly name = 'OverlaySubmitError'
  /** What went wrong, for branching. Stable. */
  readonly code: OverlaySubmitErrorCode
  /** HTTP status of the overlay's answer, or 0 when there was none. */
  readonly status: number
  /** The transaction id, when it is known (from the input or the Atomic BEEF header). */
  readonly txid?: string
  /** The overlay's admittance result, for `not_admitted`. */
  readonly steak?: Steak

  constructor(
    code: OverlaySubmitErrorCode,
    message: string,
    options: { status?: number; txid?: string; steak?: Steak; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.status = options.status ?? 0
    if (options.txid !== undefined) this.txid = options.txid
    if (options.steak !== undefined) this.steak = options.steak
  }
}

export function isOverlaySubmitError(e: unknown): e is OverlaySubmitError {
  return e instanceof OverlaySubmitError
}
