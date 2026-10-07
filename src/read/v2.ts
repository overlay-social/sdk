/**
 * Typed client for the overlay's /v2 read model: the peck-view/v1 contract.
 *
 * /v2 hands out views that are already hydrated on the overlay (author, counts,
 * media, one level of referenced post, a parent stub), so a screen needs one
 * call instead of a feed request plus enrichment. Every view is
 * viewer-independent and cacheable by URL; the only per-viewer read is
 * `viewerState()`.
 *
 * Error model (unlike the /v1 client, nothing here is best-effort):
 *  - A non-2xx response throws a `ReadError` whose `code` is the contract's
 *    `ErrorResponse.error.code` (bad_request, not_found, timeout, internal).
 *  - No response at all throws a `ReadError` with `status` 0 and code
 *    `network`, or `timeout` when the client's own timeout fired.
 *  - A 2xx body that is not the expected view throws code `invalid_response`.
 *  - Aborting through the caller's `signal` rejects with the signal's reason
 *    unchanged (an AbortError by default), exactly like `fetch`.
 */
import type {
  AppList,
  AuthorList,
  ChannelList,
  ErrorResponse,
  FeedCursor,
  FeedPage,
  IdentityList,
  LensList,
  MessagePage,
  PostBatch,
  ProfileView,
  Reaction,
  ReactionPage,
  SiteStats,
  ThreadView,
  ViewerState,
} from './peck-view/types.js'

/** The contract version this client speaks. */
export const PECK_VIEW_CONTRACT = 'peck-view/v1'
/** Most txids `POST /v2/posts` accepts in one call; `posts()` chunks larger inputs. */
export const MAX_POSTS_PER_REQUEST = 100
/** Most txids and most authors `POST /v2/viewer/state` accepts in one call; `viewerState()` chunks larger inputs. */
export const MAX_VIEWER_ITEMS_PER_REQUEST = 200

const DEFAULT_BASE_URL = 'https://overlay.peck.to'
const DEFAULT_TIMEOUT_MS = 10_000
/** Chunked calls run at most this many requests at once. */
const CHUNK_CONCURRENCY = 4
const TXID_RE = /^[0-9a-f]{64}$/
const IDENTITY_KEY_RE = /^0[23][0-9a-fA-F]{64}$/

// ── Errors ──────────────────────────────────────────────────────

/**
 * Why a read failed. The first four come from the overlay (`ErrorResponse`);
 * the rest are raised by the client. The overlay may add codes, so treat
 * unknown values like `internal`.
 */
export type ReadErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'timeout'
  | 'internal'
  | 'network'
  | 'invalid_response'
  | (string & {})

export class ReadError extends Error {
  override readonly name = 'ReadError'
  /** Machine-readable reason; stable. */
  readonly code: ReadErrorCode
  /** HTTP status of the response, or 0 when there was no response. */
  readonly status: number
  /** The request path, e.g. `/v2/post/<txid>`. */
  readonly path: string

  constructor(code: ReadErrorCode, status: number, path: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
    this.status = status
    this.path = path
  }
}

export function isReadError(e: unknown): e is ReadError {
  return e instanceof ReadError
}

function codeForStatus(status: number): ReadErrorCode {
  if (status === 400) return 'bad_request'
  if (status === 404) return 'not_found'
  if (status === 408 || status === 503 || status === 504) return 'timeout'
  return 'internal'
}

function isErrorResponse(body: unknown): body is ErrorResponse {
  const e = (body as ErrorResponse | null)?.error
  return !!e && typeof e === 'object' && typeof e.code === 'string'
}

// ── Queries ─────────────────────────────────────────────────────

/** A point in time: a Date, an ISO 8601 string, or unix seconds. */
export type TimeInput = Date | string | number

/** Feed ordering. `top` and `discussed` cover the last 7 days unless `since` is set. */
export type FeedRank = 'latest' | 'top' | 'discussed'

