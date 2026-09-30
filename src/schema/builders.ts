/**
 * One builder per social action. Each returns an unsigned `SchemaPayload`
 * (B and MAP sections); `signPayload()` adds the AIP section and returns the
 * locking script. The layouts reproduce, byte for byte, what the peck.to web
 * client writes today (see the golden vectors in the tests), so posts from
 * every client read the same.
 *
 * Canonical choices where the family's builders disagreed:
 *  - B encoding is "utf-8" for text and "binary" for bytes.
 *  - Text posts carry the filename "post.md" in B and repeat the text as MAP
 *    `content`.
 *  - Likes, unlikes and pure reposts are MAP only, pointing at the target
 *    with `tx`.
 *  - A reply points at its parent with `context tx`, `tx <parent>` and
 *    `reply <parent>` (the last one for readers that only know that key).
 *  - A quote is `type repost` with its own text and `tx <target>`.
 *  - A follow names its target by `address` (a P2PKH address or public key).
 *  - No push is ever empty: readers skip OP_0 and misread every field after it.
 */
import { PIPE, PROTO_B, PROTO_MAP, SchemaError, payload, type Push, type SchemaPayload } from './bitcom.js'
import { geoFields, type GeoInput } from './geo.js'

const TXID_RE = /^[0-9a-fA-F]{64}$/

/** Fields every builder takes. */
export interface BaseInput {
  /** The MAP `app` value: the app that writes the transaction, e.g. "peck.to". */
  app: string
}

/** Binary media carried in the B section instead of text. */
export interface MediaInput {
  /** The raw bytes. */
  data: Uint8Array | readonly number[]
  /** Media type as written on-chain, e.g. "image/jpeg". */
  mediaType: string
  /** File name as written on-chain. */
  filename: string
}

/** Shared by post, reply and quote. */
export interface ContentInput extends BaseInput {
  /**
   * The text. With `media` it is the caption (MAP `content` only); without,
   * it is the B body and is repeated as MAP `content`.
   */
  text?: string
  /** Put binary media in the B section; `text` becomes its caption. */
  media?: MediaInput
  /** Tags, written as a MAP `ADD tags` section. Duplicates and empty tags are dropped. */
  tags?: readonly string[]
  /**
   * Location, written as MAP `lat` and `lng` (and `alt`, `geohash` when given).
   * Any post, reply or quote can carry one: a pin is a post with a location.
   */
  geo?: GeoInput
  /**
   * Mentioned authors' posting addresses (or keys), written as one MAP
   * `mention` field. Resolve @handles to addresses before calling.
   */
  mentions?: readonly string[]
}

export interface PostInput extends ContentInput {
  /** Post into a channel: MAP `context channel`, `channel <name>`. */
  channel?: string
}

export interface ReplyInput extends ContentInput {
  parentTxid: string
}

export interface QuoteInput extends ContentInput {
  targetTxid: string
}

/** Categories peck.world colours and filters its pins by. Any other value is written as given. */
export const PIN_CATEGORIES = ['general', 'business', 'event', 'alert', 'idea', 'photo'] as const
export type PinCategory = (typeof PIN_CATEGORIES)[number]

export interface PinInput extends BaseInput {
  /** Where the pin is. Required: a pin is a post with a location. */
  geo: GeoInput
  /** One line. Written as the B heading and as MAP `title`. */
  title: string
  /** Longer text under the title (markdown), written in the B section. */
  description?: string
  /** One of {@link PIN_CATEGORIES} (default "general"); other values are written as given. */
  category?: PinCategory | (string & {})
  /** Tags, as for `post`. */
  tags?: readonly string[]
  /** Mentioned authors' posting addresses (or keys), as for `post`. */
  mentions?: readonly string[]
}

export interface TargetInput extends BaseInput {
  targetTxid: string
}

export interface FollowInput extends BaseInput {
  /** The followed author's posting address (or public key). */
  address: string
  /** Optional human-readable handle, without the @. */
  handle?: string
}

export interface TagInput extends BaseInput {
  targetTxid: string
  /** Lowercased and comma-joined into one MAP `tags` field. */
  tags: readonly string[]
  category?: string
  lang?: string
  tone?: string
}

export interface MessageInput extends BaseInput {
  text: string
  /** A public channel. Leave both `channel` and `recipient` out for the global room. */
  channel?: string
  /** A direct recipient's identity key (MAP `context bapID`). Mutually exclusive with `channel`. */
  recipient?: string
}

