/**
 * Why a DM call failed. The client raises all of these; `server` carries the
 * message box's own error code in `serverCode` (for example
 * `ERR_DELIVERY_BLOCKED`).
 */
export type DmErrorCode =
  /** The argument is not usable (empty text, a malformed key or box name, …). */
  | 'invalid_argument'
  /** The value is not a DM envelope, or it did not decrypt. */
  | 'invalid_envelope'
  /** No response from the message box. */
  | 'network'
  /** The message box answered with a non-2xx status. */
  | 'http'
  /** The message box answered `{ status: 'error' }`. */
  | 'server'
  /** A 2xx answer that is not the expected shape. */
  | 'invalid_response'
  /** Live delivery needs a socket factory (`socket` option) and none was given. */
  | 'no_socket'
  /** The live socket did not authenticate in time, or the server refused it. */
  | 'live_unavailable'

export class DmError extends Error {
  override readonly name = 'DmError'
  /** Machine-readable reason; stable. */
  readonly code: DmErrorCode
  /** HTTP status of the message box's answer, or 0 when there was none. */
  readonly status: number
  /** The message box's error code (`code` in its JSON answer), when it sent one. */
  readonly serverCode?: string

  constructor(code: DmErrorCode, message: string, options?: { cause?: unknown; status?: number; serverCode?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.status = options?.status ?? 0
    this.serverCode = options?.serverCode
  }
}

export function isDmError(e: unknown): e is DmError {
  return e instanceof DmError
}
