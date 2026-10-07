import { describe, expect, it, vi } from 'vitest'
import {
  MAX_POSTS_PER_REQUEST,
  MAX_VIEWER_ITEMS_PER_REQUEST,
  type ReadError,
  createReadClient,
  feedSearchParams,
  isReadError,
  appsSearchParams,
  channelsSearchParams,
  authorsSearchParams,
  identitiesSearchParams,
  lensesSearchParams,
  messagesSearchParams,
  reactionsSearchParams,
  type FeedPage,
  type PostView,
  type ViewerState,
} from '../src/read/index.js'

interface Call {
  url: URL
  method: string
  body: unknown
  headers: Record<string, string>
  signal: AbortSignal | undefined
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function clientWith(handler: (call: Call) => Response | Promise<Response>, opts: { timeoutMs?: number } = {}) {
  const calls: Call[] = []
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal ?? undefined,
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  const client = createReadClient({ baseUrl: 'https://overlay.example/', fetch: fetchStub, ...opts })
  return { client, calls }
}

const EMPTY_PAGE: FeedPage = { items: [], next: null }
const txid = (n: number) => n.toString(16).padStart(64, '0')

/** A minimal PostView stand-in; only txid matters to the batching logic. */
const stubPost = (t: string) => ({ txid: t }) as unknown as PostView

describe('feed()', () => {
  it('maps the typed query onto the /v2/feed wire names', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_PAGE))
    await client.feed({
      limit: 5,
      rank: 'top',
      app: ['peck.to', 'peck.world'],
      excludeApps: ['treechat'],
      type: ['post', 'reply'],
      kind: 'longform',
      tag: 'bsv',
      author: ['1abc', '02def'],
      since: new Date('2026-09-01T00:00:00Z'),
      until: 1790000000,
      minLength: 10,
      hideBlockedBy: '1viewer',
      includeMuted: false,
      lens: ['calm'],
    })
    const u = calls[0]!.url
    expect(u.origin + u.pathname).toBe('https://overlay.example/v2/feed')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      limit: '5',
      rank: 'top',
      app_in: 'peck.to,peck.world',
      app_not_in: 'treechat',
      types: 'post,reply',
      kind: 'longform',
      tag: 'bsv',
      author: '1abc,02def',
      since: '2026-09-01T00:00:00.000Z',
      until: '1790000000',
      min_length: '10',
      hide_blocked_by: '1viewer',
      include_muted: '0',
      lens: 'calm',
    })
    expect(calls[0]!.method).toBe('GET')
  })

  it('sends a single app or type under the singular name', () => {
    const qs = feedSearchParams({ app: ['peck.to'], type: 'post' })
    expect(qs.get('app')).toBe('peck.to')
    expect(qs.has('app_in')).toBe(false)
    expect(qs.get('type')).toBe('post')
  })

  it('sends no query string for an empty query', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_PAGE))
    await client.feed()
    expect(calls[0]!.url.search).toBe('')
  })

  it('passes the cursor back unchanged', async () => {
    const next = { before_score: 1.5, before_score2: 3, before_ts: '2026-09-30T08:56:31Z', before_txid: txid(7) }
    const { client, calls } = clientWith(() => json(EMPTY_PAGE))
    await client.feed({ rank: 'top', cursor: next })
    const qs = calls[0]!.url.searchParams
    expect(qs.get('before_score')).toBe('1.5')
    expect(qs.get('before_score2')).toBe('3')
    expect(qs.get('before_ts')).toBe('2026-09-30T08:56:31Z')
    expect(qs.get('before_txid')).toBe(txid(7))
  })
})