export interface ProfileInput extends BaseInput {
  displayName: string
  /** Picture reference or URL, e.g. uhrp://…, b://…, https://…. */
  avatar?: string
  bio?: string
  /** Txid of a certificate's revocation outpoint that backs this profile. */
  certRef?: string
}

// ── validation ──────────────────────────────────────────────────

// A value equal to "|" would read as a section separator, so no field may be one.
function required(name: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) throw new SchemaError(`${name} is required`)
  return noSeparator(name, v)
}

function optional(name: string, v: string | undefined | null): string | undefined {
  return typeof v === 'string' && v.length > 0 ? noSeparator(name, v) : undefined
}

function txid(name: string, v: unknown): string {
  const t = required(name, v)
  if (!TXID_RE.test(t)) throw new SchemaError(`${name} must be a 64-character hex txid`)
  return t.toLowerCase()
}

function trimmed(v: unknown): string | undefined {
  return typeof v === 'string' ? v.trim() : undefined
}

function noSeparator(name: string, v: string): string {
  if (v === PIPE) throw new SchemaError(`${name} cannot be "|"`)
  return v
}

// ── sections ────────────────────────────────────────────────────

const TEXT_MEDIA_TYPE = 'text/markdown'
const TEXT_FILENAME = 'post.md'
const TEXT_ENCODING = 'utf-8'
const BINARY_ENCODING = 'binary'

/** `PROTO_B <data> <media type> <encoding> [filename] |` */
function bSection(data: Push, mediaType: string, encoding: string, filename?: string): Push[] {
  return [PROTO_B, data, mediaType, encoding, ...(filename ? [filename] : []), PIPE]
}

function tagsSection(tags: readonly string[] | undefined): Push[] {
  const unique = Array.from(new Set((tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0)))
  if (unique.length === 0) return []
  for (const t of unique) noSeparator('tag', t)
  return [PIPE, PROTO_MAP, 'ADD', 'tags', ...unique]
}

function mentionFields(mentions: readonly string[] | undefined): Push[] {
  const list = Array.from(new Set((mentions ?? []).map((m) => m.trim()).filter(Boolean)))
  if (list.length === 0) return []
  for (const m of list) if (m.includes(',')) throw new SchemaError('a mention cannot contain ","')
  return ['mention', noSeparator('mention', list.join(','))]
}

/**
 * B section plus the MAP head (`SET app <app> type <type> [content <text>]`)
 * shared by post, reply and quote.
 */
function contentHead(input: ContentInput, type: string): Push[] {
  const app = required('app', input.app)
  const text = optional('text', input.text)
  let b: Push[]
  if (input.media) {
    const { data, mediaType, filename } = input.media
    if (!data || data.length === 0) throw new SchemaError('media.data is empty')
    b = bSection(data instanceof Uint8Array ? data : Array.from(data), required('media.mediaType', mediaType),
      BINARY_ENCODING, required('media.filename', filename))
  } else {
    if (!text) throw new SchemaError('text is required when there is no media')
    b = bSection(text, TEXT_MEDIA_TYPE, TEXT_ENCODING, TEXT_FILENAME)
  }
  return [...b, PROTO_MAP, 'SET', 'app', app, 'type', type, ...(text ? ['content', text] : [])]
}

function mapOnly(app: string, type: string, fields: Push[]): SchemaPayload {
  return payload([PROTO_MAP, 'SET', 'app', required('app', app), 'type', type, ...fields])
}

// ── builders ────────────────────────────────────────────────────

/** A top-level post, optionally in a channel. */
export function post(input: PostInput): SchemaPayload {
  const channel = optional('channel', input.channel)
  return payload([
    ...contentHead(input, 'post'),
    ...(channel ? ['context', 'channel', 'channel', channel] : []),
    ...geoFields(input.geo),
    ...mentionFields(input.mentions),
    ...tagsSection(input.tags),
  ])
}

/**
 * A pin: a post with a location, laid out the way peck.world writes one. The B
 * section is the markdown `# <title>` (plus a blank line and the description
 * when there is one) named `pin.md`; MAP is `SET app <app> type post`, the
 * location, `category` and `title`. There is no MAP `content` (the B section
 * carries the text), and the type stays `post`: readers find pins by their
 * coordinates, not by a type of their own.
 *
 * For a post that only carries a location, use `post({ geo })`.
 */
