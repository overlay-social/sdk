// The `dm` module: end-to-end encrypted direct messages, compatible with
// peck.to's DM client in both directions.
//
//   const wallet = await connect({ originator: 'peck.to' })
//   const dm = createDmClient({ wallet })
//   await dm.send(recipientIdentityKey, 'hello')
//   for (const m of await dm.list()) show(m.sender, m.text)
//   await dm.ack(shownIds)
//
// Envelopes are BRC-2 encrypted by the user's BRC-100 wallet under a BRC-42
// key ([2, 'peck dm'], key ID '1', counterparty = the other party); the
// message box transport is mutually authenticated (BRC-103/104). The SDK
// never holds a private key.
export {
  DM_ENVELOPE_VERSION,
  DM_KEY_ID,
  DM_PROTOCOL,
  buildEnvelope,
  decryptText,
  encryptText,
  envelopeMessage,
  envelopePeer,
  identityKeyOf,
  isIdentityKey,
  openEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type BuildEnvelopeInput,
  type DmEnvelope,
  type DmWallet,
  type OpenEnvelopeOptions,
  type WalletCallOptions,
} from './envelope.js'
export {
  DEFAULT_DM_HOST,
  DM_BOX,
  MESSAGEBOX_KEY_ID,
  MESSAGEBOX_PROTOCOL,
  RECEIPT_BOX,
  TYPING_BOX,
  createDmClient,
  parseSignal,
  type DmClient,
  type DmClientOptions,
  type DmMessage,
  type DmSignal,
  type ListenOptions,
  type LiveSendResult,
  type LiveSocket,
  type MessageBoxRow,
  type RawSendInput,
  type ReceiptState,
  type SendOptions,
  type SendResult,
  type SocketFactory,
} from './client.js'
export { DmError, isDmError, type DmErrorCode } from './errors.js'
export { normalizeAdvertisedHost, normalizeHost } from './host.js'
