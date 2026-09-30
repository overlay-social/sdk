import { Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  PIN_CATEGORIES,
  PROTO_B,
  PROTO_MAP,
  SchemaError,
  decodeGeohash,
  encodeGeohash,
  normalizeGeo,
  pin,
  post,
  quote,
  reply,
  type GeoInput,
  type SchemaPayload,
} from '../src/schema/index.js'

const T1 = 'a'.repeat(64)

const texts = (p: SchemaPayload) => p.pushes.map((b) => Utils.toUTF8([...b]))

/** The MAP location values a post carries, as written. */
function written(geo: GeoInput): Record<string, string> {
  const t = texts(post({ app: 'x', text: 'hi', geo }))
  const out: Record<string, string> = {}
  for (const key of ['lat', 'lng', 'alt', 'geohash']) {
    const at = t.indexOf(key, t.indexOf('SET'))
    if (at !== -1) out[key] = t[at + 1]!
  }
  return out
}

describe('geo: number formatting', () => {
  it('keeps short numbers as JavaScript writes them', () => {
    expect(written({ lat: 59.91, lng: 10.75 })).toEqual({ lat: '59.91', lng: '10.75' })
    expect(written({ lat: 59.938585, lng: 10.759031 })).toEqual({ lat: '59.938585', lng: '10.759031' })
    expect(written({ lat: -33.8688, lng: 151.2093 })).toEqual({ lat: '-33.8688', lng: '151.2093' })
    expect(written({ lat: 60, lng: -180 })).toEqual({ lat: '60', lng: '-180' })
  })

  it('rounds to 6 decimals by default and drops trailing zeros', () => {
    expect(written({ lat: 59.123456789, lng: 10.1000001 })).toEqual({ lat: '59.123457', lng: '10.1' })
    expect(written({ lat: 59.9999996, lng: 10.5 })).toEqual({ lat: '60', lng: '10.5' })
  })

  it('takes a precision from 0 to 15', () => {
    expect(written({ lat: 59.129, lng: 10.751, precision: 2 })).toEqual({ lat: '59.13', lng: '10.75' })
    expect(written({ lat: 59.6, lng: 10.4, precision: 0 })).toEqual({ lat: '60', lng: '10' })
    // No 17-digit artefacts for numbers that already fit.
    expect(written({ lat: 59.9, lng: 10.1, precision: 15 })).toEqual({ lat: '59.9', lng: '10.1' })
  })

  it('never writes an exponent or a negative zero', () => {
    expect(String(1e-7)).toBe('1e-7')
    expect(written({ lat: 1e-7, lng: 10 })).toEqual({ lat: '0', lng: '10' })
    expect(written({ lat: -1e-7, lng: -1e-9 + 5 })).toEqual({ lat: '0', lng: '5' })
    expect(written({ lat: 0.00000123, lng: 10 })).toEqual({ lat: '0.000001', lng: '10' })
    expect(written({ lat: -0, lng: 10 })).toEqual({ lat: '0', lng: '10' })
  })

  it('is deterministic and does not touch its input', () => {
    const geo = Object.freeze({ lat: 59.123456789, lng: 10.987654321, alt: 12.3456, geohash: true }) as GeoInput
    const a = texts(post({ app: 'x', text: 'hi', geo }))
    const b = texts(post({ app: 'x', text: 'hi', geo: { ...geo } }))
    expect(a).toEqual(b)
  })

  it('writes altitude with at most 2 decimals', () => {
    expect(written({ lat: 1, lng: 1, alt: 12.3456 })).toMatchObject({ alt: '12.35' })
    expect(written({ lat: 1, lng: 1, alt: -410 })).toMatchObject({ alt: '-410' })
    expect(written({ lat: 1, lng: 1, alt: 0 })).toMatchObject({ alt: '0' })
  })
})

