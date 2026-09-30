/**
 * Picture references to URLs. This is the one place a published `avatarRef`
 * becomes something an `<img src>` can load; the overlay applies exactly these
 * rules to every `AuthorView`.
 *
 *   uhrp://<sha256>        <uhrpBase>/uhrp/<sha256>
 *   b://<txid>             <mediaBase>/b/<txid>
 *                          <mediaBase>/xavatar/<txid> for an external profile (a downscaling proxy)
 *   ord://<txid>[_<vout>]  <mediaBase>/ord/<txid>[_<vout>]
 *   https://… http://…     unchanged; peck.to's own generated /avatar/ URLs count as "no picture"
 *   data:image/…           unchanged, up to 64 KiB
 *   anything else          null (a bare hash is ambiguous: a UHRP hash or an ordinal txid)
 *
 * An external profile (an off-chain platform profile) only ever yields `b://`
 * pictures: its other picture formats are dead links, so they map to null.
 *
 * No picture (`null`) is not an error. Peck clients then show the generated
 * bird ({@link generatedAvatarUrl}); other clients may show a monogram.
 */
import { resolveConfig, type IdentityConfig } from './config.js'

/** Which record a picture reference came from. */
export type AvatarOrigin = 'identity' | 'account' | 'external'

const UHRP_RE = /^uhrp:\/\/([0-9a-f]{64})$/i
const B_RE = /^b:\/\/\s*([0-9a-f]{64})\s*$/i
const ORD_RE = /^ord:\/\/([0-9a-f]{64}(?:_\d{1,6})?)$/i
const HTTP_RE = /^https?:\/\//i
const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+[;,]/i
/** Longest `data:image/…` reference accepted (the light profile's generated SVG is about 1.7 KB). */
export const MAX_DATA_URI = 64 * 1024

/** True for peck.to's (or a local dev host's) own generated-bird URL: it is not the author's picture. */
function isGeneratedAvatarUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const ours = host === 'peck.to' || host.endsWith('.peck.to') || host === 'localhost' || host === '127.0.0.1'
  return ours && url.pathname.startsWith('/avatar/')
}

/** The URL an `avatarRef` maps to, or `null` when it names no usable picture. */
export function avatarRefToUrl(
  ref: string | null | undefined,
  origin: AvatarOrigin,
  config?: Pick<IdentityConfig, 'mediaBase' | 'uhrpBase'>,
): string | null {
  if (typeof ref !== 'string') return null
  const r = ref.trim()
  if (!r) return null
  const cfg = resolveConfig(config)

  const b = B_RE.exec(r)
  if (b) {
    const txid = b[1]!.toLowerCase()
    return origin === 'external' ? `${cfg.mediaBase}/xavatar/${txid}` : `${cfg.mediaBase}/b/${txid}`
  }
  if (origin === 'external') return null

  const u = UHRP_RE.exec(r)
  if (u) return `${cfg.uhrpBase}/uhrp/${u[1]!.toLowerCase()}`

  const o = ORD_RE.exec(r)
  if (o) return `${cfg.mediaBase}/ord/${o[1]!.toLowerCase()}`

  if (HTTP_RE.test(r)) {
    if (/\s/.test(r)) return null
    let url: URL
    try {
      url = new URL(r)
    } catch {
      return null
    }
    return isGeneratedAvatarUrl(url) ? null : r
  }

  if (DATA_IMAGE_RE.test(r)) return r.length <= MAX_DATA_URI ? r : null

  return null
}

/**
 * The generated bird for a key. It is seeded on the P2PKH address, the one
 * form that is the same for a key everywhere, so a key has the same bird on
 * every surface. Pass `address` as `null` for a key that has none (the key
 * itself is then the seed).
 */
export function generatedAvatarUrl(
  key: string,
  address: string | null | undefined,
  config?: Pick<IdentityConfig, 'mediaBase'>,
): string {
  const { mediaBase } = resolveConfig(config)
  return `${mediaBase}/avatar/${encodeURIComponent(key)}?seed=${encodeURIComponent(address || key)}`
}
