# Unread and read-state ownership

`RelaySession.unread` is the shared capability. Plugins render its immutable
selectors and submit reading intent; they do not maintain counters, sign markers,
open sockets, or write persistence. `src/features/relay/unread.ts` owns bounded
verified message evidence, `read-state.ts` owns durable intent and reconciliation,
and the existing reader/live routes carry both. Disabling Channels does not erase
accepted intent. `src/plugins/author.ts` exports the types through the existing
host-matched author preview, not a cross-version SDK or plugin sandbox.

## Consumer contract

```ts
const target = { kind: "channel", channelId } as const;
const snapshot = session.unread.snapshot(target);
const unsubscribe = session.unread.subscribe(target, render);
await session.unread.ensure(); // shared bounded observation, not per-row fetch

// A custom reading UI owns one cancellable observation lease.
const reading = session.unread.reading(channelId);
await reading.observe(visibleVerifiedMessageIds);
reading.dispose(); // on hide, retarget, focus loss, or unmount
unsubscribe();
```

Targets are `{kind:"channel",channelId}`, `{kind:"thread",channelId,rootId}`,
or `{kind:"message",channelId,messageId}`. The consumer must establish actual
reading intent before calling `observe`: this is a trusted in-process API, not
proof that a human read text. The engine resolves signed message identity,
timestamps, ancestry, deletion and current access; arbitrary timestamps are not
accepted. Cancelled leases cannot survive disposal, revocation/regrant, or a newer
manual-unread action. Restored channel heads pass signature/access verification
and supply evidence before their rows become observable.

Reusable `ChannelTimeline` and `ThreadPanel` own the standard observation policy:
focused active reading surface, visible document, settled positioning, fully
visible rows, and 750 ms dwell. Scroll/content/focus changes cancel/restart dwell.
Mounted virtualizer overscan, preload, selection, and composer focus are not
reading. Automatic observations mark **individual messages**, never a prefix that
could hide unseen siblings. Oversized rows that never fit fully are not auto-read.

- `observedCount` is `null` when unknown or denied, never a fabricated zero.
  Otherwise it counts the bounded evidence currently known, excluding own messages,
  auxiliary events and authorized deletions. It is **not an exact total or lower
  bound**: missing markers/deletions can overcount; missing history can undercount.
- `coverage` and `freshness` describe message evidence, separately from `sync()`.
  Evidence is capped at 4,096 events / 8 MiB. Repair queries the membership roster
  in sequential batches of at most 128 explicit channel IDs (the relay limit),
  with up to 500 recent rows **per batch**, not a shared remainder or one head
  request per sidebar row. A 278-channel roster therefore makes three reads.
  Earlier results publish progressively and survive a later transport failure;
  capacity overflow retains the existing visible error/clear policy and stops repair.
  Querying every ID does not mean observing every channel: busy channels can still
  consume their batch's sample, and missing thread roots can affect inherited markers.
  Repair evidence does not seed channel windows, alter cursors, or mark messages read.
- Initial marker/evidence observation and explicit evidence refresh are foreground
  reads so optional profiles do not block them. Reconnect/periodic sync and marker
  publication remain background. Each evidence batch gets its own queue-inclusive
  10-second deadline **after** marker observation, rather than spending it waiting
  for markers. Marker failure stays visible separately in `sync()` even when
  evidence succeeds. Concurrent `ensure()` calls share active work; a failed attempt
  needs explicit `refresh()` or reconnect, not an unlimited automatic retry loop.
- `attentionCount` is a separate observed subset: DMs, mentions and replies to
  participating threads. It does not trigger notifications or implement mute policy.
- `markThrough(target, messageId)` is explicit prefix intent through verified
  evidence. It can mark unloaded earlier messages read; do not use it for viewport
  observation. A channel prefix requires a top-level message, not a reply.
- `markUnreadLocal(target)` is durable **on this browser profile/device only**.
  Automatic reading does not clear it. An explicit mark-through clears that
  target's local mark. `syncedManualUnread` is `false`.
- `refresh()` retries evidence/marker observation; `retrySync()` refreshes markers
  and retries pending publication. `ReadMutationResult.durability === "saved"`
  means the local transaction committed, not that the relay accepted it.

The sidebar separates ordinary unread from directed attention. Any unread state
strengthens the channel label and keeps a small quiet dot for reveal geometry;
DMs, mentions and participating-thread replies receive the stronger count badge.
A local manual-unread mark replaces any displayed count with a dot and a local-only
label; the underlying observed count and attention styling remain available.
Conversation options exposes explicit actions and Unread status/retry. Unknown and
observed-zero both omit a badge; the API preserves the distinction. There is no
notification, feed, or exact-count service here.

When unread rows are outside the sidebar's scroll viewport, floating “Unread
above/below” buttons reveal the nearest one in that direction. They measure the
existing rendered badges—no extra unread subscriptions or relay reads just to
show the pills. Search-filtered rows do not participate. Collapsed sections use
the summary's position and expand when revealed. A partly visible row is not
outside the fold. Activation scrolls and focuses the row, retaining its ordinary
focus preparation; it does not select the channel or acknowledge any messages.
The pills use presence, not a potentially misleading aggregate message total.

