import { describe, expect, it, vi } from 'vitest'
import type { PeckOSClient, PeckOSSession } from '../src/peckos/index.js'
import {
  WalletRequestError,
  classifyWalletError,
  connect,
  normalizeWalletError,
  type WalletLike,
} from '../src/wallet/index.js'

// ── fakes ───────────────────────────────────────────────────────

/** A wallet whose every method records its call and answers from `answers`. */
function fakeWallet(answers: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown; originator?: string }> = []
  const w: Record<string, unknown> = {}
  for (const m of ['getPublicKey', 'createAction', 'createSignature', 'getVersion', 'isAuthenticated']) {
    w[m] = async (args: unknown, originator?: string) => {
      calls.push({ method: m, args, originator })
      const a = answers[m]
      if (a instanceof Error) throw a
      return a ?? { ok: m }
    }
  }
  return { wallet: w as WalletLike, calls }
}

function fakePeckOS(session: Partial<PeckOSSession> | null): PeckOSClient & { detects: number } {
  const client = {
    detects: 0,
    async detect() {
      client.detects++
      return session as PeckOSSession | null
    },
  }
  return client
}

const noPeckOS = fakePeckOS(null)
const noGlobal = () => ({})

interface HttpCall { url: string; body: unknown; headers: Record<string, string> }