describe('feed() geo filters', () => {
  it('sends the box latitude first, as minLat,minLng,maxLat,maxLng', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_PAGE))
    // Oslo: latitude about 59.9, longitude about 10.7.
    await client.feed({ bbox: { minLat: 59.8, minLng: 10.6, maxLat: 60.0, maxLng: 10.9 } })
    const u = calls[0]!.url
    expect(u.pathname).toBe('/v2/feed')
    expect(u.searchParams.get('bbox')).toBe('59.8,10.6,60,10.9')
    expect(u.searchParams.has('has_geo')).toBe(false)
  })

  it('keeps a box across the antimeridian as given (minLng greater than maxLng)', () => {
    const qs = feedSearchParams({ bbox: { minLat: -20, minLng: 170, maxLat: -10, maxLng: -170 } })
    expect(qs.get('bbox')).toBe('-20,170,-10,-170')
  })

  it('sends near as lat,lng,radiusKm', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_PAGE))
    await client.feed({ near: { lat: 59.9139, lng: 10.7522, radiusKm: 2.5 } })
    expect(calls[0]!.url.searchParams.get('near')).toBe('59.9139,10.7522,2.5')
    expect(calls[0]!.url.searchParams.has('radius_km')).toBe(false)
  })

  it('sends has_geo=1 only when true', () => {
    expect(feedSearchParams({ hasGeo: true }).get('has_geo')).toBe('1')
    expect(feedSearchParams({ hasGeo: false }).has('has_geo')).toBe(false)
    expect(feedSearchParams({}).has('has_geo')).toBe(false)
  })

  it('combines with the other filters and with paging', () => {
    const cursor = { before_ts: '2026-09-30T08:56:31Z', before_txid: txid(9) }
    const qs = feedSearchParams({
      app: 'peck.world',
      type: ['post', 'reply'],
      rank: 'latest',
      hasGeo: true,
      near: { lat: 1, lng: 2, radiusKm: 3 },
      bbox: { minLat: 0, minLng: 1, maxLat: 2, maxLng: 3 },
      cursor,
    })
    expect(Object.fromEntries(qs)).toEqual({
      rank: 'latest',
      app: 'peck.world',
      types: 'post,reply',
      has_geo: '1',
      bbox: '0,1,2,3',
      near: '1,2,3',
      ...cursor,
    })
  })
})

