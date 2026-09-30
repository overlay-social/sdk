/**
 * One error normalizer for every wallet path.
 *
 * Wallet failures arrive in many shapes: BRC-100 error objects with a numeric
 * `code`, HTTP error bodies from a local wallet, `DOMException`s from a passkey
 * prompt, Peck OS refusals, and plain English or Norwegian prose. Callers need
 * to branch on a few outcomes, so every failure is mapped to one
 * `WalletRequestError` with a stable `reason`:
 *
 *   cancelled           the user said no, closed a prompt, or declined a spend
 *   unavailable         no wallet is installed, reachable, unlocked or signed in
 *   insufficient_funds  the wallet cannot cover the outputs and the fee
 *   timeout             a wallet was reached but did not answer in time
 *   unknown             anything else
 *
 * The order of the checks matters and is fixed: already-normalized errors,
 * then prompt exceptions (a closed passkey prompt says "timed out" but is a
 * cancel), then numeric BRC-100 codes, then string codes, then the message
 * text. Only message text is read, never call arguments, so a post that
 * contains the word "denied" cannot change the outcome.
 */

export type WalletErrorReason = 'cancelled' | 'unavailable' | 'insufficient_funds' | 'timeout' | 'unknown'

/** BRC-100 numeric error code for insufficient funds (`WERR_INSUFFICIENT_FUNDS`). */
export const BRC100_INSUFFICIENT_FUNDS = 7

export class WalletRequestError extends Error {
  override readonly name = 'WalletRequestError'
  /** What went wrong, for branching. */
  readonly reason: WalletErrorReason
  /** The wallet's numeric BRC-100 error code, when it sent one. */
  readonly code?: number
  /** HTTP status, when the failure came from a local HTTP wallet. */
  readonly status?: number
  /** Extra fields from the wallet's error body (e.g. `reviewActionResults`), when present. */
  readonly details?: Record<string, unknown>

