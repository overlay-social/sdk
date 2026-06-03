/**
 * @overlay-social/sdk — read-only client for overlay.peck.to.
 *
 * This is a PURE READ LENS over the canonical peck social overlay. It does NOT
 * write, mint, pay, or federate — none of those exist on the live service. It
 * speaks the REST facade that actually runs today (verified against
 * overlay.peck.to), NOT the BRC-24 `peck-schema` lookup (that lookup() is a no-op).
 *
 * Philosophy (mirrors peck-web/overlay_client.py + peck-press/src/overlay.ts):
 *  - identity enrichment is BEST-EFFORT: resolveIdentities returns {} on any
 *    error and silently omits keys without a canonical ProfileToken, so a feed
 *    UI can overwrite displayName/avatar/handle defensively and NEVER break.
 *  - single-item lookups return `null` for missing/invalid (404/400/empty).
 *  - only getFeed/getState/getPost-by-existence throw on genuine 5xx/network.
 *  - every request has a hard timeout; overlay is load-bearing for other apps.
 */

export const DEFAULT_OVERLAY_URL = 'https://overlay.peck.to'
const DEFAULT_TIMEOUT_MS = 8000
const MAX_RESOLVE_KEYS = 200

// ── Identity types ──────────────────────────────────────────────

/**
 * One entry from POST /v1/identities/resolve. Keyed in the response by the
 * EXACT input string (address-input -> address key, pubkey-input -> pubkey key).
 * `avatarRef` is the raw on-chain ref, e.g. "uhrp://<sha256>".
 */
export interface ResolvedIdentity {
  pubkey: string
  address: string
  handle: string | null
  displayName: string | null
  avatarRef: string | null
  profileOutpoint: string | null
}

export interface ResolveIdentitiesResponse {
  status: string
  count: number
  identities: Record<string, ResolvedIdentity>
}

/**
 * Full bundle from GET /identity/:pubkey. NOTE the contract divergence: this
 * route exposes a RESOLVED `avatarUrl` (https), whereas resolveIdentities and
 * getProfile expose the raw `avatarRef` (uhrp://). Both are typed verbatim;
 * the SDK does not silently normalize a real contract difference.
 */
export interface IdentityBundle {
  pubkey: string
  profile: {
    outpoint: string
    version: number
    displayName: string | null
    bio: string | null
    avatarUrl: string | null
  } | null
  handles: string[]
  certs: unknown[]
  asOf: { blockHeight: number | null; source: string } | null
}

/** GET /resolve/:handle */
export interface HandleResolution {
  handle: string
  pubkey: string
  deepLinks: {
    profile?: string
    social?: string
    identity?: string
    [k: string]: string | undefined
  }
}

/** The `state` blob inside a GET /v1/bio/profile result row. */
export interface ProfileState {
  subject: string
  version: number
  displayName: string | null
  bio: string | null
  avatarRef: string | null
  certRefs: string[]
  handle: string | null
  nickname: string | null
}

/** One canonical ProfileToken row from GET /v1/bio/profile. */
export interface ProfileRow {
  outpoint: string
  txid: string
  vout: number
  subject: string
  owner: string
  version: number
  state: ProfileState
  minted_at: number | null
  updated_at: number | null
  canonical: boolean
  spent: boolean
}

// ── Feed / post types ───────────────────────────────────────────
// A `pecks` row as returned by /v1/feed and /v1/post/:txid. Only the fields we
// lean on are typed strongly; the indexer rides extra MAP keys, so it's open.
export interface PeckRow {
  txid: string
  type: string
  kind?: string | null
  content: string
  map_content?: string | null
  media_type?: string | null
  app?: string | null
  author?: string | null
  display_name?: string | null
  channel?: string | null
  parent_txid?: string | null
  ref_txid?: string | null
  tags?: string | null
  aip_verified?: boolean
  thread_root_tx?: string | null
  token_ref?: string | null
  token_type?: string | null
  timestamp?: number | string | null
  block_height?: number | null
  media_url?: string | null
  reply_count?: number
  like_count?: number
  has_access?: boolean
  content_truncated?: boolean
  content_size?: number
  [k: string]: unknown
}

export interface FeedResponse {
  status: string
  total: number
  offset: number
  limit: number
  count: number
  data: PeckRow[]
}

export interface FeedParams {
  limit?: number
  offset?: number
  app?: string
  tag?: string
  type?: string
  types?: string // CSV; takes precedence over `type` server-side
  author?: string
  order?: 'asc' | 'desc'
  before?: string // keyset cursor: ISO8601 | unix seconds
}

export interface ThreadResponse {
  post: PeckRow | null
  replies: PeckRow[]
}

// ── Overlay state types ─────────────────────────────────────────
/**
 * On-chain anchor for a topic's state-root (when present in /state). The
 * overlay periodically publishes each topic's root as a chained 1Sat
 * anchor-token; this is the latest one. `matchesLive` is true when the
 * currently-served stateRoot equals the anchored root (i.e. current state is
 * on-chain). Absent/null until anchoring is enabled. */