describe('reactions()', () => {
  const REACTIONS: FeedPage = { items: [], next: null }

  it('lists likes by default, on the post path', async () => {
    const { client, calls } = clientWith(() => json(REACTIONS))
    await client.reactions(txid(1))
    const u = calls[0]!.url
    expect(u.pathname).toBe(`/v2/post/${txid(1)}/reactions`)
    expect(u.search).toBe('')
    expect(calls[0]!.method).toBe('GET')
  })

  it('maps kind, limit and the cursor onto the wire names', async () => {
    const { client, calls } = clientWith(() => json(REACTIONS))
    await client.reactions(txid(2), {
      kind: 'repost',
      limit: 25,
      cursor: { before_ts: '2026-09-30T08:56:31.25Z', before_txid: txid(3) },
    })
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      kind: 'repost',
      limit: '25',
      before_ts: '2026-09-30T08:56:31.25Z',
      before_txid: txid(3),
    })
  })

  it('sends a like cursor back unchanged, even a placeholder actor', () => {
    const qs = reactionsSearchParams({ kind: 'like', cursor: { before_ts: '2020-03-02T11:00:00Z', before_actor: 'unknown' } })
    expect(qs.toString()).toBe('kind=like&before_ts=2020-03-02T11%3A00%3A00Z&before_actor=unknown')
    expect(reactionsSearchParams({ cursor: null }).toString()).toBe('')
  })

  it('normalises the txid and rejects a malformed one without a request', async () => {
    const { client, calls } = clientWith(() => json(REACTIONS))
    await client.reactions(`  ${txid(255).toUpperCase()} `)
    expect(calls[0]!.url.pathname).toBe(`/v2/post/${txid(255)}/reactions`)
    await expect(client.reactions('nope')).rejects.toMatchObject({ code: 'bad_request', status: 0 })
    await expect(client.reactions('')).rejects.toMatchObject({ code: 'bad_request', status: 0 })
    expect(calls).toHaveLength(1)
  })

  it('rejects a body that is not a reaction page', async () => {
    const { client } = clientWith(() => json({ posts: [], missing: [] }))
    await expect(client.reactions(txid(1))).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('stats() and apps()', () => {
  it('stats() reads /v2/stats', async () => {
    const { client, calls } = clientWith(() => json({ posts: 10, accounts: 2, estimated: true, asOf: '2026-09-30T13:05:00Z' }))
    expect(await client.stats()).toMatchObject({ posts: 10, accounts: 2, estimated: true })
    expect(calls[0]!.url.pathname).toBe('/v2/stats')
    expect(calls[0]!.url.search).toBe('')
  })

  it('stats() rejects a body that is not SiteStats', async () => {
    const { client } = clientWith(() => json({ status: 'ok' }))
    await expect(client.stats()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('apps() sends one type as `type` and several as `types`', async () => {
    const { client, calls } = clientWith(() => json({ apps: [], asOf: '2026-09-30T10:05:00Z' }))
    await client.apps()
    await client.apps({ type: 'post' })
    await client.apps({ type: ['post', 'reply'] })
    expect(calls.map((c) => c.url.pathname + c.url.search)).toEqual(['/v2/apps', '/v2/apps?type=post', '/v2/apps?types=post%2Creply'])
    expect(appsSearchParams({ type: [] }).toString()).toBe('')
  })

  it('apps() rejects a body that is not an AppList', async () => {
    const { client } = clientWith(() => json({ items: [], next: null }))
    await expect(client.apps()).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('channels(), identities() and lenses()', () => {
  const CHANNELS = { posting: [], rooms: [], postingSince: '2026-08-31T15:00:00Z', asOf: '2026-09-30T15:00:00Z' }
  const IDENTITIES = { items: [], total: 0 }
  const LENSES = { items: [] }
  const ISSUER = `02${'ab'.repeat(32)}`

  it('channels() reads /v2/channels and sends limit only when given', async () => {
    const { client, calls } = clientWith(() => json(CHANNELS))
    expect(await client.channels()).toEqual(CHANNELS)
    await client.channels({ limit: 10 })
    expect(calls.map((c) => c.url.pathname + c.url.search)).toEqual(['/v2/channels', '/v2/channels?limit=10'])
    expect(calls[0]!.method).toBe('GET')
    expect(channelsSearchParams({}).toString()).toBe('')
  })

  it('identities() reads /v2/identities and sends limit only when given', async () => {
    const { client, calls } = clientWith(() => json(IDENTITIES))
    expect(await client.identities()).toEqual(IDENTITIES)
    await client.identities({ limit: 100 })
    expect(calls.map((c) => c.url.pathname + c.url.search)).toEqual(['/v2/identities', '/v2/identities?limit=100'])
    expect(identitiesSearchParams({}).toString()).toBe('')
  })

  it('lenses() maps issuer, scope and limit, and lower-cases the issuer', async () => {
    const { client, calls } = clientWith(() => json(LENSES))
    await client.lenses()
    await client.lenses({ issuer: ` ${ISSUER.toUpperCase()} `, scope: ' curated ', limit: 5 })
    expect(calls[0]!.url.search).toBe('')
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ issuer: ISSUER, scope: 'curated', limit: '5' })
    expect(lensesSearchParams({ issuer: '', scope: '' }).toString()).toBe('')
  })

  it('lenses() rejects a malformed issuer without a request', async () => {
    const { client, calls } = clientWith(() => json(LENSES))
    await expect(client.lenses({ issuer: 'ada' })).rejects.toMatchObject({ code: 'bad_request', status: 0, path: '/v2/lenses' })
    await expect(client.lenses({ issuer: `04${'ab'.repeat(32)}` })).rejects.toMatchObject({ code: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('passes an overlay bad_request through as a ReadError', async () => {
    const { client } = clientWith(() => json({ error: { code: 'bad_request', message: 'limit must be an integer 1–100' } }, 400))
    await expect(client.channels({ limit: 500 })).rejects.toMatchObject({ code: 'bad_request', status: 400, path: '/v2/channels?limit=500' })
  })

  it('rejects bodies of the wrong view', async () => {
    const { client } = clientWith(() => json({ apps: [], asOf: '2026-09-30T10:05:00Z' }))
    await expect(client.channels()).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(client.identities()).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(client.lenses()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('identities() needs the total', async () => {
    const { client } = clientWith(() => json({ items: [] }))
    await expect(client.identities()).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('messages()', () => {
  const EMPTY_MESSAGES = { items: [], next: null }

  it('maps the typed query onto the /v2/messages wire names', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_MESSAGES))
    await client.messages({ channel: ' mcp-chat ', author: '1sender', limit: 20, order: 'asc', cursor: { after_ts: '2026-09-30T09:10:58Z', after_txid: txid(3) } })
    const u = calls[0]!.url
    expect(u.origin + u.pathname).toBe('https://overlay.example/v2/messages')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      channel: 'mcp-chat',
      author: '1sender',
      limit: '20',
      order: 'asc',
      after_ts: '2026-09-30T09:10:58Z',
      after_txid: txid(3),
    })
    expect(calls[0]!.method).toBe('GET')
  })

  it('reads the global chat, an inbox and an outbox', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_MESSAGES))
    await client.messages({ scope: 'global' })
    await client.messages({ recipient: '02ab' })
    await client.messages({ author: '1sender', recipient: '02ab' })
    expect(calls.map((c) => c.url.search)).toEqual(['?scope=global', '?recipient=02ab', '?recipient=02ab&author=1sender'])
  })

  it('passes a numeric cursor value back as a string, and leaves unset fields out', () => {
    const qs = messagesSearchParams({ channel: 'c', cursor: { before_ts: '2026-09-30T09:10:58Z', before_txid: txid(9) } })
    expect([...qs.keys()].sort()).toEqual(['before_ts', 'before_txid', 'channel'])
    expect(messagesSearchParams({ recipient: 'k', cursor: null }).toString()).toBe('recipient=k')
  })

  it('rejects a query that names nothing, before sending anything', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_MESSAGES))
    for (const q of [{}, { limit: 10 }, { channel: '  ' }, { cursor: null }]) {
      await expect(client.messages(q)).rejects.toMatchObject({ code: 'bad_request', status: 0, path: '/v2/messages' })
    }
    expect(calls).toHaveLength(0)
  })

  it("surfaces the overlay's 400 for a conflicting query", async () => {
    const { client } = clientWith(() => json({ error: { code: 'bad_request', message: 'give channel or scope=global, not both' } }, 400))
    await expect(client.messages({ channel: 'a', scope: 'global' })).rejects.toMatchObject({ code: 'bad_request', status: 400 })
  })

  it('rejects a body that is not a page', async () => {
    const { client } = clientWith(() => json({ status: 'ok', data: [] }))
    await expect(client.messages({ channel: 'a' })).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('authors()', () => {
  const EMPTY_AUTHORS = { items: [], next: null, total: 0, capped: false, asOf: '2026-09-30T09:10:00Z' }

  it('maps the typed query onto the /v2/authors wire names', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_AUTHORS))
    await client.authors({ app: ' twetch ', limit: 25, cursor: { before_posts: 12, before_key: '1abc' } })
    const u = calls[0]!.url
    expect(u.origin + u.pathname).toBe('https://overlay.example/v2/authors')
    expect(Object.fromEntries(u.searchParams)).toEqual({ app: 'twetch', limit: '25', before_posts: '12', before_key: '1abc' })
  })

  it('sends no query string for an empty query', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_AUTHORS))
    await client.authors()
    expect(calls[0]!.url.search).toBe('')
    expect(authorsSearchParams().toString()).toBe('')
  })

  it('reads the names behind a shared key; by "name" needs an app, checked before sending', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_AUTHORS))
    await client.authors({ app: 'treechat', by: 'name' })
    expect(calls[0]!.url.search).toBe('?app=treechat&by=name')
    await expect(client.authors({ by: 'name' })).rejects.toMatchObject({ code: 'bad_request', status: 0, path: '/v2/authors' })
    await expect(client.authors({ by: 'name', app: '  ' })).rejects.toMatchObject({ code: 'bad_request', status: 0 })
    expect(calls).toHaveLength(1)
  })

  it('a first snapshot that is still loading is a timeout ReadError with status 503', async () => {
    const { client } = clientWith(() => json({ error: { code: 'timeout', message: 'the author ranking is still being computed; retry in a few seconds' } }, 503))
    await expect(client.authors()).rejects.toMatchObject({ code: 'timeout', status: 503 })
  })

  it('rejects a body that is not a list', async () => {
    const { client } = clientWith(() => json({ items: [] }))
    await expect(client.authors()).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('post(), profile(), search()', () => {
  it('encodes the path parameter', async () => {
    const { client, calls } = clientWith(() => json({ author: {}, keys: [] }))
    await client.profile('@ada')
    expect(calls[0]!.url.pathname).toBe('/v2/profile/%40ada')
  })

  it('rejects empty input without a request', async () => {
    const { client, calls } = clientWith(() => json({}))
    await expect(client.post('  ')).rejects.toMatchObject({ code: 'bad_request', status: 0 })
    await expect(client.profile('')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(client.search('')).rejects.toMatchObject({ code: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('builds search queries', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_PAGE))
    await client.search({ q: 'bitcoin schema', limit: 3, app: 'peck.to', type: ['post', 'reply'], tag: 'dev' })
    const u = calls[0]!.url
    expect(u.pathname).toBe('/v2/search')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: 'bitcoin schema',
      limit: '3',
      app: 'peck.to',
      types: 'post,reply',
      tag: 'dev',
    })
    await client.search('plain')
    expect(calls[1]!.url.searchParams.get('q')).toBe('plain')
  })
})

describe('posts()', () => {
  it('makes no request for an empty list', async () => {
    const { client, calls } = clientWith(() => json({ posts: [], missing: [] }))
    expect(await client.posts([])).toEqual({ posts: [], missing: [] })
    expect(calls).toHaveLength(0)
  })

  it('rejects a malformed txid before sending anything', async () => {
    const { client, calls } = clientWith(() => json({ posts: [], missing: [] }))
    await expect(client.posts([txid(1), 'nope'])).rejects.toMatchObject({ code: 'bad_request', status: 0 })
    expect(calls).toHaveLength(0)
  })

  it('de-duplicates, chunks at 100 and keeps request order', async () => {
    const all = Array.from({ length: 250 }, (_, i) => txid(i + 1))
    const input = [...all, all[0]!.toUpperCase(), all[5]!]
    const { client, calls } = clientWith((call) => {
      const asked = (call.body as { txids: string[] }).txids
      // Every tenth txid is "not indexed".
      const found = asked.filter((t) => parseInt(t, 16) % 10 !== 0)
      return json({ posts: found.map(stubPost), missing: asked.filter((t) => !found.includes(t)) })
    })
    const batch = await client.posts(input)
    expect(calls.map((c) => (c.body as { txids: string[] }).txids.length)).toEqual([100, 100, 50])
    expect(calls.every((c) => c.method === 'POST' && c.url.pathname === '/v2/posts')).toBe(true)
    expect(calls[0]!.headers['content-type']).toBe('application/json')
    expect(batch.posts.map((p) => p.txid)).toEqual(all.filter((t) => parseInt(t, 16) % 10 !== 0))
    expect(batch.missing).toEqual(all.filter((t) => parseInt(t, 16) % 10 === 0))
    expect(MAX_POSTS_PER_REQUEST).toBe(100)
  })
})

describe('viewerState()', () => {
  const answer = (call: Call): Response => {
    const b = call.body as { viewer: string; txids: string[]; authors: string[] }
    const state: ViewerState = {
      viewer: b.viewer,
      keys: [b.viewer],
      posts: Object.fromEntries(b.txids.map((t) => [t, { liked: true, reposted: false }])),
      authors: Object.fromEntries(b.authors.map((a) => [a, { following: true, blocked: false, muted: false }])),
    }
    return json(state)
  }

  it('sends one request for small inputs', async () => {
    const { client, calls } = clientWith(answer)
    const state = await client.viewerState({ viewer: '1viewer', txids: [txid(1)], authors: ['1author'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ viewer: '1viewer', txids: [txid(1)], authors: ['1author'] })
    expect(state.posts[txid(1)]?.liked).toBe(true)
  })

  it('chunks txids and authors at 200 each and merges the maps', async () => {
    const txids = Array.from({ length: 450 }, (_, i) => txid(i + 1))
    const authors = Array.from({ length: 201 }, (_, i) => `1author${i}`)
    const { client, calls } = clientWith(answer)
    const state = await client.viewerState({ viewer: '1viewer', txids, authors })
    const sizes = calls.map((c) => {
      const b = c.body as { txids: string[]; authors: string[] }
      return [b.txids.length, b.authors.length]
    })
    expect(sizes).toEqual([[200, 200], [200, 1], [50, 0]])
    expect(Object.keys(state.posts)).toHaveLength(450)
    expect(Object.keys(state.authors)).toHaveLength(201)
    expect(state.viewer).toBe('1viewer')
    expect(MAX_VIEWER_ITEMS_PER_REQUEST).toBe(200)
  })
})

describe('errors', () => {
  it('turns an ErrorResponse into a typed ReadError', async () => {
    const { client } = clientWith(() => json({ error: { code: 'bad_request', message: 'limit must be an integer 1–100' } }, 400))
    const err = await client.feed({ limit: 500 }).catch((e: unknown) => e)
    expect(isReadError(err)).toBe(true)
    expect(err).toMatchObject({ name: 'ReadError', code: 'bad_request', status: 400, path: '/v2/feed?limit=500' })
    expect((err as ReadError).message).toMatch(/limit must be/)
  })

  it('maps a non-contract error body by status', async () => {
    const { client } = clientWith(() => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(client.feed()).rejects.toMatchObject({ code: 'internal', status: 502 })
    const busy = clientWith(() => new Response('', { status: 503 }))
    await expect(busy.client.feed()).rejects.toMatchObject({ code: 'timeout', status: 503 })
  })

  it('rejects a 2xx body that is not the expected view', async () => {
    const { client } = clientWith(() => json({ status: 'ok', data: [] }))
    await expect(client.feed()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
    const html = clientWith(() => new Response('<html></html>', { status: 200 }))
    await expect(html.client.post(txid(1))).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('reports a failed connection as network', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('fetch failed')
    })
    const err = await client.feed().catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'network', status: 0 })
    expect((err as ReadError).cause).toBeInstanceOf(TypeError)
  })

  it('reports its own timeout as timeout', async () => {
    vi.useFakeTimers()
    try {
      const { client } = clientWith(
        (call) =>
          new Promise<Response>((_, reject) => {
            call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
        { timeoutMs: 50 },
      )
      const pending = client.feed().catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(60)
      expect(await pending).toMatchObject({ code: 'timeout', status: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects with the caller's abort reason unchanged", async () => {
    const ctrl = new AbortController()
    const { client } = clientWith(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal?.reason))
        }),
    )
    const pending = client.feed({}, { signal: ctrl.signal }).catch((e: unknown) => e)
    const reason = new Error('navigated away')
    ctrl.abort(reason)
    expect(await pending).toBe(reason)
  })

  it('does not send a request when the signal is already aborted', async () => {
    const { client, calls } = clientWith(() => json(EMPTY_PAGE))
    const signal = AbortSignal.abort()
    const err = await client.feed({}, { signal }).catch((e: unknown) => e)
    expect((err as DOMException).name).toBe('AbortError')
    expect(calls).toHaveLength(0)
  })
})
