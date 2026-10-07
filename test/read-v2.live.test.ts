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

  it('stats and apps', async () => {
    const stats = await client.stats()
    expect(peckViewErrors('SiteStats', stats)).toEqual([])
    const apps = await client.apps()
    expect(peckViewErrors('AppList', apps)).toEqual([])
    expect(apps.apps.length).toBeGreaterThan(0)
  }, 30_000)

  it('channels, identities and lenses', async () => {
    const channels = await client.channels({ limit: 10 })
    expect(peckViewErrors('ChannelList', channels)).toEqual([])
    expect(channels.posting.length + channels.rooms.length).toBeGreaterThan(0)
    const identities = await client.identities({ limit: 5 })
    expect(peckViewErrors('IdentityList', identities)).toEqual([])
    expect(identities.items.length).toBeGreaterThan(0)
    const lenses = await client.lenses()
    expect(peckViewErrors('LensList', lenses)).toEqual([])
    const issuer = lenses.items[0]?.issuer.key
    if (issuer) {
      const mine = await client.lenses({ issuer })
      expect(mine.items.every((l) => l.issuer.key === issuer)).toBe(true)
    }
  }, 30_000)

  it('messages: a room and the global chat, newest first and paged; a direct read needs a name', async () => {
    const { rooms } = await client.channels({ limit: 5 })
    const room = rooms[0]?.channel
    if (room) {
      const page = await client.messages({ channel: room, limit: 3 })
      expect(peckViewErrors('MessagePage', page)).toEqual([])
      expect(page.items.length).toBeGreaterThan(0)
      expect(page.items.every((m) => m.channel === room && !m.direct)).toBe(true)
      const times = page.items.map((m) => m.createdAt)
      expect(times).toEqual([...times].sort().reverse())
      if (page.next) {
        const older = await client.messages({ channel: room, limit: 3, cursor: page.next })
        expect(peckViewErrors('MessagePage', older)).toEqual([])
        expect(older.items.map((m) => m.txid)).not.toContain(page.items[0]?.txid)
      }
      // What arrived since the newest message: nothing newer than the head, oldest first.
      const head = page.items[0]
      if (head) {
        const since = await client.messages({ channel: room, order: 'asc', limit: 3, cursor: { after_ts: head.createdAt, after_txid: head.txid } })
        expect(peckViewErrors('MessagePage', since)).toEqual([])
      }
    }
    const global = await client.messages({ scope: 'global', limit: 3 })
    expect(peckViewErrors('MessagePage', global)).toEqual([])
    expect(global.items.every((m) => m.channel === null && !m.direct)).toBe(true)
    await expect(client.messages({} as never)).rejects.toMatchObject({ code: 'bad_request', status: 0 })
  }, 60_000)

  it('authors "across bitcoin": ranked, paged, and a first snapshot that may still be loading', async () => {
    let list = null
    for (let attempt = 0; attempt < 6 && !list; attempt++) {
      try {
        list = await client.authors({ limit: 5 })
      } catch (e) {
        if ((e as { status?: number }).status !== 503) throw e
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    expect(list).not.toBeNull()
    if (!list) return
    expect(peckViewErrors('AuthorList', list)).toEqual([])
    expect(list.items.length).toBeGreaterThan(0)
    const posts = list.items.map((i) => i.posts)
    expect(posts).toEqual([...posts].sort((a, b) => b - a))
    if (list.next) {
      const second = await client.authors({ limit: 5, cursor: list.next })
      expect(peckViewErrors('AuthorList', second)).toEqual([])
      expect(second.items.map((i) => i.author.key)).not.toContain(list.items[0]?.author.key)
    }
    const app = list.items[0]?.app
    if (app) {
      const one = await client.authors({ app, limit: 5 })
      expect(peckViewErrors('AuthorList', one)).toEqual([])
      expect(one.items.every((i) => i.app === app)).toBe(true)
    }
  }, 60_000)

  it('reactions of a post, paged', async () => {
    const page = await client.feed({ limit: 50, rank: 'top' })
    const liked = page.items.find((p) => p.counts.likes > 0)
    if (!liked) return
    const first = await client.reactions(liked.txid, { limit: 2 })
    expect(peckViewErrors('ReactionPage', first)).toEqual([])
    expect(first.items.length).toBeGreaterThan(0)
    if (first.next) {
      const second = await client.reactions(liked.txid, { limit: 2, cursor: first.next })
      expect(peckViewErrors('ReactionPage', second)).toEqual([])
    }
    const reposts = await client.reactions(liked.txid, { kind: 'repost', limit: 2 })
    expect(peckViewErrors('ReactionPage', reposts)).toEqual([])
  }, 60_000)

  it('geo filters: a box and a radius around the same point find located posts', async () => {
    const located = await client.feed({ hasGeo: true, limit: 5 })
    expect(peckViewErrors('FeedPage', located)).toEqual([])
    const geo = located.items.find((p) => p.geo)?.geo
    if (!geo) return
    // Latitude first: a box a degree around the pin, and a 50 km circle.
    const box = await client.feed({
      bbox: { minLat: geo.lat - 1, minLng: geo.lng - 1, maxLat: geo.lat + 1, maxLng: geo.lng + 1 },
      limit: 20,
    })
    expect(peckViewErrors('FeedPage', box)).toEqual([])
    expect(box.items.length).toBeGreaterThan(0)
    for (const p of box.items) {
      expect(p.geo).toBeTruthy()
      expect(Math.abs((p.geo?.lat ?? 999) - geo.lat)).toBeLessThanOrEqual(1)
      expect(Math.abs((p.geo?.lng ?? 999) - geo.lng)).toBeLessThanOrEqual(1)
    }
    const near = await client.feed({ near: { lat: geo.lat, lng: geo.lng, radiusKm: 50 }, limit: 20 })
    expect(peckViewErrors('FeedPage', near)).toEqual([])
    expect(near.items.length).toBeGreaterThan(0)
  }, 60_000)

  it('a malformed txid is a typed bad_request', async () => {
    await expect(client.post('zz')).rejects.toMatchObject({ code: 'bad_request', status: 400 })
  }, 30_000)
})