/**
 * A rectangle on the map, **latitude first**: `minLat`, `minLng`, `maxLat`,
 * `maxLng` (the order the overlay reads). `minLng` greater than `maxLng` means
 * the box crosses the antimeridian (`minLng: 170, maxLng: -170`).
 */
export interface GeoBox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

/** Everything within `radiusKm` of a point, measured along the great circle. */
export interface GeoNear {
  lat: number
  lng: number
  /** Greater than 0; at most half the Earth's circumference (about 20 016 km). */
  radiusKm: number
}

/** Filters for `feed()`. Every field is optional; the overlay's operator filter always applies. */
export interface FeedQuery {
  /** Page size, 1–100. Overlay default: 20. */
  limit?: number
  /** Overlay default: `latest`. */
  rank?: FeedRank
  /** `asc` is only valid with rank `latest`. Overlay default: `desc`. */
  order?: 'desc' | 'asc'
  /** One app, or several (any of them). */
  app?: string | string[]
  /** Leave out posts from these apps. */
  excludeApps?: string[]
  /** One MAP type (post, reply, repost, …) or several. */
  type?: string | string[]
  /** One content kind (e.g. longform) or several. */
  kind?: string | string[]
  /** Exact tag match. */
  tag?: string
  channel?: string
  /** One signing key, or up to 20 (e.g. every key of a `ProfileView`). */
  author?: string | string[]
  /** Exact display name written in the transaction. */
  displayName?: string
  /** Inclusive lower bound on the post time. */
  since?: TimeInput
  /** Exclusive upper bound on the post time. */
  until?: TimeInput
  /** Minimum body length in characters. */
  minLength?: number
  /** Only authors this viewer key follows. */
  following?: string
  /** Leave out authors this viewer key has blocked. */
  hideBlockedBy?: string
  /** With `hideBlockedBy`: false also leaves out muted authors. Overlay default: true. */
  includeMuted?: boolean
  /** Lens ids to apply. */
  lens?: string[]
  /**
   * Only posts with a location (`PostView.geo` is set). `bbox` and `near` imply
   * it. A location filter combines with every other filter, every rank and
   * paging.
   */
  hasGeo?: boolean
  /** Only posts inside this box. Given together with `near`, both apply. */
  bbox?: GeoBox
  /** Only posts within this distance of a point. Given together with `bbox`, both apply. */
  near?: GeoNear
  /**
   * Continue after a previous page: pass that page's `next` unchanged, with the
   * same filters. Null or absent starts at the top.
   */
  cursor?: FeedCursor | null
}

/** Query for `search()`. The overlay returns one page of best matches (`next` is always null). */
export interface SearchQuery {
  /** Search text; needs at least one positive term. */
  q: string
  /** 1–100. Overlay default: 20. */
  limit?: number
  app?: string | string[]
  excludeApps?: string[]
  type?: string | string[]
  /** Substring match on the tags (the search index's semantics, not the feed's exact match). */
  tag?: string
}

export interface ViewerStateQuery {
  /** The viewer: a P2PKH address or a compressed public key. */
  viewer: string
  /** Posts to report liked/reposted for. */
  txids?: string[]
  /** Author keys to report following/blocked/muted for. */
  authors?: string[]
}

/** Which reactions `reactions()` lists. */
export type ReactionKind = Reaction['kind']

export interface ReactionsQuery {
  /** `like` lists likes, `repost` lists the posts that repost it. Overlay default: `like`. */
  kind?: ReactionKind
  /** 1–100. Overlay default: 50. */
  limit?: number
  /**
   * Continue after a previous page: pass that page's `next` unchanged, with the
   * same txid and `kind`. Null or absent starts at the newest.
   */
  cursor?: FeedCursor | null
}

/** Query for `apps()`. */
export interface AppsQuery {
  /**
   * Count only these MAP types. Overlay default: the content types (post,
   * reply, repost), which leaves out likes and follows.
   */
  type?: string | string[]
}

/** Query for `channels()`. */
export interface ChannelsQuery {
  /** The most entries in each of the two lists, 1–100. Overlay default: 50. */
  limit?: number
}

