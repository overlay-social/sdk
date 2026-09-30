/**
 * Location on a post. There is no "pin" transaction type: a pin is a post with
 * a location, so any app can attach one to any post, reply or quote, and every
 * reader that looks at coordinates shows it.
 *
 * On chain a location is plain MAP `SET` key/value pairs, in this order:
 *
 *   lat <decimal> lng <decimal> [alt <decimal>] [geohash <base32>]
 *
 * These are the keys the indexer and overlay parsers read (`lat`, `lng`, `alt`,
 * `geohash`); the web clients that write locations today emit `lat` and `lng`
 * as JavaScript `String(number)`, and this module produces exactly that form
 * for coordinates that have at most `precision` decimals. Numbers are written
 * without an exponent, without trailing zeros and rounded to at most
 * `precision` decimals, so the same location always encodes to the same bytes.
 *
 * A post with the coordinates (0, 0) is ignored by the indexer, so it is
 * rejected here instead of being written and never shown.
 */
import { SchemaError, type Push } from './bitcom.js'

/** A location to attach to a post, reply or quote. */
export interface GeoInput {
  /** Latitude in degrees, -90 to 90. */
  lat: number
  /** Longitude in degrees, -180 to 180. */
  lng: number
  /** Altitude in metres above sea level. Optional; written with at most 2 decimals. */
  alt?: number
  /**
   * A geohash for prefix and proximity lookups. `true` computes one of
   * {@link DEFAULT_GEOHASH_LENGTH} characters from the written coordinates, a
   * number (1 to 12) computes one of that length, and a string is checked
   * against the coordinates and written as it is (lowercase). Left out, no
   * geohash is written.
   */
  geohash?: boolean | number | string
  /**
   * Most decimals written for `lat` and `lng`, 0 to 15. The default of 6 is
   * about 0.1 m, the precision the peck.to composer writes. A location on
   * chain is permanent and public: pass a lower value to publish a coarser one.
   */
  precision?: number
}

/** The location as it is written: every value is the exact string put on chain. */
export interface GeoFields {
  lat: string
  lng: string
  alt?: string
  geohash?: string
}

/** Decimals written for `lat` and `lng` unless `precision` says otherwise. */
export const DEFAULT_GEO_PRECISION = 6
/** Most decimals accepted for `precision`: a `number` carries about 15 to 17 significant digits. */
export const MAX_GEO_PRECISION = 15
/** Decimals written for `alt`. */
export const ALT_DECIMALS = 2
/** Length of the geohash written for `geohash: true`: a cell about 5 m across. */
export const DEFAULT_GEOHASH_LENGTH = 9
/** Longest geohash accepted: 12 characters is about 4 cm by 2 cm. */
export const MAX_GEOHASH_LENGTH = 12

const MAX_ALT = 1e7

/**
 * A number as a plain decimal string: no exponent, at most `decimals`
 * decimals, no trailing zeros, no "-0". Numbers that already have few enough
 * decimals keep the shortest form that reads back as the same number
 * (`String(n)`), so `59.9` is "59.9", not "59.899999999999999".
 */
