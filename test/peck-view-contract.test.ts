// Contract tests: every example of the vendored peck-view/v1 contract validates
// against its schema, and the /v2 client hands each one back typed.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PECK_VIEW_CONTRACT,
  ReadError,
  createReadClient,
  type AppList,
  type ChannelList,
  type FeedPage,
  type IdentityList,
  type LensList,
  type PostBatch,
  type ProfileView,
  type ReactionPage,
  type SiteStats,
  type ThreadView,
  type ViewerState,
} from '../src/read/index.js'
import { PECK_VIEW_FIXTURES, peckViewErrors, type PeckViewTypeName } from './helpers/peck-view-validator.js'

const EXAMPLE_TYPES: Record<string, PeckViewTypeName> = {
  'app-list.json': 'AppList',
  'channel-list.json': 'ChannelList',
  'error-response.json': 'ErrorResponse',
  'feed-page-last.json': 'FeedPage',
  'feed-page.json': 'FeedPage',
  'identity-list.json': 'IdentityList',
  'lens-list.json': 'LensList',
  'post-batch-geo.json': 'PostBatch',
  'post-batch.json': 'PostBatch',
  'profile-view.json': 'ProfileView',
  'reaction-page.json': 'ReactionPage',
  'site-stats.json': 'SiteStats',
  'thread-view-zanaadu.json': 'ThreadView',
  'thread-view.json': 'ThreadView',
  'viewer-state.json': 'ViewerState',
}

const load = (name: string): unknown => JSON.parse(readFileSync(join(PECK_VIEW_FIXTURES, name), 'utf8'))

function serving(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { client: createReadClient({ baseUrl: 'https://overlay.example', fetch: fetchStub }), calls }
}

describe(`${PECK_VIEW_CONTRACT} examples`, () => {
  const files = readdirSync(PECK_VIEW_FIXTURES).filter((f) => f.endsWith('.json')).sort()

  it('has a known view type for every example', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(EXAMPLE_TYPES[f], f).toBeDefined()
  })

  for (const f of files) {
    it(`${f} is a valid ${EXAMPLE_TYPES[f] ?? '?'} and a valid response`, () => {
      const value = load(f)
      expect(peckViewErrors(EXAMPLE_TYPES[f] ?? 'PeckView', value)).toEqual([])
      expect(peckViewErrors('PeckView', value)).toEqual([])
    })
  }

  it('rejects a view with a property the contract does not define', () => {
    const page = load('feed-page.json') as FeedPage
    const leaked = { ...page, items: [{ ...page.items[0], engagement_score: 3 }] }
    expect(peckViewErrors('FeedPage', leaked).join('\n')).toMatch(/engagement_score/)
  })
})