describe('geo: validation', () => {
  const bad: Array<[string, GeoInput | Record<string, unknown>]> = [
    ['lat above 90', { lat: 90.0001, lng: 0 }],
    ['lat below -90', { lat: -91, lng: 0 }],
    ['lng above 180', { lat: 0, lng: 180.5 }],
    ['lat NaN', { lat: NaN, lng: 10 }],
    ['lng Infinity', { lat: 10, lng: Infinity }],
    ['lat as a string', { lat: '59.9', lng: 10 }],
    ['lng missing', { lat: 59.9 }],
    ['alt NaN', { lat: 1, lng: 1, alt: NaN }],
    ['alt out of range', { lat: 1, lng: 1, alt: 1e8 }],
    ['precision above 15', { lat: 1, lng: 1, precision: 16 }],
    ['precision negative', { lat: 1, lng: 1, precision: -1 }],
    ['precision fractional', { lat: 1, lng: 1, precision: 1.5 }],
    ['geohash length 0', { lat: 1, lng: 1, geohash: 0 }],
    ['geohash length 13', { lat: 1, lng: 1, geohash: 13 }],
    ['geohash outside the alphabet', { lat: 1, lng: 1, geohash: 'abc' }],
    ['geohash of another place', { lat: 59.9, lng: 10.7, geohash: 'ezs42' }],
    ['empty geohash', { lat: 1, lng: 1, geohash: '' }],
  ]
  for (const [name, geo] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => post({ app: 'x', text: 'hi', geo: geo as unknown as GeoInput })).toThrow(SchemaError)
    })
  }

  it('rejects 0,0, which the indexer ignores, also after rounding', () => {
    expect(() => normalizeGeo({ lat: 0, lng: 0 })).toThrow(/0,0/)
    expect(() => normalizeGeo({ lat: 1e-9, lng: -1e-9 })).toThrow(/0,0/)
    expect(normalizeGeo({ lat: 0, lng: 0.000001 })).toMatchObject({ lat: '0', lng: '0.000001' })
    expect(normalizeGeo({ lat: 0, lng: 5 })).toMatchObject({ lat: '0', lng: '5' })
  })

  it('leaves the location out when geo is undefined', () => {
    expect(texts(post({ app: 'x', text: 'hi' }))).not.toContain('lat')
    expect(texts(post({ app: 'x', text: 'hi', geo: undefined }))).not.toContain('lat')
  })
})

describe('geo: MAP layout', () => {
  it('writes lat, lng, alt, geohash in that order, after the channel and before mentions', () => {
    const p = post({
      app: 'peck.to',
      text: 'hi',
      channel: 'oslo',
      geo: { lat: 59.91, lng: 10.75, alt: 23, geohash: 7 },
      mentions: ['1Addr'],
      tags: ['a'],
    })
    expect(texts(p).slice(texts(p).indexOf(PROTO_MAP))).toEqual([
      PROTO_MAP, 'SET', 'app', 'peck.to', 'type', 'post', 'content', 'hi',
      'context', 'channel', 'channel', 'oslo',
      'lat', '59.91', 'lng', '10.75', 'alt', '23', 'geohash', 'u4xsud7',
      'mention', '1Addr',
      '|', PROTO_MAP, 'ADD', 'tags', 'a',
    ])
  })

  it('reply and quote carry a location too', () => {
    const r = texts(reply({ app: 'x', text: 'hi', parentTxid: T1, geo: { lat: 1.5, lng: 2.5 } }))
    expect(r.slice(r.indexOf('reply'))).toEqual(['reply', T1, 'lat', '1.5', 'lng', '2.5'])
    const q = texts(quote({ app: 'x', text: 'hi', targetTxid: T1, geo: { lat: 1.5, lng: 2.5, geohash: true } }))
    expect(q.slice(q.indexOf('lat'))).toEqual(['lat', '1.5', 'lng', '2.5', 'geohash', encodeGeohash(1.5, 2.5, 9)])
  })

  it('a location works on a media post', () => {
    const t = texts(post({
      app: 'x',
      media: { data: [1, 2, 3], mediaType: 'image/jpeg', filename: 'a.jpg' },
      geo: { lat: 1.5, lng: 2.5 },
    }))
    expect(t.slice(-4)).toEqual(['lat', '1.5', 'lng', '2.5'])
  })
})

