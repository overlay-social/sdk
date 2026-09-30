// The `schema` module: Bitcoin Schema (B / MAP / AIP) output builders.
//
//   const lockingScript = await signPayload(post({ app: 'peck.to', text }), { wallet })
//   await wallet.createAction({
//     description: 'Post',
//     outputs: [{ lockingScript: lockingScript.toHex(), satoshis: 0, outputDescription: 'Post' }],
//   })
//
// Builders are pure and synchronous; signing goes through a BRC-100 wallet
// (`createSignature`), so the SDK never holds a private key.
export {
  PIPE,
  PROTO_AIP,
  PROTO_B,
  PROTO_MAP,
  SchemaError,
  opReturnPushes,
  payload,
  toLockingScript,
  type Push,
  type SchemaPayload,
} from './bitcom.js'
export {
  AIP_ALGORITHM,
  AIP_DEFAULT_COUNTERPARTY,
  AIP_DEFAULT_KEY_ID,
  AIP_DEFAULT_PROTOCOL,
  aipPreimage,
  signPayload,
  verifyAip,
  type AipCheck,
  type AipSignOptions,
  type AipWallet,
} from './aip.js'
export {
  PIN_CATEGORIES,
  follow,
  hashtags,
  like,
  message,
  pin,
  post,
  profile,
  quote,
  reply,
  repost,
  tag,
  unfollow,
  unlike,
  type BaseInput,
  type ContentInput,
  type FollowInput,
  type MediaInput,
  type MessageInput,
  type PinCategory,
  type PinInput,
  type PostInput,
  type ProfileInput,
  type QuoteInput,
  type ReplyInput,
  type TagInput,
  type TargetInput,
} from './builders.js'
export {
  ALT_DECIMALS,
  DEFAULT_GEOHASH_LENGTH,
  DEFAULT_GEO_PRECISION,
  MAX_GEOHASH_LENGTH,
  MAX_GEO_PRECISION,
  decodeGeohash,
  encodeGeohash,
  normalizeGeo,
  type GeoFields,
  type GeoInput,
} from './geo.js'