/** Query for `identities()`. */
export interface IdentitiesQuery {
  /** 1–100. Overlay default: 20. */
  limit?: number
}

/** Query for `lenses()`. */
export interface LensesQuery {
  /** Only lenses this identity key published (66-hex compressed public key). */
  issuer?: string
  /** Only lenses with this scope, exactly (for example `curated`). */
  scope?: string
  /** 1–100. Overlay default: 50. */
  limit?: number
}

/**
 * Query for `messages()`. Name what to read: a room (`channel`, or `scope:
 * 'global'` for the global chat) or private messages (`recipient`, or `author`
 * alone). A request that names none of them is rejected: the overlay also holds
 * direct messages, so there is no unfiltered list.
 */
export interface MessagesQuery {
  /** One channel's chat, matched exactly (case-sensitive). `'global'` is the global chat. */
  channel?: string
  /** `'global'`: the global ("Everyone") chat: messages without a channel, and the legacy room `global`. */
  scope?: 'global'
  /**
   * The inbox: private messages addressed to this identity key (a 66-hex public
   * key is matched in either case). Never combined with `channel` or `scope`.
   */
  recipient?: string
  /**
   * With a room: that sender's messages in it. With `recipient`: one direction of
   * a conversation. Alone: the sender's private messages (their outbox). The
   * sender is the signing key, which for a peck.to direct message is the
   * address of the AIP key, not the identity key.
   */
  author?: string
  /** 1–100. Overlay default: 50. */
  limit?: number
  /**
   * `desc` (overlay default): newest first, paged toward older messages with
   * `before_*` cursors. `asc`: oldest first, paged toward newer messages with
   * `after_*` cursors.
   */
  order?: 'desc' | 'asc'
  /**
   * Continue after a previous page: pass that page's `next` unchanged, with the
   * same filters and `order`. Null or absent starts at the newest (`desc`) or
   * oldest (`asc`) message. With `order: 'asc'`, a cursor built from the newest
   * message you hold (`{ after_ts: m.createdAt, after_txid: m.txid }`) asks for
   * what arrived since.
   */
  cursor?: FeedCursor | null
}

/** Query for `authors()`: "Across Bitcoin", the people other apps' posts came from. */
export interface AuthorsQuery {
  /** Only this app's posts (`twetch`, `treechat`, …). An app with no posts is an empty list. */
  app?: string
  /**
   * `author` (overlay default): one row per signing key; without `app`, a key's
   * posts are summed over every app. `name`: needs `app`; for an app whose users
   * all post through one shared key (treechat), one row per display name.
   */
  by?: 'author' | 'name'
  /** 1–100. Overlay default: 50. */
  limit?: number
  /** Continue after a previous page: pass that page's `next` unchanged, with the same filters. */
  cursor?: FeedCursor | null
}

/** Per-call options. */
export interface ReadRequestOptions {
  /** Aborts the request (and every chunk of a chunked call). */
  signal?: AbortSignal
}

export interface ReadClientOptions {
  /** Overlay base URL. Default `https://overlay.peck.to`. */
  baseUrl?: string
  /** Per-request timeout in ms; 0 disables it. Default 10000. */
  timeoutMs?: number
  /** Inject a fetch implementation (tests, SSR, edge). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Extra headers sent with every request. */
  headers?: Record<string, string>
}

type Params = Record<string, string | undefined>

function csv(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  const list = (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean)
  return list.length ? list.join(',') : undefined
}

