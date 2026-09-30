import { describe, expect, it } from 'vitest'
import * as root from '../src/index.js'
import * as read from '../src/read/index.js'
import type { PeckRow, SourceHandle } from '../src/index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = []
  const fetchStub = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return handler(url)
  }) as typeof fetch
  const client = root.createOverlayClient({ baseUrl: 'https://overlay.example', fetch: fetchStub })
  return { client, calls }
}

describe('package root', () => {
  it('re-exports the read module unchanged', () => {
    expect(Object.keys(root).sort()).toEqual(Object.keys(read).sort())
    expect(root.createOverlayClient).toBe(read.createOverlayClient)
    expect(root.OverlayClient).toBe(read.OverlayClient)
    expect(root.DEFAULT_OVERLAY_URL).toBe('https://overlay.peck.to')
  })

  it('keeps the PeckRow types importable from the root', () => {
    const handle: SourceHandle = {
      namespace: 'zanaadu',
      value: '@14',
      number: 14,
      kind: 'user_number',
      membership_proof: 'none',
    }
    const row: Pick<PeckRow, 'source_handle'> = { source_handle: handle }
    expect(row.source_handle?.number).toBe(14)
  })
})

describe('overlay read client', () => {
  it('builds feed queries with the documented defaults', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ status: 'ok', data: [] }))
    await client.getFeed({ limit: 5, type: 'post' })
    const url = new URL(calls[0] ?? '')
    expect(url.origin).toBe('https://overlay.example')
    expect(url.pathname).toBe('/v1/feed')
    expect(url.searchParams.get('limit')).toBe('5')
    expect(url.searchParams.get('type')).toBe('post')
    expect(url.searchParams.get('order')).toBe('desc')
  })

  it('sends `types` instead of `type` when both are given', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ status: 'ok', data: [] }))
    await client.getFeed({ type: 'post', types: 'post,reply' })
    const url = new URL(calls[0] ?? '')
    expect(url.searchParams.get('types')).toBe('post,reply')
    expect(url.searchParams.has('type')).toBe(false)
  })

  it('sends the /v1 bbox latitude first, whatever order the caller thinks in', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ status: 'ok', data: [] }))
    // The parameter is [west, south, east, north] (longitude first, GeoJSON order).
    // Oslo: longitude about 10.7, latitude about 59.9.
    await client.getFeed({ bbox: [10.6, 59.8, 10.9, 60.0] })
    const url = new URL(calls[0] ?? '')
    // The overlay reads minLat,minLng,maxLat,maxLng.
    expect(url.searchParams.get('bbox')).toBe('59.8,10.6,60,10.9')
  })

  it('lets `near` win over `bbox` and leaves the near wire format alone', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ status: 'ok', data: [] }))
    await client.getFeed({ near: { lat: 59.9, lng: 10.7 }, radiusKm: 3, bbox: [1, 2, 3, 4] })
    const url = new URL(calls[0] ?? '')
    expect(url.searchParams.get('near')).toBe('59.9,10.7')
    expect(url.searchParams.get('radius_km')).toBe('3')
    expect(url.searchParams.has('bbox')).toBe(false)
  })

  it('throws on an unexpected feed shape', async () => {
    const { client } = clientWith(() => jsonResponse({ nope: true }))
    await expect(client.getFeed()).rejects.toThrow(/unexpected shape/)
  })

  it('returns safe-empty values when the upstream fails', async () => {
    const { client } = clientWith(() => jsonResponse({ error: 'boom' }, 500))
    expect(await client.resolveIdentities({ addresses: ['1abc'] })).toEqual({})
    expect(await client.getNotifications('1abc')).toEqual([])
    expect(await client.getBlocks('1abc')).toEqual([])
  })

  it('returns null for a missing post and throws on a server error', async () => {
    const missing = clientWith(() => jsonResponse({ error: 'not found' }, 404))
    expect(await missing.client.getPost('deadbeef')).toBeNull()
    const broken = clientWith(() => jsonResponse({ error: 'boom' }, 500))
    await expect(broken.client.getPost('deadbeef')).rejects.toThrow(/overlay 500/)
  })

  it('short-circuits empty inputs without a request', async () => {
    const { client, calls } = clientWith(() => jsonResponse({}))
    expect(await client.getPost('')).toBeNull()
    expect(await client.getFollows('')).toEqual({
      followers: 0,
      following: 0,
      data: { followers: [], following: [] },
    })
    expect(calls).toHaveLength(0)
  })
})
