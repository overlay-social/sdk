import { describe, expect, it } from 'vitest'
import { PECK_TO, PECK_WORLD, postUrl, worldUrl } from '../src/links/index.js'

const TXID = 'ab'.repeat(32)

describe('postUrl', () => {
  it('is https://peck.to/tx/<txid>', () => {
    expect(PECK_TO).toBe('https://peck.to')
    expect(postUrl(TXID)).toBe(`https://peck.to/tx/${TXID}`)
  })

  it('lower-cases the txid, as peck.to redirects to it', () => {
    expect(postUrl(TXID.toUpperCase())).toBe(`https://peck.to/tx/${TXID}`)
  })

  it('takes another host', () => {
    expect(postUrl(TXID, 'https://next.peck.to/')).toBe(`https://next.peck.to/tx/${TXID}`)
  })

  it.each([[''], ['abc'], [TXID + 'a'], ['g'.repeat(64)], [`${TXID}/../x`], [' ' + TXID]])('gives null for %j', (value) => {
    expect(postUrl(value)).toBeNull()
  })
  it('gives null for a non-string', () => {
    expect(postUrl(undefined as unknown as string)).toBeNull()
  })
})

describe('worldUrl', () => {
  it('matches the location chip of peck.to v2 (worldHref)', () => {
    expect(PECK_WORLD).toBe('https://peck.world')
    expect(worldUrl(TXID, 59.9139, 10.7522)).toBe(`https://peck.world/?tx=${TXID}&at=59.9139,10.7522`)
    expect(worldUrl(TXID, 59.910123456, -10.759999999)).toBe(`https://peck.world/?tx=${TXID}&at=59.910123,-10.76`)
  })

  it('writes at most 6 decimals, no trailing zeros, no exponent, no negative zero', () => {
    expect(worldUrl(TXID, 60, 10)).toBe(`https://peck.world/?tx=${TXID}&at=60,10`)
    expect(worldUrl(TXID, 0.0000004, -0.0000004)).toBe(`https://peck.world/?tx=${TXID}&at=0,0`)
    expect(worldUrl(TXID, 1e-6, 2.5e-5)).toBe(`https://peck.world/?tx=${TXID}&at=0.000001,0.000025`)
    expect(worldUrl(TXID, -90, 180)).toBe(`https://peck.world/?tx=${TXID}&at=-90,180`)
  })

  it('takes another host', () => {
    expect(worldUrl(TXID, 1, 2, 'http://localhost:5173/')).toBe(`http://localhost:5173/?tx=${TXID}&at=1,2`)
  })

  it.each([
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
  ])('gives null for the coordinates %s, %s', (lat, lng) => {
    expect(worldUrl(TXID, lat, lng)).toBeNull()
  })

  it('gives null for a bad txid and for strings in place of numbers', () => {
    expect(worldUrl('nope', 1, 2)).toBeNull()
    expect(worldUrl(TXID, '1' as unknown as number, 2)).toBeNull()
  })
})