Thread buttons keep the summary's total reply count and add a dot when the shared
thread selector has observed unread replies or explicit thread-unread intent.
Accessible names distinguish observed evidence, stale evidence and local-only
intent; unknown/observed-zero omit the dot, not assert complete read history.
Each mounted button subscribes to its own thread, without fetching thread history.
Opening/hovering a button does not acknowledge replies; the existing focused
viewport dwell in `ThreadPanel` supplies individual-message reading intent.
Unread ancestry uses the same canonical marked-reference parser as thread opening
and row projection (case-insensitive hex, last valid marker wins). Resolution still
requires bounded, retained same-channel message evidence; references alone do not
grant access or trigger a read.

## Durable sync and privacy

The journal is separate from disposable message caches in `buzz-read-state-v1`,
partitioned by relay/community scope and viewer. IndexedDB strict read/write
transactions merge concurrent local windows; Web Locks serialize the publisher.
Without host decoding the capability is `unsupported`; without safe serialized
sign/publish it is `read-only`. Read sync requires `frontier-sync`. Local manual
intent can still be saved independently of remote capability.

Signed kind-30078 NIP-RS blobs use self-encryption and a persisted random coordinate
slot/client ID. The Node development broker alone owns the key, narrow codec,
signing, same-origin checks, scoped NIP-98 and relay admission. Plugins receive no
generic encryption or arbitrary-kind signing capability. Packaged builds do not
include this development broker and do not gain a native read-state signer here.

Accepted local intent is saved before signing; the exact signed event is saved
before sending. Lost responses/readback retain that event identity for retry.
`accepted` is a publish receipt, not observed coordinate state; `reconciled` also
requires readback. A failed transaction is not acknowledged as saved. Timestamps
are uint32 seconds; replaceable publication clocks advance monotonically with a
bounded lead rather than running indefinitely into the future.

Ordinary frontiers are **bounded recent hints, not everlasting read receipts**.
The local state has a 96 KiB serialized-blob budget and wire publication a 40 KiB
plaintext budget. Persisted local interaction order prioritizes newly read old
history as well as current traffic. Only frontier-only hints can be pruned; older
messages may look unread again. No synthetic channel prefix is introduced to fit.
Override groups, permanent clear floors, directly associated frontiers and possible
inherited channel/thread frontiers are protected; capacity failure is visible,
never floor truncation. Publication of any override-bearing state is deliberately
blocked in this release. Remote registers can be reduced/displayed, but synchronized
manual-unread and canonical override compaction are not enabled.

Marker discovery uses the relay's host-bound NIP-11 `read_state_snapshot` descriptor
when available, independently of request parameters. The exact versioned query
must return a complete own-author kind-30078 snapshot with matching community,
valid signatures and unique coordinates. Ordinary capped arrays and live EOSE do
not establish completeness. The snapshot proves one writer cut, not live freshness,
message-history completeness, a CAS revision, or a global cryptographic community
identity. Absent discovery permits only bounded ordinary marker observation.

Resource bounds: 4,096 snapshot events / 8 MiB encoded event array; envelope stream
is capped before parsing at 8 MiB + 4 KiB; individual recognized read-state events
are limited to 64 KiB and blobs to 10,000 keys. Unknown/undecryptable recognized
coordinates fail marker loading rather than masquerading as empty state. Access
revocation denies projections before any subscriber can inspect another one;
durable account-owned intent survives without exposing revoked context projections.

## Verification

- `read-state-model.test.ts`: protocol reduction and algebra.
- `read-state-retention.test.ts`, `read-state.test.ts`: bounded growth, old-history
  interaction order, restart, exact-event retry, durable mutation and floor safety.
- `reader.test.ts` and history browser journeys: finite-read navigation admission,
  preserved deadlines/cancellation, actual reload and dismissed navigation. Simulated
  pagehide/pageshow tests establish handler behavior, not a full BFCache journey.
  Live-stream reconnect during a delayed departing navigation is a separate
  pre-existing host-lifecycle limitation; this is not a universal unload fence.
- `unread-startup.test.ts`: production reader/session scheduling, large-roster
  batching, progressive/partial failure, explicit/reconnect recovery and access/cache
  fences; `read-state.test.ts` also checks both marker-discovery priority paths.
- `unread.test.ts`: real session lifecycle, access, deletions, reading leases and
  reverified disk-restore evidence without network content.
- `use-reading.test.ts`, timeline/thread tests: dwell/geometry and owner wiring.
- `dev/read-state-broker.test.mjs`: real local HTTP broker, NIP-11/NIP-98/NIP-44,
  reader envelope verification, filter rejection and streamed body limits.
- `MessageRow.test.tsx`, `tests/browser/thread-unread.spec.mjs`: thread selector
  presentation, unchanged summary counts, hover/keyboard-focus treatment, independent
  thread reading, own/peer live arrivals and reload through the production broker.
- `tests/browser/sidebar-unread.spec.mjs`: above/below geometry, no layout shift,
  resize/search/collapse, keyboard continuation, manual intent, evidence refresh,
  session retargeting, and no reading/selection from reveal. Focus retains existing
  channel preparation; merely showing the indicators does not fetch channels.
- `tests/browser/unread.spec.mjs`: production build/React/session/IndexedDB/broker,
  observed sidebar → focused dwell → encrypted publication/readback, reload,
  cancellation and explicit local-unread clearing with network content held.
  Only upstream relay policy is modeled, with ephemeral identities. This does not
  establish native GUI behavior or deployed relay compatibility.
