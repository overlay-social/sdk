// Contract tests: every example of the vendored peck-view/v1 contract validates
// against its schema, and the /v2 client hands each one back typed.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PECK_VIEW_CONTRACT,
  ReadError,
  createReadClient,
  type FeedPage,
  type PostBatch,
  type ProfileView,
  type ThreadView,
  type ViewerState,
} from '../src/read/index.js'
import { PECK_VIEW_FIXTURES, peckViewErrors, type PeckViewTypeName } from './helpers/peck-view-validator.js'

const EXAMPLE_TYPES: Record<string, PeckViewTypeName> = {
  'error-response.json': 'ErrorResponse',
  'feed-page-last.json': 'FeedPage',
  'feed-page.json': 'FeedPage',
  'post-batch.json': 'PostBatch',
  'profile-view.json': 'ProfileView',
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

  it('ErrorResponse -> ReadError with the contract code', async () => {
    const example = load('error-response.json') as { error: { code: string; message: string } }
    const err = await serving(example, 404).client.post('ab'.repeat(32)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReadError)
    expect(err).toMatchObject({ code: example.error.code, status: 404, message: example.error.message })
  })
})
