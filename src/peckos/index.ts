/**
 * Peck OS app client.
 *
 * An app that runs inside a Peck OS window can use this module to find out that it is
 * embedded, and then reaches the user's BRC-100 wallet through the desktop: no login
 * screen and no wallet prompt of its own. Outside Peck OS `detect()` resolves to `null`
 * and the app behaves as before.
 *
 * ```ts
 * import { PeckOS } from '@overlay-social/sdk/peckos'
 *
 * const os = await PeckOS.detect()          // null when not inside Peck OS
 * if (os !== null) {
 *   if (!os.connected) await os.connect()   // Peck apps are connected already
 *   const { publicKey } = await os.wallet.getPublicKey({ identityKey: true })
 *   os.notify('Posted', 'Your post is on chain')
 *   os.open('https://peck.bio/')            // opens in the Peck OS window for that app
 * }
 * ```
 *
 * Apps that already use `@bsv/sdk` can take the same wallet as a substrate:
 * `new WalletClient(new XDMSubstrate(os.origin))`.
 *
 * Protocol: standard BRC-100 cross-document invocations (`{type: 'CWI'}`) for wallet
 * calls, plus `{type: 'peckos'}` messages for the desktop. Every message goes to the
 * exact trusted origin and every reply must come from it (and from the parent window),
 * so a page that merely frames the app gets nothing.
 *
 * The module has no dependencies and does not touch `window` when it is imported, so it
 * is safe to import during server-side rendering; `detect()` then resolves to `null`.
 */

/** Origins that are always accepted as the parent window (the Peck OS desktop). */
export const PECKOS_TRUSTED_ORIGINS: readonly string[] = ['https://os.peck.to']

/**
 * For local development only. Set it from the app's own origin, e.g. in the console:
 * `localStorage.setItem('peckos:trust', 'http://127.0.0.1:5173')`
 * Other sites cannot set it, so it cannot be used to trick a deployed app. Only loopback
 * origins are taken from it, so even a value planted in the app's storage (an XSS, a shared
 * browser) can never make a real site the trusted parent of a deployed app.
 */
export const PECKOS_DEV_TRUST_KEY = 'peckos:trust'
const DEV_TRUST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

/** How long `detect()` waits for the `hello` reply by default. */
export const PECKOS_DETECT_TIMEOUT_MS = 1200
/** How long the desktop calls (`open`, `notify`, `setTitle`, `setBadge`) wait for a reply. */
export const PECKOS_CALL_TIMEOUT_MS = 5000

/** The BRC-100 wallet methods forwarded to Peck OS. */
export const WALLET_METHODS = [
  'createAction', 'signAction', 'abortAction', 'listActions', 'internalizeAction', 'listOutputs',
  'relinquishOutput', 'getPublicKey', 'revealCounterpartyKeyLinkage', 'revealSpecificKeyLinkage',
  'encrypt', 'decrypt', 'createHmac', 'verifyHmac', 'createSignature', 'verifySignature',
  'acquireCertificate', 'listCertificates', 'proveCertificate', 'relinquishCertificate',
  'discoverByIdentityKey', 'discoverByAttributes', 'isAuthenticated', 'waitForAuthentication',
  'getHeight', 'getHeaderForHeight', 'getNetwork', 'getVersion',
] as const

export type WalletMethod = (typeof WALLET_METHODS)[number]

/**
 * The user's wallet, reached through Peck OS. Same method names and argument shapes as
 * BRC-100 (`WalletInterface` in `@bsv/sdk`). Results are `any` so the object can be passed
 * to code that expects a `WalletInterface` without casts.
 */
export type PeckOSWallet = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [M in WalletMethod]: (args?: Record<string, unknown>) => Promise<any>
}

/** A wallet call that Peck OS answered with an error (`code` is the BRC-100 error code). */
export type PeckOSWalletError = Error & { code?: number }

/** The `hello` / `connect` reply: what Peck OS says about this window. */
export interface PeckOSInfo {
  os?: string
  protocol?: number
  /** Id of the app this window belongs to. */
  app?: string
  connected?: boolean
  identityKey?: string
  name?: string
  network?: string
  accent?: string
  [key: string]: unknown
}

