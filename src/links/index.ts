// The `links` module: public addresses of a post and of a located post, built the way peck.to
// builds them, so every app links to the same place.
//
//   import { postUrl, worldUrl } from '@overlay-social/sdk/links'
//
//   postUrl(txid)                    // https://peck.to/tx/<txid>
//   worldUrl(txid, 59.9139, 10.7522) // https://peck.world/?tx=<txid>&at=59.9139,10.7522
//
// No dependencies, no DOM, no network. Both helpers return `null` for input that is not an
// address (a txid that is not 64 hex characters, coordinates that are not a place on Earth), so
// a renderer can leave the link out instead of writing a broken one.

/** peck.to, where a post has its thread page at `/tx/<txid>`. */
export const PECK_TO = 'https://peck.to'
/** peck.world, where every located post is a marker. */
export const PECK_WORLD = 'https://peck.world'

const TXID_RE = /^[0-9a-f]{64}$/i

/** A coordinate to at most 6 decimals (about 0.1 m), without a trailing zero or an exponent. */
function degrees(n: number): string {
  return String(Number(n.toFixed(6)))
}

const trimSlashes = (base: string): string => base.replace(/\/+$/, '')

/**
 * The public page of a post: `https://peck.to/tx/<txid>`. `base` is another host that serves the
 * same route (a preview host); default {@link PECK_TO}. The txid is written in lower case.
 */
export function postUrl(txid: string, base: string = PECK_TO): string | null {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) return null
  return `${trimSlashes(base)}/tx/${txid.toLowerCase()}`
}

/**
 * That post's spot on peck.world, where the map opens on it with the post selected:
 * `https://peck.world/?tx=<txid>&at=<lat>,<lng>`. Coordinates are written like peck.to's location
 * chip writes them: rounded to 6 decimals, no trailing zeros, no exponent. `base` defaults to
 * {@link PECK_WORLD}. `null` for a txid that is not 64 hex characters and for coordinates that are
 * not finite or outside -90..90 / -180..180.
 */
export function worldUrl(txid: string, lat: number, lng: number, base: string = PECK_WORLD): string | null {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) return null
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return `${trimSlashes(base)}/?tx=${txid.toLowerCase()}&at=${degrees(lat)},${degrees(lng)}`
}
