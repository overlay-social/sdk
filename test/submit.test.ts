import { describe, expect, it, vi } from 'vitest'
import {
  OVERLAY_TOPICS,
  OverlaySubmitError,
  isOverlaySubmitError,
  submitToOverlay,
  type SubmitInput,
} from '../src/submit/index.js'

// ── fakes ───────────────────────────────────────────────────────

// Not a repeating pattern, so a byte-order mistake cannot hide.
const TXID = Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, '0')).join('')

/**
 * Atomic BEEF header (01010101, then the txid in internal byte order, which is
 * the reverse of how a txid is shown), a BEEF V1 marker and filler. Only the
 * header matters to the client.
 */
function atomicBeef(txid = TXID): number[] {
  const id = (txid.match(/../g) ?? []).map((h) => parseInt(h, 16)).reverse()
  return [1, 1, 1, 1, ...id, 0x01, 0x00, 0xbe, 0xef, 0, 0, 0, 0]
}
const OTHER = Array.from({ length: 32 }, (_, i) => (255 - i * 5).toString(16).padStart(2, '0')).join('')
const toHex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('')

const steak = (topic: string, outputs: number[] = [0]) => ({ [topic]: { outputsToAdmit: outputs, coinsToRetain: [] as number[] } })

interface Call { url: string; init: RequestInit }

