// Live smoke test against a running overlay. Skipped unless PECK_VIEW_LIVE is
// set; PECK_VIEW_LIVE_URL overrides the base URL (default https://overlay.peck.to).
//
//   PECK_VIEW_LIVE=1 npx vitest run test/read-v2.live.test.ts
//
// Every response is checked against the vendored peck-view/v1 schema, so this
// is also the drift check between the vendored contract and what is served.
import { describe, expect, it } from 'vitest'
import { createReadClient } from '../src/read/index.js'
import { peckViewErrors } from './helpers/peck-view-validator.js'

const live = !!process.env.PECK_VIEW_LIVE
const baseUrl = process.env.PECK_VIEW_LIVE_URL || undefined

describe.skipIf(!live)('live /v2 smoke test', () => {
  const client = createReadClient({ baseUrl, timeoutMs: 20_000 })

  it('feed, post, posts and viewerState agree with the contract', async () => {
    const page = await client.feed({ limit: 3 })
    expect(peckViewErrors('FeedPage', page)).toEqual([])
    const first = page.items[0]
    expect(first).toBeDefined()
    if (!first) return

    const thread = await client.post(first.txid)
    expect(peckViewErrors('ThreadView', thread)).toEqual([])
    expect(thread.post.txid).toBe(first.txid)

    const batch = await client.posts([first.txid, 'f'.repeat(64)])
    expect(peckViewErrors('PostBatch', batch)).toEqual([])
    expect(batch.missing).toEqual(['f'.repeat(64)])

    const state = await client.viewerState({ viewer: first.author.key, txids: [first.txid], authors: [first.author.key] })
    expect(peckViewErrors('ViewerState', state)).toEqual([])

    if (page.next) {
      const second = await client.feed({ limit: 3, cursor: page.next })
      expect(peckViewErrors('FeedPage', second)).toEqual([])
      expect(second.items.map((p) => p.txid)).not.toContain(first.txid)
    }
  }, 60_000)

  it('profile of the first author', async () => {
    const page = await client.feed({ limit: 1 })
    const key = page.items[0]?.author.key
    if (!key) return
    const profile = await client.profile(key)
    expect(peckViewErrors('ProfileView', profile)).toEqual([])
  }, 30_000)

  it('search', async () => {
    const page = await client.search({ q: 'bitcoin', limit: 3 })
    expect(peckViewErrors('FeedPage', page)).toEqual([])
    expect(page.next).toBeNull()
  }, 30_000)

  it('a malformed txid is a typed bad_request', async () => {
    await expect(client.post('zz')).rejects.toMatchObject({ code: 'bad_request', status: 400 })
  }, 30_000)
})