function decimal(n: number, decimals: number): string {
  let s = String(n)
  const dot = s.indexOf('.')
  if (/e/i.test(s) || (dot !== -1 && s.length - dot - 1 > decimals)) s = n.toFixed(decimals)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

// ── geohash ─────────────────────────────────────────────────────

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
const GEOHASH_RE = /^[0-9b-hjkmnp-z]{1,12}$/

/**
 * The geohash of a point: standard base-32 geohash, longitude first.
 * `length` is 1 to 12 characters (default {@link DEFAULT_GEOHASH_LENGTH}).
 */
export function encodeGeohash(lat: number, lng: number, length: number = DEFAULT_GEOHASH_LENGTH): string {
  checkLatLng(lat, lng)
  if (!Number.isInteger(length) || length < 1 || length > MAX_GEOHASH_LENGTH) {
    throw new SchemaError(`geohash length must be an integer from 1 to ${MAX_GEOHASH_LENGTH}`)
  }
  let latLo = -90
  let latHi = 90
  let lngLo = -180
  let lngHi = 180
  let out = ''
  let index = 0
  let bit = 0
  let onLng = true
  while (out.length < length) {
    const [v, lo, hi] = onLng ? [lng, lngLo, lngHi] : [lat, latLo, latHi]
    const mid = (lo + hi) / 2
    index <<= 1
    if (v >= mid) {
      index |= 1
      if (onLng) lngLo = mid
      else latLo = mid
    } else if (onLng) lngHi = mid
    else latHi = mid
    onLng = !onLng
    if (++bit === 5) {
      out += BASE32[index]
      index = 0
      bit = 0
    }
  }
  return out
}

/** The cell a geohash names: its bounds and centre, in degrees. Throws on an invalid geohash. */
export function decodeGeohash(hash: string): {
  lat: number
  lng: number
  south: number
  west: number
  north: number
  east: number
} {
  const h = typeof hash === 'string' ? hash.toLowerCase() : ''
  if (!GEOHASH_RE.test(h)) throw new SchemaError('geohash must be 1 to 12 characters of the geohash alphabet')
  let south = -90
  let north = 90
  let west = -180
  let east = 180
  let onLng = true
  for (const ch of h) {
    const v = BASE32.indexOf(ch)
    for (let mask = 16; mask > 0; mask >>= 1) {
      const set = (v & mask) !== 0
      if (onLng) {
        const mid = (west + east) / 2
        if (set) west = mid
        else east = mid
      } else {
        const mid = (south + north) / 2
        if (set) south = mid
        else north = mid
      }
      onLng = !onLng
    }
  }
  return { lat: (south + north) / 2, lng: (west + east) / 2, south, west, north, east }
}

function checkLatLng(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) throw new SchemaError('geo.lat must be a number within ±90')
  if (!Number.isFinite(lng) || Math.abs(lng) > 180) throw new SchemaError('geo.lng must be a number within ±180')
}

// ── normalisation ───────────────────────────────────────────────

/**
 * Validate a location and format it as it is written on chain. Throws a
 * `SchemaError` for a value out of range, not a finite number, or (0, 0).
 */
export function normalizeGeo(geo: GeoInput): GeoFields {
  const { lat, lng } = geo
  checkLatLng(lat, lng)

  const precision = geo.precision ?? DEFAULT_GEO_PRECISION
  if (!Number.isInteger(precision) || precision < 0 || precision > MAX_GEO_PRECISION) {
    throw new SchemaError(`geo.precision must be an integer from 0 to ${MAX_GEO_PRECISION}`)
  }

  const out: GeoFields = { lat: decimal(lat, precision), lng: decimal(lng, precision) }
  if (out.lat === '0' && out.lng === '0') {
    throw new SchemaError('geo 0,0 is ignored by the indexer; leave geo out instead')
  }

  if (geo.alt !== undefined) {
    if (!Number.isFinite(geo.alt) || Math.abs(geo.alt) > MAX_ALT) {
      throw new SchemaError('geo.alt must be a number of metres within ±10,000,000')
    }
    out.alt = decimal(geo.alt, ALT_DECIMALS)
  }

  const wanted = geo.geohash
  if (wanted !== undefined && wanted !== false) {
    const written = { lat: Number(out.lat), lng: Number(out.lng) }
    if (typeof wanted === 'string') {
      out.geohash = checkGeohash(wanted, written, precision)
    } else {
      out.geohash = encodeGeohash(written.lat, written.lng, wanted === true ? DEFAULT_GEOHASH_LENGTH : wanted)
    }
  }
  return out
}

/**
 * A caller-supplied geohash must be one whose cell holds the written point.
 * The point may sit up to half a rounding step outside it, because the caller
 * may have hashed the coordinates before they were rounded to `precision`.
 */
function checkGeohash(value: string, at: { lat: number; lng: number }, precision: number): string {
  const hash = value.toLowerCase()
  const cell = decodeGeohash(hash)
  const slack = 0.5 * 10 ** -precision + 1e-12
  const inside =
    at.lat >= cell.south - slack && at.lat <= cell.north + slack &&
    at.lng >= cell.west - slack && at.lng <= cell.east + slack
  if (!inside) throw new SchemaError('geo.geohash does not contain geo.lat, geo.lng')
  return hash
}

/** The MAP `SET` pushes for a location: `lat`, `lng`, then `alt` and `geohash` when present. */
export function geoFields(geo: GeoInput | undefined): Push[] {
  if (!geo) return []
  const g = normalizeGeo(geo)
  return [
    'lat', g.lat,
    'lng', g.lng,
    ...(g.alt !== undefined ? ['alt', g.alt] : []),
    ...(g.geohash !== undefined ? ['geohash', g.geohash] : []),
  ]
}