/** A fetch that records its calls and answers from `answer`. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return answer(call)
  })
  return { fetch: f as unknown as typeof fetch, calls, spy: f }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function codeOf(p: Promise<unknown>): Promise<OverlaySubmitError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(OverlaySubmitError)
    return e as OverlaySubmitError
  }
  throw new Error('expected the call to reject')
}

// ── the request ─────────────────────────────────────────────────

describe('submitToOverlay: what it sends', () => {
  it('POSTs the BEEF bytes to /submit with the octet-stream and x-topics headers', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, steak('tm_social-content')))
    await submitToOverlay(atomicBeef(), { fetch })

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://overlay.peck.to/submit')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/octet-stream')
    expect(headers['x-topics']).toBe('["tm_social-content"]')
    expect(init.body).toBeInstanceOf(Uint8Array)
    expect(Array.from(init.body as Uint8Array)).toEqual(atomicBeef())
  })

  it('defaults to the social content topic', async () => {
    expect(OVERLAY_TOPICS.content).toBe('tm_social-content')
    const { fetch, calls } = fakeFetch(() => json(200, steak('tm_social-content')))
    await submitToOverlay(atomicBeef(), { fetch })
    expect((calls[0]!.init.headers as Record<string, string>)['x-topics']).toBe(JSON.stringify([OVERLAY_TOPICS.content]))
  })

  it('sends several topics as one JSON array, without repeats', async () => {
    const topics = [OVERLAY_TOPICS.keyBinding, OVERLAY_TOPICS.identityProfile, OVERLAY_TOPICS.identityHandle, OVERLAY_TOPICS.identityProfile]
    const { fetch, calls } = fakeFetch(() => json(200, { ...steak('tm_key-binding'), ...steak('tm_identity-profile'), ...steak('tm_identity-handle', []) }))
    const r = await submitToOverlay(atomicBeef(), { fetch, topics })
    expect((calls[0]!.init.headers as Record<string, string>)['x-topics']).toBe('["tm_key-binding","tm_identity-profile","tm_identity-handle"]')
    expect(r.topics).toEqual(['tm_key-binding', 'tm_identity-profile', 'tm_identity-handle'])
    expect(r.admittedTopics).toEqual(['tm_key-binding', 'tm_identity-profile'])
  })

  it('uses a different overlay and tolerates trailing slashes', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, steak('tm_social-content')))
    await submitToOverlay(atomicBeef(), { fetch, overlayUrl: 'http://localhost:8080//' })
    expect(calls[0]!.url).toBe('http://localhost:8080/submit')
  })

  it('does not set any header that needs credentials or the server (no auth, no cookies)', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, steak('tm_social-content')))
    await submitToOverlay(atomicBeef(), { fetch })
    const names = Object.keys(calls[0]!.init.headers as Record<string, string>).sort()
    expect(names).toEqual(['accept', 'content-type', 'x-topics'])
    expect(calls[0]!.init.credentials).toBeUndefined()
  })

  it('falls back to globalThis.fetch', async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return json(200, steak('tm_social-content'))
    }) as typeof fetch
    try {
      await submitToOverlay(atomicBeef())
      expect(seen).toEqual(['https://overlay.peck.to/submit'])
    } finally {
      globalThis.fetch = original
    }
  })
})

// ── what it accepts ─────────────────────────────────────────────

describe('submitToOverlay: inputs', () => {
  const ok = () => fakeFetch(() => json(200, steak('tm_social-content')))

  it('takes bytes, hex, a Uint8Array, a transaction and a createAction result', async () => {
    const bytes = atomicBeef()
    const inputs: SubmitInput[] = [
      bytes,
      Uint8Array.from(bytes),
      toHex(bytes),
      { toAtomicBEEF: () => bytes, id: () => TXID },
      { txid: TXID, tx: bytes },
      { txid: TXID, tx: Uint8Array.from(bytes) },
    ]
    for (const input of inputs) {
      const { fetch, calls } = ok()
      const r = await submitToOverlay(input, { fetch })
      expect(Array.from(calls[0]!.init.body as Uint8Array)).toEqual(bytes)
      expect(r.txid).toBe(TXID)
    }
  })

  it('reads the txid from the Atomic BEEF header when it is not given', async () => {
    const { fetch } = ok()
    expect((await submitToOverlay(atomicBeef(OTHER), { fetch })).txid).toBe(OTHER)
  })

  it('accepts plain BEEF V1 and V2 (no txid to report)', async () => {
    for (const head of [[0x01, 0x00, 0xbe, 0xef], [0x02, 0x00, 0xbe, 0xef]]) {
      const { fetch, calls } = ok()
      const r = await submitToOverlay([...head, 0, 0, 0, 0], { fetch })
      expect(calls).toHaveLength(1)
      expect(r.txid).toBeUndefined()
    }
  })

  it('refuses a wallet result with no transaction, before any request', async () => {
    const { fetch, spy } = ok()
    const e = await codeOf(submitToOverlay({ txid: TXID }, { fetch }))
    expect(e.code).toBe('no_transaction')
    expect(e.txid).toBe(TXID)
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses what is not BEEF, before any request', async () => {
    const { fetch, spy } = ok()
    const rawTx = '0100000001' + '00'.repeat(60) // a raw transaction starts with its version, not a BEEF marker
    const bad: SubmitInput[] = [rawTx, 'not hex', '', [], [1, 2, 3], [0x01, 0x00, 0xbe], [300, 0, 0, 0, 0, 0], new Uint8Array(0)]
    for (const input of bad) {
      expect((await codeOf(submitToOverlay(input, { fetch }))).code).toBe('invalid_input')
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports a transaction that cannot be written as BEEF', async () => {
    const { fetch, spy } = ok()
    const tx = { id: () => TXID, toAtomicBEEF: () => { throw new Error('missing source transaction') } }
    const e = await codeOf(submitToOverlay(tx, { fetch }))
    expect(e.code).toBe('invalid_input')
    expect(e.message).toContain('missing source transaction')
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses unusable topics and URLs, before any request', async () => {
    const { fetch, spy } = ok()
    const topics: unknown[] = [[], [''], ['has space'], ['tm_é'], [42], ['a\nb']]
    for (const t of topics) {
      expect((await codeOf(submitToOverlay(atomicBeef(), { fetch, topics: t as string[] }))).code).toBe('invalid_input')
    }
    expect((await codeOf(submitToOverlay(atomicBeef(), { fetch, overlayUrl: '  ' }))).code).toBe('invalid_input')
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── what comes back ─────────────────────────────────────────────

describe('submitToOverlay: the admittance result', () => {
  it('returns the overlay STEAK and which topics admitted something', async () => {
    const { fetch } = fakeFetch(() => json(200, { 'tm_social-content': { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }))
    const r = await submitToOverlay(atomicBeef(), { fetch })
    expect(r).toEqual({
      txid: TXID,
      topics: ['tm_social-content'],
      steak: { 'tm_social-content': { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } },
      admitted: true,
      admittedTopics: ['tm_social-content'],
    })
  })

  it('fills in coinsToRetain when the overlay leaves it out', async () => {
    const { fetch } = fakeFetch(() => json(200, { 'tm_social-content': { outputsToAdmit: [1] } }))
    expect((await submitToOverlay(atomicBeef(), { fetch })).steak['tm_social-content']).toEqual({ outputsToAdmit: [1], coinsToRetain: [] })
  })

  it('succeeds when one of several topics admits the transaction', async () => {
    const { fetch } = fakeFetch(() => json(200, { ...steak('tm_social-content'), ...steak('tm_social-friend', []) }))
    const r = await submitToOverlay(atomicBeef(), { fetch, topics: ['tm_social-content', 'tm_social-friend'] })
    expect(r.admitted).toBe(true)
    expect(r.admittedTopics).toEqual(['tm_social-content'])
  })
})

// ── failures ────────────────────────────────────────────────────

describe('submitToOverlay: failures', () => {
  const failWith = async (answer: Response | (() => Promise<Response>), options: Parameters<typeof submitToOverlay>[1] = {}) =>
    codeOf(submitToOverlay(atomicBeef(), { ...options, fetch: fakeFetch(() => (typeof answer === 'function' ? answer() : answer)).fetch }))

  it('rejected: the overlay refuses the request (HTTP 400)', async () => {
    const e = await failWith(json(400, { error: 'Serialized BEEF must start with 4022206465 or 4022206466 but starts with 67305985' }))
    expect(e.code).toBe('rejected')
    expect(e.status).toBe(400)
    expect(e.message).toContain('Serialized BEEF must start with')
    expect(e.txid).toBe(TXID)
    expect(isOverlaySubmitError(e)).toBe(true)
  })

  it('spv_failed: the overlay could not verify the transaction', async () => {
    // The wording the live overlay uses: its own check, and what the SDK's verify() throws.
    for (const error of [
      'Unable to verify SPV information.',
      `Invalid merkle path for transaction ${TXID}`,
      `Verification failed because the input at index 0 of transaction ${TXID} is missing an associated source transaction.`,
    ]) {
      const e = await failWith(json(400, { error }))
      expect(e.code, error).toBe('spv_failed')
      expect(e.status).toBe(400)
    }
  })

  it('unsupported_topic: the overlay does not run the topic', async () => {
    const e = await failWith(json(400, { error: 'This server does not support this topic: tm_bogus' }), { topics: ['tm_bogus'] })
    expect(e.code).toBe('unsupported_topic')
  })

  it('server: a 5xx, with or without a JSON body', async () => {
    const a = await failWith(json(500, { error: 'boom' }))
    expect([a.code, a.status, a.message]).toEqual(['server', 500, 'boom'])
    const b = await failWith(new Response('<html>Bad gateway</html>', { status: 502 }))
    expect([b.code, b.status]).toEqual(['server', 502])
    expect(b.message).toContain('Bad gateway')
    const c = await failWith(new Response('', { status: 503 }))
    expect([c.code, c.message]).toEqual(['server', 'overlay answered HTTP 503'])
  })

  it('rejected: other 4xx without a JSON body', async () => {
    const e = await failWith(new Response('', { status: 413 }))
    expect([e.code, e.status]).toEqual(['rejected', 413])
  })

  it('invalid_response: a 2xx that is not an admittance result', async () => {
    for (const body of ['', 'OK', '[]', '{}', '{"tm_social-content":1}', '{"tm_social-content":{}}', '{"tm_social-content":{"outputsToAdmit":"0"}}', 'null']) {
      const e = await failWith(new Response(body, { status: 200 }))
      expect(e.code, `body ${JSON.stringify(body)}`).toBe('invalid_response')
      expect(e.status).toBe(200)
    }
  })

  it('not_admitted: a 200 where no topic admitted anything, with the result attached', async () => {
    const e = await failWith(json(200, steak('tm_social-content', [])))
    expect(e.code).toBe('not_admitted')
    expect(e.status).toBe(200)
    expect(e.steak).toEqual({ 'tm_social-content': { outputsToAdmit: [], coinsToRetain: [] } })
    expect(e.txid).toBe(TXID)
  })

  it('requireAdmission: false returns the empty result instead (a repeat submission)', async () => {
    const { fetch } = fakeFetch(() => json(200, steak('tm_social-content', [])))
    const r = await submitToOverlay(atomicBeef(), { fetch, requireAdmission: false })
    expect(r.admitted).toBe(false)
    expect(r.admittedTopics).toEqual([])
    expect(r.steak).toEqual({ 'tm_social-content': { outputsToAdmit: [], coinsToRetain: [] } })
  })

  it('network: no answer at all, with the cause kept', async () => {
    const cause = new TypeError('Failed to fetch')
    const e = await failWith(() => Promise.reject(cause))
    expect(e.code).toBe('network')
    expect(e.status).toBe(0)
    expect(e.cause).toBe(cause)
    expect(e.message).toContain('Failed to fetch')
    expect(e.txid).toBe(TXID)
  })

  it('network: the body cannot be read', async () => {
    const broken = new Response('x', { status: 200 })
    vi.spyOn(broken, 'text').mockRejectedValue(new TypeError('terminated'))
    const e = await failWith(broken)
    expect(e.code).toBe('network')
  })

  it('timeout: the overlay does not answer in time', async () => {
    const hang = ({ init }: Call) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      })
    const { fetch } = fakeFetch(hang)
    const e = await codeOf(submitToOverlay(atomicBeef(), { fetch, timeoutMs: 20 }))
    expect(e.code).toBe('timeout')
    expect(e.status).toBe(0)
    expect(e.message).toContain('20 ms')
  })

  it('the caller can abort: the signal reason comes back, not an OverlaySubmitError', async () => {
    const hang = ({ init }: Call) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    const { fetch } = fakeFetch(hang)
    const ctrl = new AbortController()
    const reason = new Error('user navigated away')
    const pending = submitToOverlay(atomicBeef(), { fetch, signal: ctrl.signal })
    ctrl.abort(reason)
    await expect(pending).rejects.toBe(reason)

    // Already aborted: nothing is sent.
    const second = fakeFetch(() => json(200, steak('tm_social-content')))
    await expect(submitToOverlay(atomicBeef(), { fetch: second.fetch, signal: ctrl.signal })).rejects.toBe(reason)
    expect(second.spy).not.toHaveBeenCalled()
  })
})