export interface PeckOSDetectOptions {
  /** Extra parent origins to accept for this page (a local Peck OS during development, say). */
  trusted?: string[]
  /** Milliseconds to wait for the `hello` reply. Default 1200. */
  timeout?: number
}

/** The parts of a `MessageEvent` this module reads. */
export interface PeckOSMessageEvent {
  readonly source: unknown
  readonly origin: string
  readonly data: unknown
}

/** The parts of `window` this module uses. A real `Window` satisfies it. */
export interface PeckOSWindow {
  readonly parent: PeckOSWindow
  readonly location?: { readonly ancestorOrigins?: ArrayLike<string> }
  readonly localStorage?: { getItem(key: string): string | null }
  postMessage(message: unknown, targetOrigin: string): void
  addEventListener(type: 'message', listener: (event: PeckOSMessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: PeckOSMessageEvent) => void): void
}

export interface CreatePeckOSOptions {
  /**
   * Resolves the window the app runs in, at call time. Defaults to the global `window`
   * (or `undefined` where there is none). Mostly useful in tests.
   */
  getWindow?: () => PeckOSWindow | undefined
}

export interface PeckOSClient {
  /**
   * Resolves to a session when this page is a window inside Peck OS, otherwise to `null`.
   * The first call decides for the lifetime of the page: later calls return the same promise
   * and ignore their options.
   */
  detect(options?: PeckOSDetectOptions): Promise<PeckOSSession | null>
}

type Family = 'CWI' | 'peckos'

function defaultWindow(): PeckOSWindow | undefined {
  return typeof window === 'undefined' ? undefined : window
}

function trustedOrigins(win: PeckOSWindow, extra: readonly string[] | undefined): string[] {
  const list = [...PECKOS_TRUSTED_ORIGINS, ...(extra ?? [])]
  try {
    const dev = win.localStorage?.getItem(PECKOS_DEV_TRUST_KEY)
    if (dev) list.push(...dev.split(',').map((s) => s.trim()).filter((o) => DEV_TRUST_ORIGIN.test(o)))
  } catch {
    /* storage blocked: no dev trust */
  }
  return [...new Set(list)]
}

function randomId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

// `undefined` stays `undefined` so `new Error(undefined)` keeps an empty message.
function messageOf(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value)
}

function send<T>(
  win: PeckOSWindow,
  origin: string,
  family: Family,
  call: string,
  args: Record<string, unknown>,
  timeout?: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = randomId()
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      win.removeEventListener('message', onMessage)
      if (timer !== undefined) clearTimeout(timer)
    }
    const onMessage = (e: PeckOSMessageEvent): void => {
      // Only the parent window, and only from the exact origin we sent to.
      if (e.source !== win.parent || e.origin !== origin) return
      const d = e.data as Record<string, unknown> | null
      if (typeof d !== 'object' || d === null || d.id !== id) return
      if (family === 'CWI') {
        if (d.type !== 'CWI' || d.isInvocation !== false) return
        cleanup()
        if (d.status === 'error') {
          reject(Object.assign(new Error(messageOf(d.description)), { code: d.code }))
        } else {
          resolve(d.result as T)
        }
      } else {
        if (d.type !== 'peckos' || d.isReply !== true) return
        cleanup()
        if ('error' in d) reject(new Error(messageOf(d.error)))
        else resolve(d.result as T)
      }
    }
    win.addEventListener('message', onMessage)
    if (timeout !== undefined) {
      timer = setTimeout(() => {
        cleanup()
        reject(new Error('Peck OS did not answer'))
      }, timeout)
    }
    const msg =
      family === 'CWI'
        ? { type: 'CWI', isInvocation: true, id, call, args }
        : { type: 'peckos', id, call, args }
    try {
      win.parent.postMessage(msg, origin)
    } catch (err) {
      // An unusable target origin makes postMessage throw; do not leave the listener behind.
      cleanup()
      reject(err)
    }
  })
}