function time(v: TimeInput | undefined): string | undefined {
  if (v === undefined) return undefined
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** `app` as one value or several: the wire has `app` for one and `app_in` for a list. */
function appParams(app: string | string[] | undefined): Params {
  if (Array.isArray(app) && app.length > 1) return { app_in: csv(app) }
  return { app: csv(app) }
}

function manyParams(one: string, many: string, v: string | string[] | undefined): Params {
  if (Array.isArray(v) && v.length > 1) return { [many]: csv(v) }
  return { [one]: csv(v) }
}

/** `bbox=minLat,minLng,maxLat,maxLng`: latitude first, unlike GeoJSON's [west, south, east, north]. */
function bboxParam(b: GeoBox | undefined): string | undefined {
  return b ? [b.minLat, b.minLng, b.maxLat, b.maxLng].join(',') : undefined
}

/** `near=lat,lng,radiusKm`. */
function nearParam(n: GeoNear | undefined): string | undefined {
  return n ? [n.lat, n.lng, n.radiusKm].join(',') : undefined
}

/** The query string for `GET /v2/feed`. Exported for tests and for callers that build their own URLs. */
export function feedSearchParams(query: FeedQuery = {}): URLSearchParams {
  const p: Params = {
    limit: query.limit === undefined ? undefined : String(query.limit),
    rank: query.rank,
    order: query.order,
    ...appParams(query.app),
    app_not_in: csv(query.excludeApps),
    ...manyParams('type', 'types', query.type),
    ...manyParams('kind', 'kinds', query.kind),
    tag: query.tag,
    channel: query.channel,
    author: csv(query.author),
    display_name: query.displayName,
    since: time(query.since),
    until: time(query.until),
    min_length: query.minLength === undefined ? undefined : String(query.minLength),
    following: query.following,
    hide_blocked_by: query.hideBlockedBy,
    include_muted: query.includeMuted === false ? '0' : undefined,
    lens: csv(query.lens),
    has_geo: query.hasGeo === true ? '1' : undefined,
    bbox: bboxParam(query.bbox),
    near: nearParam(query.near),
  }
  const qs = toSearchParams(p)
  // The cursor's keys follow the rank's sort columns; send them back as given.
  for (const [k, v] of Object.entries(query.cursor ?? {})) qs.set(k, String(v))
  return qs
}

/** The query string for `GET /v2/search`. */
export function searchSearchParams(query: SearchQuery): URLSearchParams {
  return toSearchParams({
    q: query.q,
    limit: query.limit === undefined ? undefined : String(query.limit),
    ...appParams(query.app),
    app_not_in: csv(query.excludeApps),
    ...manyParams('type', 'types', query.type),
    tag: query.tag,
  })
}

/** The query string for `GET /v2/post/:txid/reactions`. */
export function reactionsSearchParams(query: ReactionsQuery = {}): URLSearchParams {
  const qs = toSearchParams({
    kind: query.kind,
    limit: query.limit === undefined ? undefined : String(query.limit),
  })
  // The cursor's keys follow the kind (before_actor for likes, before_txid for reposts).
  for (const [k, v] of Object.entries(query.cursor ?? {})) qs.set(k, String(v))
  return qs
}

/** The query string for `GET /v2/apps`. */
export function appsSearchParams(query: AppsQuery = {}): URLSearchParams {
  return toSearchParams(manyParams('type', 'types', query.type))
}

const limitParam = (limit: number | undefined): string | undefined => (limit === undefined ? undefined : String(limit))

/** The query string for `GET /v2/channels`. */
export function channelsSearchParams(query: ChannelsQuery = {}): URLSearchParams {
  return toSearchParams({ limit: limitParam(query.limit) })
}

/** The query string for `GET /v2/identities`. */
export function identitiesSearchParams(query: IdentitiesQuery = {}): URLSearchParams {
  return toSearchParams({ limit: limitParam(query.limit) })
}

/** The query string for `GET /v2/lenses`. */
export function lensesSearchParams(query: LensesQuery = {}): URLSearchParams {
  return toSearchParams({
    issuer: query.issuer?.trim().toLowerCase(),
    scope: query.scope?.trim(),
    limit: limitParam(query.limit),
  })
}

/** The query string for `GET /v2/messages`. */
export function messagesSearchParams(query: MessagesQuery): URLSearchParams {
  const qs = toSearchParams({
    channel: query.channel?.trim(),
    scope: query.scope,
    recipient: query.recipient?.trim(),
    author: query.author?.trim(),
    limit: limitParam(query.limit),
    order: query.order,
  })
  // The cursor's keys follow the direction (before_ts + before_txid, or after_ts + after_txid); send them back as given.
  for (const [k, v] of Object.entries(query.cursor ?? {})) qs.set(k, String(v))
  return qs
}

/** The query string for `GET /v2/authors`. */
export function authorsSearchParams(query: AuthorsQuery = {}): URLSearchParams {
  const qs = toSearchParams({
    app: query.app?.trim(),
    by: query.by,
    limit: limitParam(query.limit),
  })
  // before_posts + before_key, sent back as given.
  for (const [k, v] of Object.entries(query.cursor ?? {})) qs.set(k, String(v))
  return qs
}

function toSearchParams(p: Params): URLSearchParams {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') qs.set(k, v)
  return qs
}

// ── Response shape checks ───────────────────────────────────────
// Light guards against a body that is not a view at all (a proxy's HTML error
// page, a /v1 row). Full validation against the schema lives in the tests.

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const isFeedPage = (b: unknown): b is FeedPage =>
  isObject(b) && Array.isArray(b.items) && (b.next === null || isObject(b.next))
const isThreadView = (b: unknown): b is ThreadView =>
  isObject(b) && isObject(b.post) && Array.isArray(b.replies)
const isProfileView = (b: unknown): b is ProfileView =>
  isObject(b) && isObject(b.author) && Array.isArray(b.keys)
const isPostBatch = (b: unknown): b is PostBatch =>
  isObject(b) && Array.isArray(b.posts) && Array.isArray(b.missing)
const isViewerState = (b: unknown): b is ViewerState =>
  isObject(b) && isObject(b.posts) && isObject(b.authors) && Array.isArray(b.keys)
const isReactionPage = (b: unknown): b is ReactionPage =>
  isObject(b) && Array.isArray(b.items) && (b.next === null || isObject(b.next))
const isAppList = (b: unknown): b is AppList => isObject(b) && Array.isArray(b.apps)
const isSiteStats = (b: unknown): b is SiteStats =>
  isObject(b) && typeof b.posts === 'number' && typeof b.accounts === 'number'
const isChannelList = (b: unknown): b is ChannelList =>
  isObject(b) && Array.isArray(b.posting) && Array.isArray(b.rooms)
const isIdentityList = (b: unknown): b is IdentityList =>
  isObject(b) && Array.isArray(b.items) && typeof b.total === 'number'
const isLensList = (b: unknown): b is LensList => isObject(b) && Array.isArray(b.items)
const isMessagePage = (b: unknown): b is MessagePage =>
  isObject(b) && Array.isArray(b.items) && (b.next === null || isObject(b.next))
const isAuthorList = (b: unknown): b is AuthorList =>
  isObject(b) && Array.isArray(b.items) && typeof b.total === 'number' && typeof b.capped === 'boolean'

// ── Helpers ─────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function uniqueTxids(path: string, txids: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of txids) {
    const t = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!TXID_RE.test(t)) throw new ReadError('bad_request', 0, path, `not a txid: ${JSON.stringify(raw).slice(0, 80)}`)
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)))
}

