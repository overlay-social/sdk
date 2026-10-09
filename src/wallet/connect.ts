/**
 * `connect()`: find the user's BRC-100 wallet through whichever door this page
 * has, and hand back one `WalletInterface` whatever the door was.
 *
 * Doors, tried in this order:
 *  1. peckos   the page runs in a Peck OS window: the wallet through the desktop.
 *  2. cwi      a wallet injected into the page (`window.CWI`): mobile wallet
 *              browsers and extensions.
 *  3. local    a desktop wallet serving BRC-100 over HTTP on this machine
 *              (default `http://localhost:3321`; `local` may also be an ordered
 *              list of URLs, probed one after the other, first answer wins).
 *  4. passkey  an app-supplied opener, used when nothing else answered.
 *
 * Detection never prompts and never asks the wallet for keys: it is a Peck OS
 * `hello`, a property check, and a `getVersion` call to the local wallet with
 * a short timeout. Prompts come with the first real request. The passkey door
 * is opened lazily too: `connect()` returns without calling the opener, and
 * the wallet's first method call opens it (WebAuthn needs the user's gesture,
 * so make that first call from a click).
 *
 * Browsers may ask the user before a page talks to a local-network address.
 * Call `connect()` from a user gesture, or pass `local: false` to skip that
 * door.
 *
 * Every error a wallet method throws is normalized to a `WalletRequestError`.
 */
import type { WalletInterface } from '@bsv/sdk'
import { PeckOS, WALLET_METHODS, type PeckOSClient, type PeckOSSession, type WalletMethod } from '../peckos/index.js'
import { WalletRequestError, normalizeWalletError } from './errors.js'

export type WalletVia = 'peckos' | 'cwi' | 'local' | 'passkey'

/** The user's wallet, whichever door it came through. */
export type ConnectedWallet = WalletInterface & {
  /** Which door the wallet came through. */
  readonly via: WalletVia
  /** The Peck OS session when `via` is `peckos` (for `notify`, `open`, …), else null. */
  readonly peckos: PeckOSSession | null
}

/** Something with the BRC-100 methods, e.g. a `WalletClient` or a passkey-opened wallet. */
export type WalletLike = Partial<Record<WalletMethod, (args: never, originator?: string) => Promise<unknown>>>

export const DEFAULT_LOCAL_WALLET_URL = 'http://localhost:3321'
/** How long the local wallet has to answer `getVersion` during detection. */
export const LOCAL_PROBE_TIMEOUT_MS = 1500

export interface ConnectOptions {
  /**
   * The app's domain, passed to injected and local wallets as the BRC-100
   * originator. Browsers identify the page themselves; outside a browser it is
   * sent as the `Originator` header.
   */
  originator?: string
  /** The Peck OS client to ask. Default: the page's `PeckOS`. `false` skips the door. */
  peckos?: PeckOSClient | false
  /**
   * Base URL of the local wallet. Default `http://localhost:3321`. `false` skips the door.
   *
   * An array is an ordered list of candidates, for apps that know that wallets
   * listen on different ports (`['http://localhost:3321', 'http://localhost:2121']`).
   * They are probed one after the other, never in parallel, and the first that
   * answers `getVersion` is used for the whole session. An empty array skips
   * the door, like `false`.
   */
  local?: string | readonly string[] | false
  /** Milliseconds each local wallet candidate has to answer during detection. Default 1500. */
  localProbeTimeoutMs?: number
  /**
   * Milliseconds each local wallet request may take after detection. Default:
   * no limit, because many requests wait for the user to approve them.
   */
  localRequestTimeoutMs?: number
  /** fetch for the local wallet. Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /**
   * The passkey door: opens (or creates) a wallet the app controls, usually
   * after a WebAuthn prompt. Called on the first wallet request, never by
   * `connect()` itself. If it rejects, the next request calls it again.
   */
  passkey?: () => Promise<WalletLike>
  /** The global object to look for `CWI` on. Default `globalThis`. For tests. */
  getGlobal?: () => { CWI?: unknown } | undefined
}

// ── the wallet wrapper ──────────────────────────────────────────

type Call = (method: WalletMethod, args: unknown, originator?: string) => Promise<unknown>

function wrap(via: WalletVia, peckos: PeckOSSession | null, call: Call, defaultOriginator?: string): ConnectedWallet {
  const w: Record<string, unknown> = { via, peckos }
  for (const m of WALLET_METHODS) {
    w[m] = async (args: unknown = {}, originator?: string) => {
      try {
        return await call(m, args, originator ?? defaultOriginator)
      } catch (e) {
        throw normalizeWalletError(e)
      }
    }
  }
  return w as unknown as ConnectedWallet
}

function callOn(target: WalletLike, method: WalletMethod, args: unknown, originator?: string): Promise<unknown> {
  const fn = target[method] as ((a: unknown, o?: string) => Promise<unknown>) | undefined
  if (typeof fn !== 'function') {
    return Promise.reject(new WalletRequestError('unknown', `this wallet does not support ${method}`))
  }
  return fn.call(target, args, originator)
}