/** A window inside Peck OS: the wallet and the desktop calls. Obtain one with `PeckOS.detect()`. */
export class PeckOSSession {
  /** The Peck OS origin that answered. Every message goes to, and is accepted from, this origin only. */
  readonly origin: string
  /** The user's wallet, reached through Peck OS. Same method names and arguments as BRC-100. */
  readonly wallet: PeckOSWallet
  private info: PeckOSInfo
  private readonly win: PeckOSWindow

  /** @internal Use `PeckOS.detect()`. */
  constructor(win: PeckOSWindow, origin: string, info: PeckOSInfo) {
    this.win = win
    this.origin = origin
    this.info = info
    const wallet = {} as Record<WalletMethod, PeckOSWallet[WalletMethod]>
    for (const m of WALLET_METHODS) {
      wallet[m] = (args = {}) => send(win, origin, 'CWI', m, args)
    }
    this.wallet = wallet
  }

  get connected(): boolean {
    return this.info.connected === true
  }

  get identityKey(): string | undefined {
    return this.info.identityKey
  }

  get name(): string | undefined {
    return this.info.name
  }

  /**
   * Peck apps are connected from the start; other apps ask the user once, inside Peck OS.
   * Rejects if the user says no. Has no timeout, because a person is answering.
   */
  async connect(): Promise<PeckOSInfo> {
    this.info = await send<PeckOSInfo>(this.win, this.origin, 'peckos', 'connect', {})
    return this.info
  }

  /** Opens an http(s) link in the Peck OS window for the app it belongs to, or a new tab. */
  open(url: string): Promise<{ opened: boolean }> {
    return send(this.win, this.origin, 'peckos', 'open', { url: String(url) }, PECKOS_CALL_TIMEOUT_MS)
  }

  /** Shows a desktop notification (Peck OS allows at most one per 3 seconds per app). */
  notify(title: string, body = ''): Promise<{ shown: boolean }> {
    return send(this.win, this.origin, 'peckos', 'notify', { title, body }, PECKOS_CALL_TIMEOUT_MS)
  }

  /** Sets the text next to the app name in the window title bar. */
  setTitle(title: string): Promise<Record<string, never>> {
    return send(this.win, this.origin, 'peckos', 'setTitle', { title }, PECKOS_CALL_TIMEOUT_MS)
  }

  /** Sets the number on the app's Dock icon (0 clears it). */
  setBadge(count: number): Promise<Record<string, never>> {
    return send(this.win, this.origin, 'peckos', 'setBadge', { count }, PECKOS_CALL_TIMEOUT_MS)
  }
}

/**
 * Creates a Peck OS client bound to a window. Most apps use the ready-made `PeckOS`
 * export; this exists so the window can be supplied explicitly (tests, embedded contexts).
 */
export function createPeckOS(options: CreatePeckOSOptions = {}): PeckOSClient {
  const getWindow = options.getWindow ?? defaultWindow
  let detecting: Promise<PeckOSSession | null> | null = null

  return {
    detect({ trusted, timeout = PECKOS_DETECT_TIMEOUT_MS }: PeckOSDetectOptions = {}) {
      if (detecting !== null) return detecting
      const win = getWindow()
      // No window (server-side rendering, a worker): certainly not inside Peck OS.
      if (win === undefined) return Promise.resolve(null)
      detecting = (async () => {
        if (win.parent === win) return null
        const origins = trustedOrigins(win, trusted)
        // Chromium and Safari tell us who framed us; skip the wait when it is not Peck OS.
        const ancestor = win.location?.ancestorOrigins?.[0]
        const candidates = ancestor !== undefined ? origins.filter((o) => o === ancestor) : origins
        if (candidates.length === 0) return null
        // postMessage with an exact target origin is dropped unless the parent really is that
        // origin, so only a genuine Peck OS can ever see or answer this.
        const attempts = candidates.map((origin) =>
          send<PeckOSInfo>(win, origin, 'peckos', 'hello', {}, timeout).then((info) => ({ origin, info })),
        )
        try {
          const { origin, info } = await Promise.any(attempts)
          return new PeckOSSession(win, origin, info)
        } catch {
          return null
        }
      })()
      return detecting
    },
  }
}

/** The Peck OS client for the current page. */
export const PeckOS: PeckOSClient = /*#__PURE__*/ createPeckOS()

export default PeckOS
