// A transaction shaped like the one peck.to v2 sends on a visitor's first
// write: output 0 the AIP-signed post, output 1 the key binding, both
// 0 satoshis. Its one input spends a made-up parent, so it is never valid on
// chain, but it serialises as BEEF and Atomic BEEF the way a wallet's
// `createAction` result does, which is all the overlay's parsers read.
import { P2PKH, PrivateKey, Transaction, UnlockingScript, type LockingScript } from '@bsv/sdk'

export function firstWriteTx(outputs: LockingScript[]): Transaction {
  const parent = new Transaction(1, [], [{ lockingScript: new P2PKH().lock(new PrivateKey(99).toAddress()), satoshis: 1000 }], 0)
  return new Transaction(
    1,
    [{ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff }],
    outputs.map((lockingScript) => ({ lockingScript, satoshis: 0 })),
    0,
  )
}