// ── Client ──────────────────────────────────────────────────────

export class ReadClient {
  readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly headers: Record<string, string>

  constructor(opts: ReadClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const f = opts.fetch ?? globalThis.fetch
    if (typeof f !== 'function') {
      throw new Error('@overlay-social/sdk: no global fetch; pass options.fetch')
    }
    this.fetchImpl = f.bind(globalThis)
    this.headers = { ...(opts.headers ?? {}) }
  }

  /** `GET /v2/feed`: one page of hydrated posts. Page on with `query.cursor = page.next`. */
  feed(query: FeedQuery = {}, opts?: ReadRequestOptions): Promise<FeedPage> {
    const qs = feedSearchParams(query).toString()
    return this.request('GET', `/v2/feed${qs ? `?${qs}` : ''}`, undefined, isFeedPage, opts)
  }

  /**
   * `GET /v2/post/:txid`: the post (long text form), its parent and every
   * descendant reply in one response. Throws `not_found` when the post is not
   * indexed.
   */
  post(txid: string, opts?: ReadRequestOptions): Promise<ThreadView> {
    const t = typeof txid === 'string' ? txid.trim() : ''
    if (!t) return Promise.reject(new ReadError('bad_request', 0, '/v2/post', 'txid is required'))
    return this.request('GET', `/v2/post/${encodeURIComponent(t)}`, undefined, isThreadView, opts)
  }