export function pin(input: PinInput): SchemaPayload {
  const app = required('app', input.app)
  const title = required('title', trimmed(input.title))
  if (/[\r\n]/.test(title)) throw new SchemaError('title must be a single line')
  const description = optional('description', trimmed(input.description))
  const category = optional('category', trimmed(input.category)) ?? 'general'
  if (!input.geo) throw new SchemaError('geo is required')
  return payload([
    ...bSection(description ? `# ${title}\n\n${description}` : `# ${title}`, TEXT_MEDIA_TYPE, TEXT_ENCODING, 'pin.md'),
    PROTO_MAP, 'SET', 'app', app, 'type', 'post',
    ...geoFields(input.geo),
    'category', category,
    'title', title,
    ...mentionFields(input.mentions),
    ...tagsSection(input.tags),
  ])
}

/** A reply to `parentTxid`. Readers store it as type `reply`. */
export function reply(input: ReplyInput): SchemaPayload {
  const parent = txid('parentTxid', input.parentTxid)
  return payload([
    ...contentHead(input, 'post'),
    'context', 'tx', 'tx', parent, 'reply', parent,
    ...geoFields(input.geo),
    ...mentionFields(input.mentions),
    ...tagsSection(input.tags),
  ])
}

/** A quote: own text (or media) that embeds `targetTxid`. */
export function quote(input: QuoteInput): SchemaPayload {
  const target = txid('targetTxid', input.targetTxid)
  return payload([
    ...contentHead(input, 'repost'),
    'tx', target,
    ...geoFields(input.geo),
    ...mentionFields(input.mentions),
    ...tagsSection(input.tags),
  ])
}

/** A pure repost of `targetTxid`, with no content of its own. */
export function repost(input: TargetInput): SchemaPayload {
  return mapOnly(input.app, 'repost', ['tx', txid('targetTxid', input.targetTxid)])
}

export function like(input: TargetInput): SchemaPayload {
  return mapOnly(input.app, 'like', ['tx', txid('targetTxid', input.targetTxid)])
}

export function unlike(input: TargetInput): SchemaPayload {
  return mapOnly(input.app, 'unlike', ['tx', txid('targetTxid', input.targetTxid)])
}

function followFields(input: FollowInput): Push[] {
  const handle = optional('handle', input.handle?.replace(/^@/, ''))
  return [...(handle ? ['handle', handle] : []), 'address', required('address', input.address)]
}

export function follow(input: FollowInput): SchemaPayload {
  return mapOnly(input.app, 'follow', followFields(input))
}

export function unfollow(input: FollowInput): SchemaPayload {
  return mapOnly(input.app, 'unfollow', followFields(input))
}

/** Tag an existing post (a retroactive, per-author label set). */
export function tag(input: TagInput): SchemaPayload {
  const target = txid('targetTxid', input.targetTxid)
  const tags = Array.from(new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)))
  if (tags.length === 0) throw new SchemaError('tags is required')
  for (const t of tags) if (t.includes(',')) throw new SchemaError('a tag cannot contain ","')
  const extra: Push[] = []
  for (const key of ['category', 'lang', 'tone'] as const) {
    const v = optional(key, input[key])
    if (v) extra.push(key, v.toLowerCase())
  }
  return mapOnly(input.app, 'tag', ['context', 'tx', 'tx', target, 'tags', noSeparator('tags', tags.join(',')), ...extra])
}

/** A chat message to the global room, a channel, or (in the clear) one recipient. */
export function message(input: MessageInput): SchemaPayload {
  const app = required('app', input.app)
  const text = required('text', input.text)
  const channel = optional('channel', input.channel)
  const recipient = optional('recipient', input.recipient)
  if (channel && recipient) throw new SchemaError('a message goes to a channel or a recipient, not both')
  return payload([
    ...bSection(text, 'text/plain', TEXT_ENCODING),
    PROTO_MAP, 'SET', 'app', app, 'type', 'message',
    ...(channel ? ['context', 'channel', 'channel', channel] : []),
    ...(recipient ? ['context', 'bapID', 'bapID', recipient] : []),
  ])
}

/** A profile update. Omitted optional fields are left as they were. */
export function profile(input: ProfileInput): SchemaPayload {
  const fields: Push[] = ['display_name', required('displayName', input.displayName)]
  const avatar = optional('avatar', input.avatar)
  const bio = optional('bio', input.bio)
  if (avatar) fields.push('avatar', avatar)
  if (bio) fields.push('bio', bio)
  if (input.certRef !== undefined) fields.push('cert_ref', txid('certRef', input.certRef))
  return mapOnly(input.app, 'profile', fields)
}

/**
 * The #hashtags in a text, without the #, in order of appearance and
 * de-duplicated (letters, digits and underscores). Pass them as `tags`.
 */
export function hashtags(text: string): string[] {
  return Array.from(new Set((text.match(/#[\p{L}\d_]+/gu) ?? []).map((t) => t.slice(1))))
}
