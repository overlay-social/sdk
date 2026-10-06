// The `submit` module: hand a signed transaction to the overlay.
//
//   const wallet = await connect({ originator: 'peck.to' })
//   const action = await wallet.createAction({ description: 'Post', outputs })
//   const { admitted } = await submitToOverlay(action) // topic tm_social-content
//
// Browser to overlay only: no server, queue or database in between.
export {
  DEFAULT_SUBMIT_TIMEOUT_MS,
  OVERLAY_TOPICS,
  submitToOverlay,
  type ActionResultLike,
  type OverlayTopic,
  type Steak,
  type SubmitInput,
  type SubmitOptions,
  type SubmitResult,
  type TopicAdmittance,
  type TransactionLike,
} from './submit.js'
export { OverlaySubmitError, isOverlaySubmitError, type OverlaySubmitErrorCode } from './errors.js'