  /**
   * `GET /v2/profile/:key`: a profile header by address, public key or handle
   * (`@ada` or `ada`). Its posts: `feed({ author: profile.keys.slice(0, 20) })`.
   * Throws `not_found` for an unknown key or an unclaimed handle.
   */
  profile(keyOrHandle: string, opts?: ReadRequestOptions): Promise<ProfileView> {
    const k = typeof keyOrHandle === 'string' ? keyOrHandle.trim() : ''
    if (!k) return Promise.reject(new ReadError('bad_request', 0, '/v2/profile', 'key or handle is required'))
    return this.request('GET', `/v2/profile/${encodeURIComponent(k)}`, undefined, isProfileView, opts)
  }

  /**
   * `POST /v2/posts`: many posts by txid. Inputs are de-duplicated and sent in
   * chunks of at most 100; the result keeps request order, and `missing` lists
   * txids that are not indexed. No request is made for an empty list.
   */
  async posts(txids: readonly string[], opts?: ReadRequestOptions): Promise<PostBatch> {
    const unique = uniqueTxids('/v2/posts', txids)
    if (unique.length === 0) return { posts: [], missing: [] }
    const batches = await mapLimit(chunk(unique, MAX_POSTS_PER_REQUEST), CHUNK_CONCURRENCY, (part) =>
      this.request('POST', '/v2/posts', { txids: part }, isPostBatch, opts),
    )
    return {
      posts: batches.flatMap((b) => b.posts),
      missing: batches.flatMap((b) => b.missing),
    }
  }

  /**
   * `POST /v2/viewer/state`: what one viewer has done to these posts and how
   * they relate to these authors. Never cached by the overlay. Inputs over 200
   * txids or 200 authors are sent in chunks and merged.
   */
  async viewerState(query: ViewerStateQuery, opts?: ReadRequestOptions): Promise<ViewerState> {
    const path = '/v2/viewer/state'
    const viewer = typeof query.viewer === 'string' ? query.viewer.trim() : ''
    if (!viewer) throw new ReadError('bad_request', 0, path, 'viewer is required')
    const txids = uniqueTxids(path, query.txids ?? [])
    const authors = uniqueStrings(query.authors ?? [])
    const txidChunks = chunk(txids, MAX_VIEWER_ITEMS_PER_REQUEST)
    const authorChunks = chunk(authors, MAX_VIEWER_ITEMS_PER_REQUEST)
    const n = Math.max(1, txidChunks.length, authorChunks.length)
    const bodies = Array.from({ length: n }, (_, i) => ({
      viewer,
      txids: txidChunks[i] ?? [],
      authors: authorChunks[i] ?? [],
    }))
    const parts = await mapLimit(bodies, CHUNK_CONCURRENCY, (body) =>
      this.request('POST', path, body, isViewerState, opts),
    )
    const [first] = parts as [ViewerState, ...ViewerState[]]
    if (parts.length === 1) return first
    return {
      viewer: first.viewer,
      keys: first.keys,
      posts: Object.assign({}, ...parts.map((p) => p.posts)),
      authors: Object.assign({}, ...parts.map((p) => p.authors)),
    }
  }

  /** `GET /v2/search`: one page of best matches, hydrated. `next` is always null. */
  search(query: SearchQuery | string, opts?: ReadRequestOptions): Promise<FeedPage> {
    const q = typeof query === 'string' ? { q: query } : query
    if (!q.q || !q.q.trim()) return Promise.reject(new ReadError('bad_request', 0, '/v2/search', 'q is required'))
    return this.request('GET', `/v2/search?${searchSearchParams(q).toString()}`, undefined, isFeedPage, opts)
  }

