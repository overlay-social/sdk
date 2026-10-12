/**
 * Is a signing key bound to an identity yet? The read a writer makes before
 * it adds a key binding (`keyBinding()` in the schema module) to a
 * transaction, so a binding is written once, not with every post.
 *
 * It asks the overlay's `GET /identity/<identity key>/signing-keys`, which
 * lists the identity's admitted, unspent bindings straight from the
 * `signing_keys` table the key-binding lookup service fills. That table is
 * what author resolution and tip attribution consult, so "bound" here means
 * bound for them too.
 *
 * Kept here, beside `submitToOverlay()`, rather than in the read client so a
 * page that writes does not download the whole read client for one GET.
 */
import { OverlaySubmitError } from './errors.js'

const DEFAULT_OVERLAY_URL = 'https://overlay.peck.to'
/** How long the overlay has to answer the binding lookup. */
export const DEFAULT_KEY_BINDING_TIMEOUT_MS = 8_000

const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/

/** One admitted, unspent binding of a signing key to the identity. */
export interface BoundSigningKey {
  /** The bound signing key (compressed public key, hex). */
  pubkey: string
  /** Its P2PKH address. */
  address: string
  /** The binding's `boundAt` hint, when it had one. */
  boundAt: number | null
  /** `<txid>.<vout>` of the binding output. */
  bindingOutpoint: string
}

export interface KeyBindingLookupOptions {
  /** Overlay base URL. Default `https://overlay.peck.to`. */
  overlayUrl?: string
  /** fetch to use. Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Milliseconds the overlay has to answer. Default 8000; 0 for no limit. */
  timeoutMs?: number
  /** Aborts the request; the call then rejects with the signal's reason. */
  signal?: AbortSignal
}

/**
 * The signing keys bound to `identityKey` (the wallet's identity key, not a
 * posting key), oldest first. Rejects with an `OverlaySubmitError` (`network`,
 * `timeout`, `rejected`, `server`, `invalid_response`, `invalid_input`) when the
 * overlay cannot say: an empty list means "none", never "unknown".
 */
export async function signingKeys(identityKey: string, options: KeyBindingLookupOptions = {}): Promise<BoundSigningKey[]> {
  if (typeof identityKey !== 'string' || !PUBKEY_RE.test(identityKey)) {
    throw new OverlaySubmitError('invalid_input', 'identityKey must be a compressed public key (66 hex characters)')
  }
  const baseUrl = options.overlayUrl ?? DEFAULT_OVERLAY_URL
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new OverlaySubmitError('invalid_input', 'overlayUrl must be a URL string')
  }
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/identity/${identityKey.toLowerCase()}/signing-keys`
  const timeoutMs = options.timeoutMs ?? DEFAULT_KEY_BINDING_TIMEOUT_MS
  const doFetch = options.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(i, init))

  const outer = options.signal
  if (outer?.aborted) throw outer.reason
  const ctrl = new AbortController()
  let timedOut = false
  const onAbort = () => ctrl.abort(outer?.reason)
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    : undefined

  try {
    let res: Response
    let body: unknown
    try {
      res = await doFetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal })
      const text = await res.text()
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = undefined
      }
    } catch (e) {
      if (outer?.aborted) throw outer.reason
      if (timedOut) throw new OverlaySubmitError('timeout', `no answer from ${url} within ${timeoutMs} ms`, { cause: e })
      throw new OverlaySubmitError('network', `could not reach ${url}: ${(e as Error)?.message ?? e}`, { cause: e })
    }
    if (!res.ok) {
      throw new OverlaySubmitError(res.status >= 500 ? 'server' : 'rejected', `overlay answered HTTP ${res.status} for ${url}`, {
        status: res.status,
      })
    }
    const list = (body as { signingKeys?: unknown } | undefined)?.signingKeys
    if (!Array.isArray(list)) {
      throw new OverlaySubmitError('invalid_response', `unexpected answer from ${url}: no signingKeys list`, { status: res.status })
    }
    const out: BoundSigningKey[] = []
    for (const row of list as Array<Record<string, unknown>>) {
      if (!row || typeof row.pubkey !== 'string' || typeof row.address !== 'string') continue
      out.push({
        pubkey: row.pubkey,
        address: row.address,
        boundAt: typeof row.boundAt === 'number' ? row.boundAt : null,
        bindingOutpoint: typeof row.bindingOutpoint === 'string' ? row.bindingOutpoint : '',
      })
    }
    return out
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}

/**
 * True when `signing` (a P2PKH address or a compressed public key) is bound to
 * `identityKey` by an admitted, unspent binding. Rejects (see `signingKeys()`)
 * when the overlay cannot say, so a caller can tell "not bound" from "unknown".
 *
 *   if (!(await hasKeyBinding(identityKey, loginKey))) {
 *     // add keyBinding() to this transaction, submit to tm_key-binding as well
 *   }
 */
export async function hasKeyBinding(identityKey: string, signing: string, options: KeyBindingLookupOptions = {}): Promise<boolean> {
  if (typeof signing !== 'string' || signing === '') {
    throw new OverlaySubmitError('invalid_input', 'signing must be a P2PKH address or a compressed public key')
  }
  const keys = await signingKeys(identityKey, options)
  if (PUBKEY_RE.test(signing)) {
    const pubkey = signing.toLowerCase()
    return keys.some((k) => k.pubkey.toLowerCase() === pubkey)
  }
  return keys.some((k) => k.address === signing)
}
