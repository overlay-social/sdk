# 08 — State anchoring

- Status: IMPLEMENTED for 12 topics (listed in §1). Third-party recomputation of a root needs the outpoint set, which is not served yet (ROADMAP, [04](04-federation-roadmap.md)).
- Revision: 2
- Date: 2026-10-26

> **In short.** An overlay could quietly change what it tells people, or tell
> different people different things. To make that detectable, it regularly
> writes a fingerprint of each topic's current contents into a Bitcoin
> transaction. Anyone can later compare what the overlay serves with the
> fingerprint on chain. The fingerprint proves what the overlay committed to
> at a point in time, not that its admission rules were applied correctly.

## 1. Topic state root (normative)

Per topic, the root commits to the set of currently admitted, unspent
outputs:

```
element   = lowercase(txid) + ":" + decimal(vout)          e.g. "ab…ef:0"
set       = de-duplicated elements
root      = lowercase hex SHA-256 of the UTF-8 string join("\n", sort(set))
sort      = ascending by byte value (so ":10" sorts before ":9")
empty set → e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

The root is a flat hash, not a Merkle tree: it commits to the whole set and
proves nothing about a single element on its own.

**Test vector.** Set:

```
ff00000000000000000000000000000000000000000000000000000000000001:1
0a00000000000000000000000000000000000000000000000000000000000002:9
0a00000000000000000000000000000000000000000000000000000000000002:10
```

Sorted: `0a…02:10`, `0a…02:9`, `ff…01:1`. Root:
`5b2a80e0691124e881a183db7486d8e6b803be9e0d9a2c1e918507b73cbb1757`.

**Which outputs form the set.** For `tm_social-content` (and the legacy
`peck-schema`): the outputs the overlay engine admitted through `/submit`
and has not seen spent. For the token topics: the unspent tokens. For the
self-signed record topics: the records still active; for
`tm_social-friend` that excludes withdrawn `friend` records and every
`unfriend` record ([07 §3](07-social-friend.md)), and for `tm_key-binding`
it keeps only the latest binding per (`subject`, `certifier`) and drops
revoked ones ([06 §1](06-identity-attestations.md)).

**Anchored topics** in the reference deployment: `peck-schema`,
`tm_social-content`, `tm_social-profile`, `tm_social-handle`, `tm_peck-cat`,
`tm_peck-cat-funding`, `tm_key-binding`, `tm_identity-profile`,
`tm_identity-handle`, `tm_identity-cert`, `tm_social-friend`,
`tm_social-lens`. Not anchored: `tm_social-classification`,
`tm_overlay-anchor`.

`GET /v1/topic/:topic/root` → `{ status, topic, count, stateRoot, source, computedAt }`.
`GET /state` → every anchored topic with `{ topic, count, stateRoot, source, anchor }`,
where `anchor` is `{ root, txid, vout, outpoint, blockHeight, ts, anchoredAt, matchesLive }`
or `null`.

## 2. Anchor transaction (normative)

Each anchor is a new transaction with these two outputs first, followed by
the funding wallet's change:

```
out[0]  1 sat   P2PKH(<anchor key address>)
                OP_FALSE OP_IF "ord" OP_1 "application/json" OP_0 <JSON> OP_ENDIF
                JSON, keys in this order:
                { "p": "overlay.social/anchor", "topic": "<topic>", "root": "<64 hex>",
                  "count": <n>, "ts": <unix seconds>, "prev": "<txid>.<vout>" }   # prev: update only
out[1]  0 sat   OP_FALSE OP_RETURN  1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5  SET
                app peck.overlay-anchor  type anchor  action mint|update
                topic <topic>  root <64 hex>  count <n>  ts <unix seconds>
                anchor_key <66-hex key>  [prev <txid>.<vout>]
```

- `action mint` is a topic's first anchor; `action update` every later one.
- `prev` names the previous anchor's ordinal output (`<txid>.0`). It forms a
  logical chain per topic. The new anchor does not spend the previous one, so
  anchoring never competes with the topic's own outputs.
- `anchor_key` is the publisher's key; `out[0]` pays to its address.
- The `app` value `peck.overlay-anchor` is what the deployed anchors carry.
  Readers MUST match on it as written.

The overlay records the anchors it writes itself. The current anchor per
topic is the unspent one with the highest `ts`.

## 3. Cadence

Every 10 minutes the scheduler compares each topic's live root with its
latest anchored root. It anchors when they differ and the last anchor is at
least an hour old, and anchors a topic's genesis when it has none. No change,
no anchor.

## 4. Verification

For a topic:

1. `GET /state` gives `stateRoot` and `anchor` (`txid`, `root`, `matchesLive`).
   `matchesLive` is the overlay's own claim that the served root equals the
   anchored one. Check it:
2. Fetch the anchor transaction by `txid` from any chain source and verify
   it against block headers with its merkle path (BRC-62 BEEF). No full node
   is needed.
3. Read `root` from the inscription or the beacon and compare it with
   `stateRoot`.
4. Recompute `stateRoot` from the topic's outpoint set (§1). The reference
   overlay does not serve that set yet, so today a third party can check
   steps 1–3, and step 4 only for sets it has assembled itself.

A divergence between served state and the anchored root is detectable by
anyone who has the set. This is the audit primitive federation builds on
([04](04-federation-roadmap.md)).

## 5. Trust model (informative)

- An anchor proves commitment, not correct admission. It pins what the
  overlay served at time T, so the overlay cannot silently rewrite history or
  answer differently per client without being caught by someone holding the
  set.
- `anchor_key` identifies the publisher: today the reference overlay's
  operator key. In a federation each peer anchors its own roots.
- The operator pays for anchors: at most one small transaction per topic per
  hour, and only when the topic changed.