  /**
   * `GET /v2/post/:txid/reactions`: who liked (or, with `kind: 'repost'`,
   * reposted) a post, newest first, a page at a time. Page on with
   * `query.cursor = page.next`. A txid the overlay has not indexed is an empty
   * page, not `not_found`. Quotes carry their own text and are posts, so they
   * are not listed here.
   */
  reactions(txid: string, query: ReactionsQuery = {}, opts?: ReadRequestOptions): Promise<ReactionPage> {
    const t = typeof txid === 'string' ? txid.trim().toLowerCase() : ''
    if (!TXID_RE.test(t)) {
      return Promise.reject(new ReadError('bad_request', 0, '/v2/post/reactions', `not a txid: ${JSON.stringify(txid).slice(0, 80)}`))
    }
    const qs = reactionsSearchParams(query).toString()
    return this.request('GET', `/v2/post/${t}/reactions${qs ? `?${qs}` : ''}`, undefined, isReactionPage, opts)
  }

  /**
   * `GET /v2/apps`: the apps that have written posts, most posts first, for an
   * app filter row. Counts are refreshed in the background (see `asOf`).
   */
  apps(query: AppsQuery = {}, opts?: ReadRequestOptions): Promise<AppList> {
    const qs = appsSearchParams(query).toString()
    return this.request('GET', `/v2/apps${qs ? `?${qs}` : ''}`, undefined, isAppList, opts)
  }

  /**
   * `GET /v2/stats`: the site totals a sidebar shows. Both numbers are the
   * database's row estimates, not counts (`estimated` is always true): render
   * them rounded.
   */
  stats(opts?: ReadRequestOptions): Promise<SiteStats> {
    return this.request('GET', '/v2/stats', undefined, isSiteStats, opts)
  }

  /**
   * `GET /v2/channels`: the channels people write in, for a channel picker or
   * a sidebar. `posting` ranks channels by posts written in them since
   * `postingSince` (currently 30 days); `rooms` ranks chat rooms by their
   * latest message. Direct messages are never counted. Pass a name to
   * `feed({ channel })`.
   */
  channels(query: ChannelsQuery = {}, opts?: ReadRequestOptions): Promise<ChannelList> {
    const qs = channelsSearchParams(query).toString()
    return this.request('GET', `/v2/channels${qs ? `?${qs}` : ''}`, undefined, isChannelList, opts)
  }

  /**
   * `GET /v2/identities`: who is on peck, newest first, each baked like a
   * post author (`AuthorView`). `total` counts every listed identity, not
   * this page.
   */
  identities(query: IdentitiesQuery = {}, opts?: ReadRequestOptions): Promise<IdentityList> {
    const qs = identitiesSearchParams(query).toString()
    return this.request('GET', `/v2/identities${qs ? `?${qs}` : ''}`, undefined, isIdentityList, opts)
  }

  /**
   * `GET /v2/lenses`: the published moderation lenses, newest first, for a
   * lens picker. Apply one with `feed({ lens: [lens.lensId] })`. A malformed
   * `issuer` is rejected here without a request.
   */
  lenses(query: LensesQuery = {}, opts?: ReadRequestOptions): Promise<LensList> {
    const issuer = query.issuer?.trim()
    if (issuer !== undefined && issuer !== '' && !IDENTITY_KEY_RE.test(issuer)) {
      return Promise.reject(new ReadError('bad_request', 0, '/v2/lenses', 'issuer must be a 66-hex compressed public key'))
    }
    const qs = lensesSearchParams(query).toString()
    return this.request('GET', `/v2/lenses${qs ? `?${qs}` : ''}`, undefined, isLensList, opts)
  }

