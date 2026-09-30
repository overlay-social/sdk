/**
 * Message box host URLs: the rules the MessageBox client library applies, so
 * a host read from an overlay advertisement can never point the client at a
 * local or private address.
 */
import { DmError } from './errors.js'

const MAX_HOST_LENGTH = 2048

function isPrivateIpv4(hostname: string): boolean {
  const o = hostname.split('.').map(Number)
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false
  const [a, b, c] = o as [number, number, number, number]
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  return (
    h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || /^fe[89ab]/.test(h) ||
    h.startsWith('ff') || h.startsWith('2001:db8:') || h.startsWith('::ffff:')
  )
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') ||
    h.endsWith('.home') || h.endsWith('.internal') || h.endsWith('.test') || h.endsWith('.invalid') ||
    h === 'example.com' || h.endsWith('.example.com') || isPrivateIpv4(h) || isPrivateIpv6(h)
  )
}

/**
 * Canonical form of a configured host: an absolute http(s) URL without
 * credentials, query or fragment, and without a trailing slash. Throws a
 * `DmError` (`invalid_argument`) otherwise.
 */
export function normalizeHost(host: string): string {
  const bad = (why: string) => new DmError('invalid_argument', `message box host ${why}`)
  if (typeof host !== 'string') throw bad('must be a string')
  const candidate = host.trim()
  if (candidate === '' || candidate.length > MAX_HOST_LENGTH) throw bad('must be a non-empty URL of at most 2048 characters')
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw bad('must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw bad('must use HTTP or HTTPS')
  if (url.username !== '' || url.password !== '') throw bad('must not contain credentials')
  if (url.search !== '' || url.hash !== '') throw bad('must not contain a query or fragment')
  let path = url.pathname
  while (path.endsWith('/')) path = path.slice(0, -1)
  return path === '' ? url.origin : `${url.origin}${path}`
}

/**
 * A host taken from an overlay advertisement, or undefined when it must not
 * be used: advertised hosts must be https and must not name a local,
 * private or reserved address.
 */
export function normalizeAdvertisedHost(host: string): string | undefined {
  try {
    const normalized = normalizeHost(host)
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || isLocalHostname(url.hostname)) return undefined
    return normalized
  } catch {
    return undefined
  }
}

export function endpoint(host: string, path: string): string {
  return `${normalizeHost(host)}/${path.replace(/^\/+/, '')}`
}