describe('the /v2 client returns each example typed', () => {
  it('feed() -> FeedPage', async () => {
    const example = load('feed-page.json') as FeedPage
    const page = await serving(example).client.feed()
    expect(page).toEqual(example)
    const first = page.items[0]
    expect(first?.author.displayName).toBeTypeOf('string')
    expect(page.next).not.toBeNull()
  })

  it('feed() on the last page -> next is null', async () => {
    const page = await serving(load('feed-page-last.json')).client.feed()
    expect(page.next).toBeNull()
  })

  it('post() -> ThreadView', async () => {
    const example = load('thread-view.json') as ThreadView
    const thread = await serving(example).client.post(example.post.txid)
    expect(thread.post.txid).toBe(example.post.txid)
    expect(thread.replies).toHaveLength(example.replies.length)
  })

  it('profile() -> ProfileView', async () => {
    const example = load('profile-view.json') as ProfileView
    const profile = await serving(example).client.profile('@ada')
    expect(profile.author.handle).toBe(example.author.handle)
    expect(profile.keys).toEqual(example.keys)
  })

  it('posts() -> PostBatch', async () => {
    const example = load('post-batch.json') as PostBatch
    const txids = [...example.posts.map((p) => p.txid), ...example.missing]
    const batch = await serving(example).client.posts(txids)
    expect(batch).toEqual(example)
  })

  it('viewerState() -> ViewerState', async () => {
    const example = load('viewer-state.json') as ViewerState
    const state = await serving(example).client.viewerState({
      viewer: example.viewer,
      txids: Object.keys(example.posts),
      authors: Object.keys(example.authors),
    })
    expect(state).toEqual(example)
  })

  it('profile() -> ProfileView with the post count and certificates', async () => {
    const example = load('profile-view.json') as ProfileView
    const profile = await serving(example).client.profile('@ada')
    expect(profile.counts.posts).toBe(148)
    expect(profile.certificates?.map((c) => c.platform)).toEqual(['github', 'x'])
    expect(profile.certificates?.[1]?.certifiers).toHaveLength(2)
  })

  it('posts() -> PostBatch with locations, including a legacy pin and an object', async () => {
    const example = load('post-batch-geo.json') as PostBatch
    const batch = await serving(example).client.posts(example.posts.map((p) => p.txid))
    expect(batch).toEqual(example)
    expect(batch.posts.map((p) => [p.type, p.kind ?? null, p.geo?.category ?? null])).toEqual([
      ['post', null, 'alert'],
      ['post', 'pin', 'alert'],
      ['object', null, null],
    ])
  })

  it('post() -> ThreadView for a Zanaadu post, with its source and the author alias', async () => {
    const example = load('thread-view-zanaadu.json') as ThreadView
    const thread = await serving(example).client.post(example.post.txid)
    expect(thread.post.source).toMatchObject({ protocol: 'zanaadu', commitment: { algorithm: 'sha256', verified: true } })
    expect(thread.post.author.sourceHandle).toMatchObject({ namespace: 'zanaadu', number: 14 })
  })

  it('reactions() -> ReactionPage, including a like with no usable key', async () => {
    const example = load('reaction-page.json') as ReactionPage
    const { client, calls } = serving(example)
    const page = await client.reactions('AB'.repeat(32), { limit: 3 })
    expect(page).toEqual(example)
    expect(calls[0]?.url).toBe(`https://overlay.example/v2/post/${'ab'.repeat(32)}/reactions?limit=3`)
    expect(page.items.map((r) => r.author === null)).toEqual([false, false, true])
    expect(page.items[2]).toMatchObject({ actorKey: 'unknown', txid: null })
    // The cursor goes back exactly as the overlay gave it.
    expect(page.next).toEqual({ before_ts: '2020-03-02T11:00:00Z', before_actor: 'unknown' })
  })

  it('stats() -> SiteStats', async () => {
    const example = load('site-stats.json') as SiteStats
    const { client, calls } = serving(example)
    const stats = await client.stats()
    expect(stats).toEqual(example)
    expect(stats.estimated).toBe(true)
    expect(calls[0]?.url).toBe('https://overlay.example/v2/stats')
  })

  it('apps() -> AppList', async () => {
    const example = load('app-list.json') as AppList
    const { client, calls } = serving(example)
    const list = await client.apps()
    expect(list).toEqual(example)
    expect(list.apps.map((a) => a.app)).toEqual(['twetch', 'peck.to', 'treechat', 'peck.agents'])
    expect(calls[0]?.url).toBe('https://overlay.example/v2/apps')
  })

  it('channels() -> ChannelList', async () => {
    const example = load('channel-list.json') as ChannelList
    const { client, calls } = serving(example)
    const list = await client.channels()
    expect(list).toEqual(example)
    expect(list.posting.map((c) => c.channel)).toEqual(['peck-dev', 'scripture', 'geohash'])
    expect(list.rooms.map((r) => r.lastAt === null)).toEqual([false, false, true])
    expect(calls[0]?.url).toBe('https://overlay.example/v2/channels')
  })

  it('identities() -> IdentityList, including an identity named by its key', async () => {
    const example = load('identity-list.json') as IdentityList
    const { client, calls } = serving(example)
    const list = await client.identities({ limit: 2 })
    expect(list).toEqual(example)
    expect(list.items.map((a) => a.nameSource)).toEqual(['identity', 'key'])
    expect(list.total).toBeGreaterThan(list.items.length)
    expect(calls[0]?.url).toBe('https://overlay.example/v2/identities?limit=2')
  })

  it('lenses() -> LensList, the issuer baked like an author', async () => {
    const example = load('lens-list.json') as LensList
    const { client, calls } = serving(example)
    const issuer = example.items[0]!.issuer.key
    const list = await client.lenses({ issuer: issuer.toUpperCase(), scope: 'curated' })
    expect(list).toEqual(example)
    expect(list.items[0]?.issuer.displayName).toBe('Ada')
    expect(list.items[0]?.rules.map((r) => [r.match, r.action])).toEqual([['category', 'hide'], ['app', 'label']])
    expect(calls[0]?.url).toBe(`https://overlay.example/v2/lenses?issuer=${issuer}&scope=curated`)
  })

  it('ErrorResponse -> ReadError with the contract code', async () => {
    const example = load('error-response.json') as { error: { code: string; message: string } }
    const err = await serving(example, 404).client.post('ab'.repeat(32)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReadError)
    expect(err).toMatchObject({ code: example.error.code, status: 404, message: example.error.message })
  })
})