function fakeFetch(handler: (url: string, body: unknown) => Response | Promise<Response>) {
  const calls: HttpCall[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return handler(call.url, call.body)
  }) as typeof fetch
  return { fetch: f, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const unreachable = fakeFetch(() => {
  throw new TypeError('fetch failed')
})

// ── connect(): the doors ────────────────────────────────────────

describe('connect(): Peck OS', () => {
  it('uses the Peck OS wallet first and exposes the session', async () => {
    const { wallet, calls } = fakeWallet({ getPublicKey: { publicKey: '02ab' } })
    const session = { wallet, notify: vi.fn() } as unknown as PeckOSSession
    const cwi = fakeWallet()
    const w = await connect({ peckos: fakePeckOS(session), getGlobal: () => ({ CWI: cwi.wallet }), fetch: unreachable.fetch })
    expect(w.via).toBe('peckos')
    expect(w.peckos).toBe(session)
    expect(await w.getPublicKey({ identityKey: true })).toEqual({ publicKey: '02ab' })
    expect(calls).toEqual([{ method: 'getPublicKey', args: { identityKey: true }, originator: undefined }])
    expect(cwi.calls).toHaveLength(0)
    expect(unreachable.calls).toHaveLength(0)
  })

  it('does not call the wallet while detecting', async () => {
    const { wallet, calls } = fakeWallet()
    await connect({ peckos: fakePeckOS({ wallet } as unknown as PeckOSSession) })
    expect(calls).toHaveLength(0)
  })

  it('can be skipped', async () => {
    const os = fakePeckOS({ wallet: fakeWallet().wallet } as unknown as PeckOSSession)
    const cwi = fakeWallet()
    const w = await connect({ peckos: false, getGlobal: () => ({ CWI: cwi.wallet }) })
    expect(w.via).toBe('cwi')
    expect(os.detects).toBe(0)
  })
})

describe('connect(): injected wallet (window.CWI)', () => {
  it('is used when not in Peck OS, with the originator passed through', async () => {
    const { wallet, calls } = fakeWallet({ createAction: { txid: 'ab' } })
    const w = await connect({ peckos: noPeckOS, getGlobal: () => ({ CWI: wallet }), originator: 'app.example', fetch: unreachable.fetch })
    expect(w.via).toBe('cwi')
    expect(w.peckos).toBeNull()
    expect(calls).toHaveLength(0) // detection is a property check only
    await w.createAction({ description: 'x', outputs: [] })
    expect(calls[0]).toMatchObject({ method: 'createAction', originator: 'app.example' })
    expect(unreachable.calls).toHaveLength(0)
  })

  it('ignores a CWI without BRC-100 methods', async () => {
    await expect(connect({ peckos: noPeckOS, getGlobal: () => ({ CWI: {} }), local: false })).rejects.toMatchObject({
      reason: 'unavailable',
    })
  })
})

describe('connect(): local wallet over HTTP', () => {
  it('probes getVersion, then posts each call as JSON', async () => {
    const { fetch, calls } = fakeFetch((url, body) => {
      if (url.endsWith('/getVersion')) return json({ version: 'wallet-1.0' })
      return json({ echoed: body })
    })
    const w = await connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch, local: 'http://127.0.0.1:3321/' })
    expect(w.via).toBe('local')
    expect(calls.map((c) => c.url)).toEqual(['http://127.0.0.1:3321/getVersion'])
    expect(await w.createSignature({ data: [1], protocolID: [1, 'identity'], keyID: '1' })).toEqual({
      echoed: { data: [1], protocolID: [1, 'identity'], keyID: '1' },
    })
    expect(calls[1]).toMatchObject({ url: 'http://127.0.0.1:3321/createSignature' })
    expect(calls[1]!.headers['content-type']).toBe('application/json')
  })

  it('sends the originator as headers outside a browser', async () => {
    const { fetch, calls } = fakeFetch(() => json({ version: 'v' }))
    await connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch, originator: 'app.example' })
    expect(calls[0]!.headers).toMatchObject({ origin: 'http://app.example', originator: 'http://app.example' })
  })

  it('turns an error body into a typed error that keeps the BRC-100 code', async () => {
    const { fetch } = fakeFetch((url) => url.endsWith('/getVersion')
      ? json({ version: 'v' })
      : json({ isError: true, code: 7, message: 'Insufficient funds in the available inputs', moreSatoshisNeeded: 120 }, 400))
    const w = await connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch })
    const err = await w.createAction({ description: 'x', outputs: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WalletRequestError)
    expect(err).toMatchObject({
      reason: 'insufficient_funds',
      code: 7,
      status: 400,
      details: { moreSatoshisNeeded: 120 },
      message: 'Insufficient funds in the available inputs',
    })
  })

  it('falls through when the local wallet does not answer the probe', async () => {
    const slow = fakeFetch((_url) => new Promise<Response>(() => {}))
    vi.useFakeTimers()
    try {
      const pending = connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch: slow.fetch, localProbeTimeoutMs: 50 }).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(60)
      expect(await pending).toMatchObject({ reason: 'unavailable' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not accept an answer without a version', async () => {
    const { fetch } = fakeFetch(() => json({ hello: true }))
    await expect(connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch })).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('can be skipped', async () => {
    const { fetch, calls } = fakeFetch(() => json({ version: 'v' }))
    await expect(connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch, local: false })).rejects.toBeInstanceOf(WalletRequestError)
    expect(calls).toHaveLength(0)
  })

  it('reports a wallet that went away after detection as unavailable', async () => {
    let up = true
    const { fetch } = fakeFetch(() => {
      if (!up) throw new TypeError('fetch failed')
      return json({ version: 'v' })
    })
    const w = await connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch })
    up = false
    await expect(w.getPublicKey({ identityKey: true })).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('connect(): passkey door', () => {
  it('is opened on the first request, not by connect(), and only once', async () => {
    const { wallet, calls } = fakeWallet({ getPublicKey: { publicKey: '03cd' } })
    const opener = vi.fn(async () => wallet)
    const w = await connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch: unreachable.fetch, passkey: opener, originator: 'peck.to' })
    expect(w.via).toBe('passkey')
    expect(opener).not.toHaveBeenCalled()
    expect(await w.getPublicKey({ identityKey: true })).toEqual({ publicKey: '03cd' })
    await w.getPublicKey({ identityKey: true })
    expect(opener).toHaveBeenCalledTimes(1)
    expect(calls[0]).toMatchObject({ method: 'getPublicKey', originator: 'peck.to' })
  })

  it('maps a closed passkey prompt to cancelled and lets the user try again', async () => {
    const { wallet } = fakeWallet()
    const closed = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' })
    const opener = vi.fn().mockRejectedValueOnce(closed).mockResolvedValueOnce(wallet)
    const w = await connect({ peckos: noPeckOS, getGlobal: noGlobal, local: false, passkey: opener })
    await expect(w.getPublicKey({ identityKey: true })).rejects.toMatchObject({ reason: 'cancelled' })
    await expect(w.getPublicKey({ identityKey: true })).resolves.toBeDefined()
    expect(opener).toHaveBeenCalledTimes(2)
  })

  it('is not used when another door answered', async () => {
    const opener = vi.fn()
    const cwi = fakeWallet()
    const w = await connect({ peckos: noPeckOS, getGlobal: () => ({ CWI: cwi.wallet }), passkey: opener })
    expect(w.via).toBe('cwi')
    expect(opener).not.toHaveBeenCalled()
  })
})