describe('geohash', () => {
  it('encodes known points', () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj')
    expect(encodeGeohash(42.6, -5.6, 5)).toBe('ezs42')
    expect(encodeGeohash(0, 0, 9)).toBe('s00000000')
    expect(encodeGeohash(59.9139, 10.7522, 6)).toBe('u4xsud')
    expect(encodeGeohash(-25.382708, -49.265506, 12)).toBe('6gkzwgjzn820')
  })

  it('handles the poles and the antimeridian', () => {
    expect(encodeGeohash(90, 180, 4)).toBe('zzzz')
    expect(encodeGeohash(-90, -180, 4)).toBe('0000')
  })

  it('decodes to the cell that holds the point', () => {
    const cell = decodeGeohash('ezs42')
    expect(cell.lat).toBeCloseTo(42.605, 3)
    expect(cell.lng).toBeCloseTo(-5.603, 3)
    for (const [lat, lng] of [[59.9139, 10.7522], [-33.8688, 151.2093], [0.5, -0.5], [89.9, 179.9], [-89.9, -179.9]] as const) {
      for (const len of [1, 5, 9, 12]) {
        const c = decodeGeohash(encodeGeohash(lat, lng, len))
        expect(lat).toBeGreaterThanOrEqual(c.south)
        expect(lat).toBeLessThanOrEqual(c.north)
        expect(lng).toBeGreaterThanOrEqual(c.west)
        expect(lng).toBeLessThanOrEqual(c.east)
      }
    }
  })

  it('is computed from the coordinates as written, not the raw input', () => {
    // 59.9999996 is written as 60.
    expect(normalizeGeo({ lat: 59.9999996, lng: 10, geohash: true }).geohash).toBe(encodeGeohash(60, 10, 9))
  })

  it('accepts a matching geohash, lowercases it, and tolerates rounding at a cell edge', () => {
    expect(normalizeGeo({ lat: 59.9139, lng: 10.7522, geohash: 'U4XSUD' }).geohash).toBe('u4xsud')
    // The cell 'u4xsud' starts at latitude 59.908447265625. A point just inside it is written as
    // 59.908447, a little outside, and still matches: it was hashed before rounding.
    expect(normalizeGeo({ lat: 59.9084473, lng: 10.75, geohash: 'u4xsud' })).toMatchObject({
      lat: '59.908447',
      geohash: 'u4xsud',
    })
    // A point a whole rounding step or more outside does not.
    expect(() => normalizeGeo({ lat: 59.9084, lng: 10.75, geohash: 'u4xsud' })).toThrow(SchemaError)
  })

  it('rejects bad input', () => {
    expect(() => encodeGeohash(91, 0)).toThrow(SchemaError)
    expect(() => encodeGeohash(0, 0, 0)).toThrow(SchemaError)
    expect(() => decodeGeohash('a')).toThrow(SchemaError)
    expect(() => decodeGeohash('')).toThrow(SchemaError)
  })
})

describe('pin', () => {
  const geo = { lat: 59.9139, lng: 10.7522 }

  it('lays out a pin the way peck.world writes one', () => {
    const p = pin({ app: 'peck.world', title: 'Cafe', description: 'Good coffee.', category: 'business', geo })
    expect(texts(p)).toEqual([
      PROTO_B, '# Cafe\n\nGood coffee.', 'text/markdown', 'utf-8', 'pin.md', '|',
      PROTO_MAP, 'SET', 'app', 'peck.world', 'type', 'post',
      'lat', '59.9139', 'lng', '10.7522', 'category', 'business', 'title', 'Cafe',
    ])
  })

  it('has no description body and defaults the category to "general"', () => {
    const t = texts(pin({ app: 'x', title: '  Hello  ', geo }))
    expect(t[1]).toBe('# Hello')
    expect(t.slice(-4)).toEqual(['category', 'general', 'title', 'Hello'])
  })

  it('writes alt and geohash before category, and mentions and tags after title', () => {
    const t = texts(pin({ app: 'x', title: 'T', geo: { ...geo, alt: 12, geohash: 6 }, mentions: ['1A'], tags: ['b', 'c'] }))
    expect(t.slice(t.indexOf('lat'))).toEqual([
      'lat', '59.9139', 'lng', '10.7522', 'alt', '12', 'geohash', 'u4xsud',
      'category', 'general', 'title', 'T', 'mention', '1A',
      '|', PROTO_MAP, 'ADD', 'tags', 'b', 'c',
    ])
  })

  it('lists the categories peck.world knows', () => {
    expect(PIN_CATEGORIES).toEqual(['general', 'business', 'event', 'alert', 'idea', 'photo'])
  })

  const bad: Array<[string, () => unknown]> = [
    ['no geo', () => pin({ app: 'x', title: 'T' } as never)],
    ['bad geo', () => pin({ app: 'x', title: 'T', geo: { lat: 100, lng: 0 } })],
    ['no title', () => pin({ app: 'x', title: '', geo })],
    ['blank title', () => pin({ app: 'x', title: '   ', geo })],
    ['title not a string', () => pin({ app: 'x', title: 5 as never, geo })],
    ['multi-line title', () => pin({ app: 'x', title: 'a\nb', geo })],
    ['pipe title', () => pin({ app: 'x', title: '|', geo })],
    ['no app', () => pin({ app: '', title: 'T', geo })],
  ]
  for (const [name, fn] of bad) {
    it(`rejects ${name}`, () => expect(fn).toThrow(SchemaError))
  }
})