export interface TopicAnchor {
  root: string
  txid: string
  vout: number
  outpoint: string
  blockHeight: number | null
  ts: number | null
  anchoredAt: string | null
  matchesLive: boolean
}

export interface TopicState {
  topic: string
  count: number
  stateRoot: string
  source: string
  anchor?: TopicAnchor | null
}

export interface OverlayState {
  status: string
  service: string
  domain: string
  network: string
  managers: string[]
  topics: TopicState[]
  computedAt: string
}

// ── Client ──────────────────────────────────────────────────────

export interface OverlayClientOptions {
  /** Base URL, default https://overlay.peck.to */
  baseUrl?: string
  /** Per-request timeout in ms, default 8000. */
  timeoutMs?: number
  /** Inject a fetch impl (tests/SSR). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
}

export class OverlayClient {
  readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: OverlayClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OVERLAY_URL).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const f = opts.fetch ?? globalThis.fetch
    if (typeof f !== 'function') {
      throw new Error('@overlay-social/sdk: no global fetch — pass opts.fetch (Node <18).')
    }
    this.fetchImpl = f.bind(globalThis)
  }

  // -- low-level ---------------------------------------------------
  private async raw(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }

  /** GET JSON; throws on non-2xx. Use for endpoints where failure is real. */
  private async getJson<T>(path: string): Promise<T> {
    const r = await this.raw(path)
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`overlay ${r.status} on ${path}: ${body.slice(0, 200)}`)
    }
    return (await r.json()) as T
  }

  /** GET JSON but return null for 400/404/empty; throws only on 5xx/network. */
  private async getJsonOrNull<T>(path: string): Promise<T | null> {
    const r = await this.raw(path)
    if (r.status === 404 || r.status === 400) return null
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`overlay ${r.status} on ${path}: ${body.slice(0, 200)}`)
    }
    return ((await r.json()) as T) ?? null
  }

  // -- identity ----------------------------------------------------

  /**
   * Batch-resolve feed authors to canonical ProfileToken state.
   * POST /v1/identities/resolve. Feed authors are P2PKH base58 addresses
   * (pass as `addresses`); pubkey-hex subjects go in `pubkeys`. ONE round-trip
   * per feed page — never call per row.
   *
   * Returns the `identities` map keyed on the EXACT input string. Inputs
   * without a canonical+unspent ProfileToken are simply absent (ghost authors).
   * Returns {} on ANY error so the caller's feed never bricks on enrichment.
   */
  async resolveIdentities(input: {
    pubkeys?: string[]
    addresses?: string[]
  }): Promise<Record<string, ResolvedIdentity>> {
    const pubkeys = (input.pubkeys ?? []).filter(Boolean).slice(0, MAX_RESOLVE_KEYS)
    const addresses = (input.addresses ?? []).filter(Boolean).slice(0, MAX_RESOLVE_KEYS)
    if (pubkeys.length === 0 && addresses.length === 0) return {}
    const body: { pubkeys?: string[]; addresses?: string[] } = {}
    if (pubkeys.length) body.pubkeys = pubkeys
    if (addresses.length) body.addresses = addresses
    try {
      const r = await this.raw('/v1/identities/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) return {}
      const j = (await r.json()) as ResolveIdentitiesResponse
      return j?.identities ?? {}
    } catch {
      return {}
    }
  }

  /**
   * GET /identity/:pubkey — full identity bundle (profile + handles + certs).
   * `pubkey` must be 66-hex compressed; the overlay 400s otherwise -> null.
   * Returns null when no ProfileToken exists for the key.
   */
  async getIdentity(pubkey: string): Promise<IdentityBundle | null> {
    if (!pubkey) return null
    const j = await this.getJsonOrNull<IdentityBundle & { error?: string }>(
      `/identity/${encodeURIComponent(pubkey)}`,
    )
    if (!j || (j as { error?: string }).error || !j.pubkey) return null
    return j
  }

  /**
   * GET /resolve/:handle — handle -> {pubkey, deepLinks}. Case per registry.
   * Returns null when the handle has no HandleToken (overlay 404).
   */
  async resolveHandle(handle: string): Promise<HandleResolution | null> {
    if (!handle) return null
    const j = await this.getJsonOrNull<HandleResolution & { error?: string }>(
      `/resolve/${encodeURIComponent(handle)}`,
    )
    if (!j || (j as { error?: string }).error || !j.pubkey) return null
    return j
  }

  /**
   * GET /v1/bio/profile — canonical ProfileToken row for a subject (preferred),
   * owner, or outpoint. Returns the first canonical+unspent row (the overlay
   * already filters/sorts so results[0] is live) or null.
   */
  async getProfile(
    sel: { subject?: string; owner?: string; outpoint?: string },
  ): Promise<ProfileRow | null> {
    const qs = new URLSearchParams()
    if (sel.subject) qs.set('subject', sel.subject)
    else if (sel.owner) qs.set('owner', sel.owner)
    else if (sel.outpoint) qs.set('outpoint', sel.outpoint)
    else return null
    const j = await this.getJsonOrNull<{ results?: ProfileRow[]; error?: string }>(
      `/v1/bio/profile?${qs.toString()}`,
    )
    if (!j || j.error || !Array.isArray(j.results) || j.results.length === 0) return null
    return j.results[0] ?? null
  }

  // -- feed / posts ------------------------------------------------

  /** GET /v1/feed — list pecks. Throws on genuine upstream failure. */
  async getFeed(params: FeedParams = {}): Promise<FeedResponse> {
    const qs = new URLSearchParams()
    const put = (k: string, v: string | number | undefined) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    }
    put('limit', params.limit ?? 50)
    put('offset', params.offset)
    put('app', params.app)
    put('tag', params.tag)
    // `types` (CSV) takes precedence server-side; only send `type` without it.
    put('type', params.types ? undefined : params.type)
    put('types', params.types)
    put('author', params.author)
    put('order', params.order ?? 'desc')
    put('before', params.before)
    const j = await this.getJson<FeedResponse>(`/v1/feed?${qs.toString()}`)
    if (!j || j.status !== 'ok' || !Array.isArray(j.data)) {
      throw new Error('overlay feed: unexpected shape')
    }
    return j
  }

  /** GET /v1/post/:txid — single full post; null when not found. */
  async getPost(txid: string): Promise<PeckRow | null> {
    if (!txid) return null
    const j = await this.getJsonOrNull<{ status?: string; data?: PeckRow; error?: string }>(
      `/v1/post/${encodeURIComponent(txid)}`,
    )
    if (!j || j.error || j.status !== 'ok' || !j.data) return null
    return j.data
  }

  /** GET /v1/thread/:txid — post + replies. Returns {post,replies}. */
  async getThread(txid: string): Promise<ThreadResponse> {
    if (!txid) return { post: null, replies: [] }
    const j = await this.getJsonOrNull<{
      parent?: PeckRow
      post?: PeckRow
      data?: PeckRow
      replies?: PeckRow[]
    }>(`/v1/thread/${encodeURIComponent(txid)}`)
    if (!j) return { post: null, replies: [] }
    return { post: j.parent ?? j.post ?? j.data ?? null, replies: j.replies ?? [] }
  }

  // -- overlay state -----------------------------------------------

  /** GET /state — overlay topic state roots + counts. Throws on failure. */
  async getState(): Promise<OverlayState> {
    return this.getJson<OverlayState>('/state')
  }

  /**
   * Topic state root for a single topic. There is NO per-topic route on the
   * overlay, so this is a client-side find over getState(). Returns null when
   * the topic isn't tracked.
   */
  async getTopicRoot(topic: string): Promise<TopicState | null> {
    if (!topic) return null
    try {
      const s = await this.getState()
      return s.topics.find((t) => t.topic === topic) ?? null
    } catch {
      return null
    }
  }

  /**
   * Latest on-chain anchor for a topic's state-root, or null when nothing is
   * anchored yet (anchoring not enabled, or topic untracked). Client-side find
   * over getState().
   */
  async getAnchor(topic: string): Promise<TopicAnchor | null> {
    if (!topic) return null
    try {
      const s = await this.getState()
      return s.topics.find((t) => t.topic === topic)?.anchor ?? null
    } catch {
      return null
    }
  }

  /**
   * Verify the current state-root against the chain. Returns whether the topic
   * has any anchor, whether the live root matches the anchored root
   * (`matchesLive`), and the anchor txid for independent BEEF verification.
   * Does NOT itself fetch a Merkle proof — use `txid` against block headers
   * (BRC-62) for full proof.
   */
  async verifyRoot(topic: string): Promise<{
    anchored: boolean
    matchesLive: boolean
    liveRoot: string | null
    anchoredRoot: string | null
    txid: string | null
  }> {
    const empty = { anchored: false, matchesLive: false, liveRoot: null, anchoredRoot: null, txid: null }
    if (!topic) return empty
    try {
      const s = await this.getState()
      const t = s.topics.find((x) => x.topic === topic)
      if (!t) return empty
      const a = t.anchor ?? null
      return {
        anchored: !!a,
        matchesLive: !!a && a.matchesLive,
        liveRoot: t.stateRoot ?? null,
        anchoredRoot: a?.root ?? null,
        txid: a?.txid ?? null,
      }
    } catch {
      return empty
    }
  }
}

/** Convenience factory. */
export function createOverlayClient(opts: OverlayClientOptions = {}): OverlayClient {
  return new OverlayClient(opts)
}