// ── the local HTTP wallet ───────────────────────────────────────

interface HttpOptions {
  fetch: typeof fetch
  timeoutMs?: number
  originator?: string
}

async function httpCall(base: string, method: string, args: unknown, opts: HttpOptions): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  // Browsers set Origin themselves and forbid overriding it; elsewhere the
  // wallet learns the caller from these headers, as with @bsv/sdk's client.
  if (opts.originator && typeof (globalThis as { window?: unknown }).window === 'undefined') {
    const origin = opts.originator.includes('://') ? opts.originator : `http://${opts.originator}`
    headers.origin = origin
    headers.originator = origin
  }
  const ctrl = new AbortController()
  const exchange = async (): Promise<unknown> => {
    let res: Response
    let text: string
    try {
      res = await opts.fetch(`${base}/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args ?? {}),
        signal: ctrl.signal,
      })
      text = await res.text()
    } catch (e) {
      throw new WalletRequestError('unavailable', `could not reach the local wallet at ${base}`, { cause: e })
    }
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (res.ok) return body
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const { message, code, ...rest } = b
    delete rest.isError
    const failure = {
      message: typeof message === 'string' ? message : `the local wallet answered ${method} with HTTP ${res.status}`,
      code,
    }
    throw new WalletRequestError(normalizeWalletError(failure).reason, failure.message, {
      code: typeof code === 'number' ? code : undefined,
      status: res.status,
      details: Object.keys(rest).length ? rest : undefined,
    })
  }
  if (!opts.timeoutMs) return exchange()
  // Race the exchange against the timeout, so a fetch that ignores the abort
  // signal cannot hang the caller either.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(new WalletRequestError('timeout', `the local wallet at ${base} did not answer ${method} in time`))
    }, opts.timeoutMs)
  })
  try {
    return await Promise.race([exchange(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function probeLocal(base: string, opts: HttpOptions): Promise<boolean> {
  try {
    const r = (await httpCall(base, 'getVersion', {}, opts)) as { version?: unknown } | undefined
    return typeof r?.version === 'string'
  } catch {
    return false
  }
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, '')

/**
 * The base URLs to probe, in order. A single string (or nothing) behaves as it
 * always did; in a list, blanks and duplicates are dropped.
 */
function localCandidates(local: string | readonly string[] | undefined): string[] {
  if (typeof local === 'string') return [trimSlashes(local)]
  if (local === undefined) return [trimSlashes(DEFAULT_LOCAL_WALLET_URL)]
  return [...new Set(local.map(trimSlashes).filter(Boolean))]
}

// ── connect ─────────────────────────────────────────────────────

function injected(getGlobal: () => { CWI?: unknown } | undefined): WalletLike | null {
  try {
    const cwi = getGlobal()?.CWI as WalletLike | undefined
    return cwi && typeof cwi === 'object' && typeof cwi.getPublicKey === 'function' ? cwi : null
  } catch {
    return null
  }
}

/**
 * Find the user's wallet. Resolves to a `ConnectedWallet` (a BRC-100
 * `WalletInterface` plus `via`), or rejects with a `WalletRequestError` whose
 * reason is `unavailable` when no door answered.
 */
export async function connect(options: ConnectOptions = {}): Promise<ConnectedWallet> {
  const { originator } = options

  // 1. Peck OS
  if (options.peckos !== false) {
    const os = await (options.peckos ?? PeckOS).detect().catch(() => null)
    if (os) return wrap('peckos', os, (m, args) => callOn(os.wallet as WalletLike, m, args), undefined)
  }

  // 2. An injected wallet
  const cwi = injected(options.getGlobal ?? (() => globalThis as { CWI?: unknown }))
  if (cwi) return wrap('cwi', null, (m, args, o) => callOn(cwi, m, args, o), originator)

  // 3. The local HTTP wallet
  const fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined)
  if (options.local !== false && fetchImpl) {
    const probe = { fetch: fetchImpl, timeoutMs: options.localProbeTimeoutMs ?? LOCAL_PROBE_TIMEOUT_MS, originator }
    for (const base of localCandidates(options.local)) {
      if (await probeLocal(base, probe)) {
        const perCall = { fetch: fetchImpl, timeoutMs: options.localRequestTimeoutMs, originator }
        return wrap('local', null, (m, args, o) => httpCall(base, m, args, { ...perCall, originator: o }), originator)
      }
    }
  }

  // 4. The passkey door, opened on first use
  const opener = options.passkey
  if (opener) {
    let opening: Promise<WalletLike> | null = null
    const open = (): Promise<WalletLike> => {
      opening ??= opener().catch((e: unknown) => {
        opening = null
        throw e
      })
      return opening
    }
    return wrap('passkey', null, async (m, args, o) => callOn(await open(), m, args, o), originator)
  }

  throw new WalletRequestError(
    'unavailable',
    'No wallet found: not in Peck OS, no injected wallet, and no local wallet answered.',
  )
}
