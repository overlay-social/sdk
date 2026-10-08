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
  payment,
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
  type PaymentInput,
  type PinInput,
  type PostInput,
  type ProfileInput,
  type QuoteInput,
  type ReplyInput,
  type TagInput,
  type TargetInput,
} from './builders.js'
export {
  BRC29_PROTOCOL,
  brc29Output,
  type Brc29Output,
  type Brc29OutputInput,
  type Brc29Remittance,
  type Brc29Wallet,
} from './brc29.js'
export {
  IDENTITY_PROFILE_APP,
  IDENTITY_PROFILE_PROTOCOL,
  IDENTITY_PROFILE_SCHEMA_VERSION,
  identityProfile,
  identityProfilePreimage,
  verifyIdentityProfile,
  type IdentityProfile,
  type IdentityProfileCheck,
  type IdentityProfileInput,
  type IdentityProfileOptions,
  type IdentityProfileWallet,
} from './identity-profile.js'
export {
  FRIEND_APP,
  FRIEND_PROTOCOL,
  FRIEND_SCHEMA_VERSION,
  friend,
  friendPreimage,
  unfriend,
  verifyFriend,
  type FriendCheck,
  type FriendInput,
  type FriendOptions,
  type FriendRecord,
  type FriendWallet,
} from './friend.js'
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