describe('connect(): nothing found', () => {
  it('rejects with reason unavailable', async () => {
    const err = await connect({ peckos: noPeckOS, getGlobal: noGlobal, fetch: unreachable.fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WalletRequestError)
    expect(err).toMatchObject({ reason: 'unavailable' })
  })
})

describe('wrapped wallet', () => {
  it('normalizes every error a method throws', async () => {
    const { wallet } = fakeWallet({ createAction: Object.assign(new Error('User rejected the request'), { code: 1 }) })
    const w = await connect({ peckos: noPeckOS, getGlobal: () => ({ CWI: wallet }) })
    const err = await w.createAction({ description: 'x', outputs: [] }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'WalletRequestError', reason: 'cancelled', code: 1 })
    expect((err as WalletRequestError).cause).toBeInstanceOf(Error)
  })

  it('rejects a method the wallet does not have', async () => {
    const { wallet } = fakeWallet()
    const w = await connect({ peckos: noPeckOS, getGlobal: () => ({ CWI: wallet }) })
    await expect(w.listOutputs({ basket: 'x' })).rejects.toMatchObject({ reason: 'unknown' })
  })
})

// ── the normalizer ──────────────────────────────────────────────

describe('classifyWalletError()', () => {
  const cases: Array<[unknown, string]> = [
    // insufficient funds
    [Object.assign(new Error('whatever'), { code: 7 }), 'insufficient_funds'],
    [new Error('Insufficient funds in the available inputs to cover the cost of the required outputs'), 'insufficient_funds'],
    [{ error: { code: 'ERR_INSUFFICIENT_FUNDS' } }, 'insufficient_funds'],
    [new Error('Ikke nok midler til å betale gebyret'), 'insufficient_funds'],
    [new Error('Saldoen din er for lav'), 'insufficient_funds'],
    // cancelled
    [new Error('User rejected the request'), 'cancelled'],
    [new Error('Declined in Peck OS'), 'cancelled'],
    [new Error('Declined in Peck OS: this app reached its spending limit for this session'), 'cancelled'],
    [new Error('You did not sign in to Peck Ink with your wallet'), 'cancelled'],
    [Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }), 'cancelled'],
    [Object.assign(new Error('The passkey prompt was closed or timed out. Nothing was changed.'), { kind: 'cancelled' }), 'cancelled'],
    [new Error('The passkey prompt was closed or timed out. Nothing was changed.'), 'cancelled'],
    [new Error('Forespørselen ble avvist'), 'cancelled'],
    // timeout
    [new Error('Peck OS did not answer'), 'timeout'],
    [new Error('Request timed out after 30s'), 'timeout'],
    [Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }), 'timeout'],
    // unavailable
    [new TypeError('Failed to fetch'), 'unavailable'],
    [new Error('No wallet available over any communication substrate. Install a BSV wallet today!'), 'unavailable'],
    [new Error('NO_WALLET'), 'unavailable'],
    [new Error('No wallet answered'), 'unavailable'],
    [new Error('Peck OS is locked. Unlock it with your passkey again.'), 'unavailable'],
    [new Error('Wallet is locked — unlock it, then choose Try again.'), 'unavailable'],
    [new Error('Peck Ink is not connected to your wallet in Peck OS'), 'unavailable'],
    [new Error('Phone bridge HTTP 503'), 'unavailable'],
    [Object.assign(new Error('x'), { name: 'NotSupportedError' }), 'unavailable'],
    // unknown
    [new Error('Invalid parameter: outputs[0].lockingScript'), 'unknown'],
    [undefined, 'unknown'],
    ['', 'unknown'],
  ]
  for (const [value, reason] of cases) {
    it(`${reason}: ${value instanceof Error ? value.message || value.name : JSON.stringify(value)}`, () => {
      expect(classifyWalletError(value)).toBe(reason)
    })
  }

  it('reads only the message of an SDK HTTP error, never its arguments', () => {
    const e = new Error(JSON.stringify({ call: 'createAction', args: { description: 'access denied, insufficient' }, message: 'HTTP Client error 500' }))
    expect(classifyWalletError(e)).toBe('unknown')
  })

  it('checks prompt exceptions before text', () => {
    // A closed passkey prompt says "timed out" but is a cancel.
    const e = Object.assign(new Error('The operation timed out'), { name: 'NotAllowedError' })
    expect(classifyWalletError(e)).toBe('cancelled')
  })
})

describe('normalizeWalletError()', () => {
  it('keeps the message, the cause and a numeric code', () => {
    const original = Object.assign(new Error('Insufficient funds'), { code: 7 })
    const n = normalizeWalletError(original)
    expect(n).toMatchObject({ reason: 'insufficient_funds', code: 7, message: 'Insufficient funds' })
    expect(n.cause).toBe(original)
  })

  it('returns an already-normalized error unchanged', () => {
    const e = new WalletRequestError('timeout', 'slow')
    expect(normalizeWalletError(e)).toBe(e)
  })

  it('gives a message to values without one', () => {
    expect(normalizeWalletError(null).message).toMatch(/unknown/)
  })
})
