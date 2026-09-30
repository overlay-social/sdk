// The `wallet` module: one way to reach the user's BRC-100 wallet, and one
// error shape for everything a wallet can say.
//
//   const wallet = await connect({ originator: 'peck.to' })
//   wallet.via // 'peckos' | 'cwi' | 'local' | 'passkey'
//   try {
//     await wallet.createAction({ ... })
//   } catch (e) {
//     if (e instanceof WalletRequestError && e.reason === 'insufficient_funds') offerTopUp()
//   }
export {
  DEFAULT_LOCAL_WALLET_URL,
  LOCAL_PROBE_TIMEOUT_MS,
  connect,
  type ConnectOptions,
  type ConnectedWallet,
  type WalletLike,
  type WalletVia,
} from './connect.js'
export {
  BRC100_INSUFFICIENT_FUNDS,
  WalletRequestError,
  classifyWalletError,
  isWalletRequestError,
  normalizeWalletError,
  type WalletErrorReason,
} from './errors.js'
