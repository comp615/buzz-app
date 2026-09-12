import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import {
  effectiveFrontier,
  overrideActive,
  targetKey,
  type ReadTarget,
} from "./read-state-model";
import type {
  createReadState,
  ReadMutationResult,
  ReadSyncSnapshot,
} from "./read-state";
import type { Priority, RelayReader } from "./reader";
import { foldMessages } from "./fold";
import { threadReference } from "./thread-reference";

export type UnreadSnapshot = Readonly<{
  target: ReadTarget;
  /** null means unobserved/denied, never a fabricated zero or an exact relay total. */
  observedCount: number | null;
  attentionCount: number | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  manual: "none" | "local-only" | "remote";
  error?: string | undefined;
}>;
export type ThreadActivityItem = Readonly<{
  channelId: string;
  rootId: string;
  latestMessageId: string;
  authorId: string;
  createdAt: number;
  preview: string;
  unreadCount: number;
}>;
export type ThreadActivitySnapshot = Readonly<{
  channelId: string;
  /** null means activity evidence is unknown or access is denied. */
  items: readonly ThreadActivityItem[] | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
export type ReadingHandle = Readonly<{
  /** Only message IDs actually visible to the active consumer; no caller timestamps. */
  observe(messageIds: readonly string[]): Promise<void>;
  dispose(): void;
}>;
export interface UnreadCapability {
  snapshot(target: ReadTarget): UnreadSnapshot;
  subscribe(target: ReadTarget, listener: () => void): () => void;
  activity(channelId: string): ThreadActivitySnapshot;
  subscribeActivity(channelId: string, listener: () => void): () => void;
  sync(): ReadSyncSnapshot;
  subscribeSync(listener: () => void): () => void;
  ensure(): Promise<void>;
  refresh(): Promise<void>;
  retrySync(): Promise<void>;
  reading(channelId: string): ReadingHandle;
  /** Explicit prefix intent, unlike individual-message visibility observations. */
  markThrough(
    target: ReadTarget,
    messageId: string,
  ): Promise<ReadMutationResult>;
  markUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  readonly syncedManualUnread: false;
}
const contentKind = (event: RelayEvent) =>
  event.kind === 9 || event.kind === 40002;
const channelOf = (event: RelayEvent) => {
  const tags = event.tags.filter(([name]) => name === "h");
  return tags.length === 1 ? tags[0]?.[1] : undefined;
};
/** Bounded verified evidence and one projection; no sidebar counters, sockets or implicit reads. */
export function createUnread({
  reads,
  channels,
  reader,
  viewer,
  notify = (listener) => listener(),
}: {
  reads: ReturnType<typeof createReadState>;
  channels: ChannelQueries;
  reader: RelayReader;
  viewer: string;
  notify?: (listener: () => void) => void;
}) {
  let closed = false,
    epoch = 0;
  let requested = false;
  let freshness: UnreadSnapshot["freshness"] = "unknown";
  let error: string | undefined;
  let refresh: Promise<void> | undefined;
  const lifetime = new AbortController();
  const events = new Map<string, RelayEvent>();
  const known = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, UnreadSnapshot>();
  const dirty = new Set<string>();
  const activityListeners = new Map<string, Set<() => void>>();
  const activitySnapshots = new Map<string, ThreadActivitySnapshot>();
  const activityDirty = new Set<string>();
  const handles = new Set<() => void>();
  let bytes = 0;
  const allowed = (id: string) =>
    channels
      .list()
      .channels.some(
        (channel) => channel.id === id && channel.members?.includes(viewer),
      );
  const keyFor = (target: ReadTarget) =>
    `${target.channelId}:${targetKey(target)}`;
  function root(event: RelayEvent): string | undefined {
    const channel = channelOf(event);
    let current = event;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current.id)) return;
      seen.add(current.id);
      const reference = threadReference(current);
      if (!reference) return current.id;
      const next = events.get(reference.rootId);
      if (!next || !contentKind(next) || channelOf(next) !== channel) return;
      current = next;
    }
  }
  type Evidence = {
    event: RelayEvent;
    rootId: string | undefined;
    mentioned: boolean;
  };
  let indexed = false;
  const byChannel = new Map<string, Evidence[]>();
  const tombstones = new Set<string>();
  const participants = new Set<string>();
  function indexEvidence() {
    if (indexed) return;
    indexed = true;
    byChannel.clear();
    tombstones.clear();
    participants.clear();
    for (const event of events.values()) {
      if (event.kind !== 5 && event.kind !== 9005) continue;
      for (const [name, id] of event.tags)
        if (name === "e" && id && events.get(id)?.pubkey === event.pubkey)
          tombstones.add(id);
    }
    for (const event of events.values()) {
      if (!contentKind(event) || tombstones.has(event.id)) continue;
      const channel = channelOf(event);
      if (!channel) continue;
      const rootId = root(event);
      if (event.pubkey === viewer && rootId) participants.add(rootId);
      const rows = byChannel.get(channel) ?? [];
      rows.push({
        event,
        rootId: threadReference(event) ? rootId : undefined,
        mentioned: event.tags.some(
          ([name, value]) => name === "p" && value === viewer,
        ),
      });
      byChannel.set(channel, rows);
    }
  }
  function deleted(event: RelayEvent): boolean {
    indexEvidence();
    return tombstones.has(event.id);
  }
  function inTarget(event: RelayEvent, target: ReadTarget) {
    return (
      channelOf(event) === target.channelId &&
      (target.kind === "channel" ||
        (target.kind === "message" && target.messageId === event.id) ||
        (target.kind === "thread" &&
          !!threadReference(event) &&
          root(event) === target.rootId))
    );
  }
  const unreadEvidence = (
    evidence: Evidence,
    channelId: string,
    state: ReturnType<typeof reads.state>,
  ) => {
    const { event, rootId } = evidence;
    if (event.pubkey === viewer) return false;
    const frontier = effectiveFrontier(
      state,
      `msg:${event.id}`,
      channelId,
      rootId,
    );
    const forced =
      overrideActive(state.overrides[`msg:${event.id}`], frontier) ||
      overrideActive(
        state.overrides[channelId],
        effectiveFrontier(state, channelId),
      ) ||
      (rootId !== undefined &&
        overrideActive(
          state.overrides[`thread:${rootId}`],
          effectiveFrontier(state, `thread:${rootId}`, channelId),
        ));
    return frontier === undefined || event.created_at > frontier || forced;
  };
  function compute(target: ReadTarget): UnreadSnapshot {
    const key = targetKey(target);
    const accessible =
      allowed(target.channelId) &&
      (target.kind === "channel" ||
        (() => {
          const event = events.get(
            target.kind === "thread" ? target.rootId : target.messageId,
          );
          return (
            !!event &&
            channelOf(event) === target.channelId &&
            contentKind(event)
          );
        })());
    if (!accessible)
      return Object.freeze({
        target,
        observedCount: null,
        attentionCount: null,
        coverage: "unknown",
        freshness: "unknown",
        manual: "none",
      });
    const evidence = known.has(target.channelId);
    const state = reads.state();
    let count = 0,
      attention = 0;
    const dm =
      channels
        .list()
        .channels.find((channel) => channel.id === target.channelId)
        ?.channelType === "dm";
    indexEvidence();
    for (const evidence of byChannel.get(target.channelId) ?? []) {
      const { event, rootId, mentioned } = evidence;
      if (
        !inTarget(event, target) ||
        !unreadEvidence(evidence, target.channelId, state)
      )
        continue;
      count++;
      const broadcast = event.tags.some(
        ([name, value]) => name === "broadcast" && value === "1",
      );
      if (dm || mentioned || broadcast || (rootId && participants.has(rootId)))
        attention++;
    }
    const manual = reads.localUnread(key)
      ? "local-only"
      : overrideActive(
            state.overrides[key],
            effectiveFrontier(state, key, target.channelId),
          )
        ? "remote"
        : "none";
    return Object.freeze({
      target,
      observedCount: evidence ? count : null,
      attentionCount: evidence ? attention : null,
      coverage: evidence ? "observed" : "unknown",
      freshness,
      manual,
      ...(error ? { error } : {}),
    });
  }
  const equal = (a: UnreadSnapshot, b: UnreadSnapshot) =>
    a.observedCount === b.observedCount &&
    a.attentionCount === b.attentionCount &&
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.manual === b.manual &&
    a.error === b.error;
  function computeActivity(channelId: string): ThreadActivitySnapshot {
    if (!allowed(channelId) || !known.has(channelId))
      return Object.freeze({
        channelId,
        items: null,
        coverage: "unknown",
        freshness: "unknown",
      });
    indexEvidence();
    const state = reads.state();
    const grouped = new Map<string, ThreadActivityItem>();
    const presented = new Map(
      foldMessages(channelId, "", [...events.values()], {
        includeReplies: true,
      }).map((message) => [message.id, message.content]),
    );
    for (const evidence of byChannel.get(channelId) ?? []) {
      const { event, rootId, mentioned } = evidence;
      const broadcast = event.tags.some(
        ([name, value]) => name === "broadcast" && value === "1",
      );
      if (
        !rootId ||
        (!mentioned && !broadcast && !participants.has(rootId)) ||
        !unreadEvidence(evidence, channelId, state)
      )
        continue;
      const current = grouped.get(rootId);
      const preview = presented.get(event.id) ?? event.content;
      if (!current) {
        grouped.set(
          rootId,
          Object.freeze({
            channelId,
            rootId,
            latestMessageId: event.id,
            authorId: event.pubkey,
            createdAt: event.created_at,
            preview,
            unreadCount: 1,
          }),
        );
        continue;
      }
      const latest =
        event.created_at > current.createdAt ||
        (event.created_at === current.createdAt &&
          event.id < current.latestMessageId);
      grouped.set(
        rootId,
        Object.freeze({
          channelId,
          rootId,
          latestMessageId: latest ? event.id : current.latestMessageId,
          authorId: latest ? event.pubkey : current.authorId,
          createdAt: latest ? event.created_at : current.createdAt,
          preview: latest ? preview : current.preview,
          unreadCount: current.unreadCount + 1,
        }),
      );
    }
    return Object.freeze({
      channelId,
      items: Object.freeze(
        [...grouped.values()].sort(
          (a, b) =>
            b.createdAt - a.createdAt ||
            a.latestMessageId.localeCompare(b.latestMessageId),
        ),
      ),
      coverage: "observed",
      freshness,
      ...(error ? { error } : {}),
    });
  }
  const equalActivity = (
    a: ThreadActivitySnapshot,
    b: ThreadActivitySnapshot,
  ) =>
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.error === b.error &&
    ((a.items === null && b.items === null) ||
      (a.items !== null &&
        b.items !== null &&
        a.items.length === b.items.length &&
        a.items.every((item, index) => {
          const other = b.items?.[index];
          return (
            item.rootId === other?.rootId &&
            item.latestMessageId === other.latestMessageId &&
            item.authorId === other.authorId &&
            item.createdAt === other.createdAt &&
            item.preview === other.preview &&
            item.unreadCount === other.unreadCount
          );
        })));
  function activity(channelId: string) {
    const previous = activitySnapshots.get(channelId);
    if (previous && !activityDirty.delete(channelId)) return previous;
    const value = computeActivity(channelId);
    if (previous && equalActivity(previous, value)) return previous;
    activitySnapshots.set(channelId, value);
    return value;
  }
  function snapshot(target: ReadTarget) {
    const key = keyFor(target),
      previous = snapshots.get(key);
    if (previous && !dirty.delete(key)) return previous;
    const value = compute(previous?.target ?? Object.freeze({ ...target }));
    if (previous && equal(previous, value)) return previous;
    if (!previous && snapshots.size >= 4096) {
      for (const key of snapshots.keys())
        if (!listeners.has(key)) {
          snapshots.delete(key);
          dirty.delete(key);
        }
      if (snapshots.size >= 4096)
        throw new Error("Unread selector capacity reached");
    }
    snapshots.set(key, value);
    return value;
  }
  function addActivityListener(channelId: string, listener: () => void) {
    activity(channelId);
    const set = activityListeners.get(channelId) ?? new Set();
    set.add(listener);
    activityListeners.set(channelId, set);
    return () => {
      set.delete(listener);
      if (!set.size) activityListeners.delete(channelId);
    };
  }
  function publish(channelIds?: ReadonlySet<string>) {
    if (closed) return;
    const changed: string[] = [];
    const changedActivity: string[] = [];
    for (const [key, old] of snapshots) {
      if (channelIds && !channelIds.has(old.target.channelId)) continue;
      // Revisit dormant selectors lazily, retaining identity if unchanged.
      if (!listeners.has(key)) {
        dirty.add(key);
        continue;
      }
      const next = compute(old.target);
      if (!equal(old, next)) {
        snapshots.set(key, next);
        changed.push(key);
      }
    }
    for (const [channelId, old] of activitySnapshots) {
      if (channelIds && !channelIds.has(channelId)) continue;
      if (!activityListeners.has(channelId)) {
        activityDirty.add(channelId);
        continue;
      }
      const next = computeActivity(channelId);
      if (!equalActivity(old, next)) {
        activitySnapshots.set(channelId, next);
        changedActivity.push(channelId);
      }
    }
    // Replace/invalidate ALL affected projections before any reentrant callback.
    for (const key of changed)
      for (const listener of listeners.get(key) ?? []) notify(listener);
    for (const channelId of changedActivity)
      for (const listener of activityListeners.get(channelId) ?? [])
        notify(listener);
  }
  const stopRead = reads.subscribe(publish);
  function purge() {
    // A revoke/regrant must not revive a transaction accepted under the old access epoch.
    epoch++;
    const denied = new Set([...known].filter((channel) => !allowed(channel)));
    for (const channel of denied) known.delete(channel);
    for (const [id, event] of events) {
      const channel = channelOf(event);
      if (
        channel
          ? !allowed(channel)
          : !event.tags.some(
              ([name, value]) =>
                name === "e" &&
                value &&
                (() => {
                  const target = events.get(value);
                  const owner = target && channelOf(target);
                  return owner && allowed(owner);
                })(),
            )
      )
        events.delete(id);
    }
    indexed = false;
    // Reference-only tombstones are retained only with a still-accessible target.
    bytes = [...events.values()].reduce(
      (total, event) =>
        total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    publish();
  }
  // Names/previews do not affect unread. Read membership once, without a
  // roster scan for every channel, and retain only the invalidation inputs.
  const types = () =>
    new Map(
      channels
        .list()
        .channels.filter((channel) => channel.members?.includes(viewer))
        .map((channel) => [channel.id, channel.channelType]),
    );
  let channelTypes = types();
  let accessKey = [...channelTypes.keys()].sort().join(",");
  const stopChannels = channels.subscribeList(() => {
    const nextTypes = types();
    const next = [...nextTypes.keys()].sort().join(",");
    const changed = new Set(
      [...nextTypes].flatMap(([id, type]) =>
        channelTypes.get(id) !== type ? [id] : [],
      ),
    );
    channelTypes = nextTypes;
    if (next === accessKey) {
      if (changed.size) publish(changed);
    } else {
      accessKey = next;
      purge();
    }
  });
  async function repair(priority: Priority = "foreground") {
    requested = true;
    if (closed) return;
    if (refresh) return refresh;
    const generation = epoch;
    refresh = (async () => {
      await reads.ensure();
      if (closed || generation !== epoch) return;
      const ids = channels
        .list()
        .channels.filter((channel) => channel.members?.includes(viewer))
        .map((channel) => channel.id);
      if (!ids.length) return;
      try {
        // The relay caps aggregate explicit #h values at 128 per request.
        // Keep roster scope: an unscoped read also includes unjoined open channels.
        // Each bounded batch owns its queue-inclusive deadline after marker sync;
        // optional profiles must not block the initial user-visible observation.
        for (let offset = 0; offset < ids.length; offset += 128) {
          const signal = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10000),
          ]);
          const result = await reader.read(
            [
              {
                kinds: [9, 40002],
                "#h": ids.slice(offset, offset + 128),
                include_aux: true,
                limit: 500,
              },
            ],
            { signal, priority },
          );
          if (closed || generation !== epoch) return;
          if (!accept(result) || closed || generation !== epoch) return;
        }
        freshness = "observed";
        error = undefined;
        publish();
      } catch (cause) {
        if (closed || generation !== epoch) return;
        freshness = "stale";
        error =
          cause instanceof Error ? cause.message : "Unread observation failed";
        publish();
      }
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  }
  function accept(batch: readonly RelayEvent[]) {
    if (closed) return false;
    const changed = new Set<string>();
    indexed = false;
    const incoming = new Map(batch.map((event) => [event.id, event]));
    for (const event of batch) {
      if (
        ![9, 40002, 40003, 5, 9005].includes(event.kind) ||
        events.has(event.id)
      )
        continue;
      const channel =
        channelOf(event) ??
        event.tags
          .flatMap(([name, value]) =>
            name === "e" && value
              ? [channelOf(incoming.get(value) ?? events.get(value) ?? event)]
              : [],
          )
          .find(Boolean);
      if (!channel || !allowed(channel)) continue;
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (events.size >= 4096 || bytes + size > 8 * 1024 * 1024) {
        events.clear();
        known.clear();
        bytes = 0;
        error = "Unread observation capacity reached; refresh available";
        freshness = "stale";
        publish();
        return false;
      }
      events.set(event.id, event);
      bytes += size;
      known.add(channel);
      changed.add(channel);
      // A signed deletion may target readable messages in several channels.
      // Invalidate every affected projection, not only its explicit/first owner.
      if (event.kind === 5 || event.kind === 9005)
        for (const [name, id] of event.tags) {
          const target =
            name === "e" && id && (incoming.get(id) ?? events.get(id));
          const affected = target && channelOf(target);
          if (affected) changed.add(affected);
        }
    }
    if (changed.size) {
      const global = freshness !== "observed";
      freshness = "observed";
      publish(global ? undefined : changed);
    }
    return true;
  }
  function requireMessage(target: ReadTarget, id: string) {
    targetKey(target);
    const event = events.get(id);
    if (
      closed ||
      !allowed(target.channelId) ||
      !event ||
      !contentKind(event) ||
      deleted(event) ||
      channelOf(event) !== target.channelId
    )
      throw new Error("Verified readable message evidence unavailable");
    if (
      (target.kind === "thread" && root(event) !== target.rootId) ||
      (target.kind === "message" && target.messageId !== id)
    )
      throw new Error("Message does not belong to the read target");
    if (
      target.kind === "channel" &&
      threadReference(event) &&
      !event.tags.some(([name, value]) => name === "broadcast" && value === "1")
    )
      throw new Error("A thread reply cannot advance the channel frontier");
    return event;
  }
  const capability: UnreadCapability = Object.freeze<UnreadCapability>({
    snapshot,
    subscribe(target, listener) {
      snapshot(target);
      const key = keyFor(target),
        set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    activity,
    subscribeActivity: addActivityListener,
    sync: reads.snapshot,
    subscribeSync: reads.subscribe,
    ensure: () => refresh ?? (requested ? Promise.resolve() : repair()),
    refresh: async () => {
      await reads.refresh("foreground");
      await repair();
    },
    retrySync: async () => {
      await reads.refresh();
      await reads.flush();
    },
    syncedManualUnread: false,
    reading(channelId) {
      if (closed || !allowed(channelId) || handles.size >= 64)
        throw new Error("Reading handle unavailable");
      let active = true;
      const generation = epoch;
      const manualRevision = reads.revision();
      const observed = new Set<string>();
      const dispose = () => {
        active = false;
        handles.delete(dispose);
      };
      const valid = () =>
        active &&
        !closed &&
        generation === epoch &&
        allowed(channelId) &&
        (reads.localUnread(channelId) ?? 0) <= manualRevision;
      handles.add(dispose);
      return Object.freeze({
        dispose,
        async observe(ids: readonly string[]) {
          if (!valid() || ids.length > 128) return;
          for (const id of ids) {
            if (!valid() || observed.has(id)) continue;
            const target = {
              kind: "message" as const,
              channelId,
              messageId: id,
            };
            const event = requireMessage(target, id);
            if (
              (effectiveFrontier(
                reads.state(),
                targetKey(target),
                channelId,
                threadReference(event) ? root(event) : undefined,
              ) ?? -1) >= event.created_at
            ) {
              observed.add(id);
              continue;
            }
            await reads.read(
              targetKey(target),
              event.created_at,
              () => valid() && requireMessage(target, id) === event,
            );
            observed.add(id);
          }
        },
      });
    },
    async markThrough(target, id) {
      const event = requireMessage(target, id),
        generation = epoch;
      return reads.read(
        targetKey(target),
        event.created_at,
        () =>
          !closed &&
          generation === epoch &&
          requireMessage(target, id) === event,
        true,
      );
    },
    async markUnreadLocal(target) {
      const key = targetKey(target);
      const generation = epoch;
      const valid = () => {
        if (closed || generation !== epoch || !allowed(target.channelId))
          return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      return reads.markLocalUnread(key, valid);
    },
  });
  return {
    capability,
    // Private session evidence lookup; never seeds timeline windows or grants access.
    event(id: string) {
      const event = events.get(id);
      const channel = event && channelOf(event);
      return !closed && event && channel && allowed(channel)
        ? event
        : undefined;
    },
    accept,
    purge,
    reconnect() {
      if (requested) void reads.refresh().then(() => repair("background"));
    },
    stale() {
      epoch++;
      freshness = "stale";
      reads.stale();
      publish();
    },
    clear() {
      epoch++;
      indexed = false;
      events.clear();
      known.clear();
      bytes = 0;
      freshness = "unknown";
      error = undefined;
      publish();
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      for (const stop of [...handles]) stop();
      stopRead();
      stopChannels();
      listeners.clear();
      snapshots.clear();
      dirty.clear();
      activityListeners.clear();
      activitySnapshots.clear();
      activityDirty.clear();
      events.clear();
      reads.dispose();
    },
  };
}