  /**
   * `GET /v2/messages`: chat history, a page at a time. Name what to read: a
   * room (`channel`, or `scope: 'global'` for the global chat) or private
   * messages (`recipient` for an inbox; `author` alone for an outbox). A query
   * that names none of them is rejected here without a request.
   *
   * The first page is the newest messages, newest first: render them
   * oldest-first by reversing `items`, and load older ones with
   * `{ cursor: page.next }` (`next` is null exactly when nothing older is
   * left). To ask what arrived since, pass `order: 'asc'` with a cursor built
   * from the newest message you hold (see `MessagesQuery.cursor`).
   *
   * A direct message's `text` is whatever its sender wrote, normally an
   * encrypted envelope: open it with `@overlay-social/sdk/dm`. Authors are
   * baked like post authors. Paywalled channel messages come back with
   * `text: null` and `paywalled: true`.
   */
  messages(query: MessagesQuery, opts?: ReadRequestOptions): Promise<MessagePage> {
    const named = [query.channel, query.scope, query.recipient, query.author].some((v) => typeof v === 'string' && v.trim() !== '')
    if (!named) {
      return Promise.reject(new ReadError('bad_request', 0, '/v2/messages', 'name what to read: channel, scope: "global", recipient or author'))
    }
    return this.request('GET', `/v2/messages?${messagesSearchParams(query).toString()}`, undefined, isMessagePage, opts)
  }

  /**
   * `GET /v2/authors`: "Across Bitcoin", the authors whose public posts the
   * overlay indexes from other apps (twetch, treechat, …), whether or not they
   * claimed a peck identity, most posts first. Each row is an `AuthorView`
   * with its post count. A shared custodial key (treechat's relay) is one row
   * with `author.custodialRelay` set, the app rather than a person; list the
   * people behind it with `{ app: 'treechat', by: 'name' }`. The ranking is a
   * snapshot (`asOf`), at most 5000 rows (`total`, `capped`). Page on with
   * `query.cursor = page.next`. Right after the overlay starts the first
   * snapshot may still be loading: that is a `ReadError` with code `timeout`
   * and status 503; retry in a few seconds.
   */
  authors(query: AuthorsQuery = {}, opts?: ReadRequestOptions): Promise<AuthorList> {
    if (query.by === 'name' && !(query.app && query.app.trim())) {
      return Promise.reject(new ReadError('bad_request', 0, '/v2/authors', 'by: "name" needs an app'))
    }
    const qs = authorsSearchParams(query).toString()
    return this.request('GET', `/v2/authors${qs ? `?${qs}` : ''}`, undefined, isAuthorList, opts)
  }

  // -- transport ---------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    isExpected: (b: unknown) => b is T,
    opts?: ReadRequestOptions,
  ): Promise<T> {
    const outer = opts?.signal
    if (outer?.aborted) throw outer.reason
    const ctrl = new AbortController()
    let timedOut = false
    const onAbort = () => ctrl.abort(outer?.reason)
    outer?.addEventListener('abort', onAbort, { once: true })
    const timer = this.timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, this.timeoutMs)
      : undefined

    const fail = (e: unknown): never => {
      if (outer?.aborted) throw outer.reason
      if (timedOut) throw new ReadError('timeout', 0, path, `no response from ${path} within ${this.timeoutMs} ms`, { cause: e })
      throw new ReadError('network', 0, path, `request to ${path} failed: ${(e as Error)?.message ?? e}`, { cause: e })
    }

    try {
      let res: Response
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...this.headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        })
      } catch (e) {
        return fail(e)
      }

      let text: string
      try {
        text = await res.text()
      } catch (e) {
        return fail(e)
      }
      let parsed: unknown = undefined
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = undefined
      }

      if (!res.ok) {
        if (isErrorResponse(parsed)) {
          throw new ReadError(parsed.error.code, res.status, path, parsed.error.message || parsed.error.code)
        }
        throw new ReadError(codeForStatus(res.status), res.status, path, `overlay ${res.status} on ${path}`)
      }
      if (!isExpected(parsed)) {
        throw new ReadError('invalid_response', res.status, path, `unexpected response body from ${path}`)
      }
      return parsed
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }
}

/** Create a /v2 read client. Recommended over `createOverlayClient()` (the /v1 facade) for new code. */
export function createReadClient(opts: ReadClientOptions = {}): ReadClient {
  return new ReadClient(opts)
}