  constructor(
    reason: WalletErrorReason,
    message: string,
    options: { cause?: unknown; code?: number; status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.reason = reason
    if (options.code !== undefined) this.code = options.code
    if (options.status !== undefined) this.status = options.status
    if (options.details !== undefined) this.details = options.details
  }
}

export function isWalletRequestError(e: unknown): e is WalletRequestError {
  return e instanceof WalletRequestError
}

// Text rules, checked group by group in this order; the first match wins.
// English strings from @bsv/sdk, wallet-toolbox and the peck wallets, plus the
// Norwegian strings some desktop and phone wallets show.
const TEXT_RULES: ReadonlyArray<readonly [WalletErrorReason, readonly RegExp[]]> = [
  ['insufficient_funds', [
    /insufficient/i,
    /not enough (funds|balance|money|sats|satoshis)/i,
    /(no|out of) (funds|money)/i,
    /balance (is )?too low/i,
    /empty wallet/i,
    /nok saldo/i,
    /har ikke nok/i,
    /ikke nok (midler|saldo|penger)/i,
    /utilstrekkelig/i,
    /for lav saldo/i,
    /saldo\w* (din )?er for lav/i,
    /ingen midler/i,
    /tom (for )?(midler|saldo)/i,
    /dekker ikke/i,
  ]],
  ['cancelled', [
    /\brejected\b/i,
    /\bdeclined\b/i,
    /\bdenied\b/i,
    /user (cancelled|canceled|aborted)/i,
    /aborted by (the )?user/i,
    /request (was )?(cancelled|canceled)/i,
    /did not sign in/i,
    /prompt was closed/i,
    /no passkey was (chosen|made)/i,
    /\bavvist\b/i,
    /avbrutt av bruker/i,
    /\bavbrutt\b/i,
    /\bnektet\b/i,
    /kansellert/i,
  ]],
  ['timeout', [
    /timed? ?out/i,
    /timeout/i,
    /(not|didn'?t|did not) (respond|answer)/i,
    /no answer/i,
    /svarte ikke/i,
  ]],
  ['unavailable', [
    /failed to fetch/i,
    /fetch failed/i,
    /network ?error/i,
    /connection (refused|failed|error|closed|reset)/i,
    /econn(refused|reset|aborted)/i,
    /unreachable/i,
    /offline/i,
    /disconnected/i,
    /service unavailable/i,
    /\b(http|status)\s*50[234]\b/i,
    /no[ _]wallet/i,
    /isn'?t connected/i,
    /no bsv wallet/i,
    /no brc-100 wallet/i,
    /wallet (is )?locked/i,
    /is locked/i,
    /not connected to your wallet/i,
    /install a (bsv|brc-100) wallet/i,
    /fikk ikke kontakt/i,
    /frakoblet/i,
    /ikke tilgjengelig/i,
  ]],
]

function messageText(value: unknown): string {
  const parts: string[] = []
  const push = (m: unknown) => {
    if (typeof m !== 'string' || !m) return
    // @bsv/sdk's HTTP wallet client throws JSON.stringify({ call, args, message }).
    // Read only its `message`, never the arguments.
    if (m.startsWith('{')) {
      try {
        const j = JSON.parse(m) as { message?: unknown }
        if (typeof j.message === 'string') {
          parts.push(j.message)
          return
        }
      } catch {
        /* not JSON: use as is */
      }
    }
    parts.push(m)
  }
  try {
    if (typeof value === 'string') push(value)
    else if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>
      push(v.message)
      push(v.description)
      push(v.reason)
      if (typeof v.error === 'string') push(v.error)
      else if (v.error && typeof v.error === 'object') push((v.error as Record<string, unknown>).message)
    }
  } catch {
    /* never throw from normalization */
  }
  return parts.join('\n')
}

function structuredCode(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  for (const c of [v.code, (v.error as Record<string, unknown> | undefined)?.code, (v.err as Record<string, unknown> | undefined)?.code]) {
    if (c !== undefined && c !== null) return c
  }
  return undefined
}

function fromPromptException(value: unknown): WalletErrorReason | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { name?: unknown; kind?: unknown }
  // A passkey helper's own error kind, when it has one.
  if (v.kind === 'cancelled') return 'cancelled'
  if (v.kind === 'unsupported' || v.kind === 'no-prf') return 'unavailable'
  // WebAuthn: a closed or timed-out prompt is NotAllowedError; an aborted one AbortError.
  if (v.name === 'NotAllowedError' || v.name === 'AbortError') return 'cancelled'
  if (v.name === 'NotSupportedError' || v.name === 'SecurityError') return 'unavailable'
  if (v.name === 'TimeoutError') return 'timeout'
  return null
}

function fromCode(code: unknown): WalletErrorReason | null {
  if (code === BRC100_INSUFFICIENT_FUNDS) return 'insufficient_funds'
  if (typeof code !== 'string') return null
  const c = code.toLowerCase()
  if (c.includes('insufficient')) return 'insufficient_funds'
  if (/reject|cancel|abort|denied|declined/.test(c)) return 'cancelled'
  if (c.includes('timeout')) return 'timeout'
  if (/unavailable|network|offline|not_installed|no_wallet|econn/.test(c)) return 'unavailable'
  return null
}

function fromText(text: string): WalletErrorReason | null {
  if (!text) return null
  for (const [reason, rules] of TEXT_RULES) {
    if (rules.some((r) => r.test(text))) return reason
  }
  return null
}

/** Classify any thrown or returned wallet failure. */
export function classifyWalletError(value: unknown): WalletErrorReason {
  if (value instanceof WalletRequestError) return value.reason
  return fromPromptException(value) ?? fromCode(structuredCode(value)) ?? fromText(messageText(value)) ?? 'unknown'
}

/**
 * Turn any wallet failure into a `WalletRequestError`. The original value is
 * kept as `cause`, its message is kept, and a numeric BRC-100 `code` is
 * carried over, so code that checks `error.code === 7` keeps working.
 */
export function normalizeWalletError(value: unknown): WalletRequestError {
  if (value instanceof WalletRequestError) return value
  const reason = classifyWalletError(value)
  const text = messageText(value)
  const code = structuredCode(value)
  return new WalletRequestError(reason, text || `wallet request failed (${reason})`, {
    cause: value,
    code: typeof code === 'number' ? code : undefined,
  })
}
