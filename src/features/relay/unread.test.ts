import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { foldMessages } from "./fold";
import {
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import type { RelayEvent } from "./events";
import type { ThreadActivitySnapshot } from "./unread";
import type { ChannelStoreOptions } from "./store";
import type { SavedHead } from "./persistence";
import type { ReadStateSigning } from "./read-state-host";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
  flush,
  bounds,
} from "./testing";
// @ts-expect-error Test the production Node codec with disposable identities.
import { decodeReadState, signReadState } from "../../../dev/read-state.mjs";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(options: ChannelStoreOptions = {}) {
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair();
  let journal: ReadJournal | undefined;
  let hold: Promise<void> | undefined;
  const storage: ReadStateStorage = {
    async update(change) {
      if (hold) {
        const wait = hold;
        hold = undefined;
        await wait;
      }
      journal = readJournal(change(journal), viewer.pubkey);
      return journal;
    },
    close() {},
  };
  let incoming: (events: readonly RelayEvent[]) => void = () => {};
  const query = vi.fn(
    async (_filters: readonly import("./events").ReadFilter[]) =>
      [] as RelayEvent[],
  );
  const host = {
    decode: vi.fn(async (events: readonly RelayEvent[]) =>
      decodeReadState(events, viewer.secret),
    ),
    sign: vi.fn(async (intent: ReadStateSigning) =>
      signReadState(intent, viewer.secret),
    ),
    publish: vi.fn(async () => {}),
  };
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      readState: host,
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      ...options,
      readStateStorage: storage,
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  owners.push(owner);
  const emit = (events: readonly RelayEvent[]) => incoming(events);
  const grant = (id: string, time = 10) =>
    emit([
      roster(relay, id, [viewer.pubkey], time),
      metadata(relay, id, id, time),
    ]);
  const target = { kind: "channel" as const, channelId: "room" };
  return {
    ...owner,
    viewer,
    relay,
    alice,
    host,
    query,
    emit,
    grant,
    target,
    snapshot: () => owner.session.unread.snapshot(target),
    journal: () => journal,
    holdSave() {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

it("production live evidence feeds stable snapshots; selection/prefetch do not read", async () => {
  const h = setup();
  h.grant("room");
  const unread = h.session.unread;
  expect(h.snapshot().observedCount).toBeNull();
  const row = message(h.alice, "room", "hello", 11, [["p", h.viewer.pubkey]]);
  h.emit([row, row, message(h.viewer, "room", "own", 12)]);
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    attentionCount: 1,
    coverage: "observed",
  });
  const snapshot = h.snapshot(),
    changed = vi.fn();
  unread.subscribe(h.target, changed);
  h.emit([row]);
  expect(h.snapshot()).toBe(snapshot);
  expect(changed).not.toHaveBeenCalled();
  await flush();
  expect(h.journal()?.state.frontiers).toEqual({});
  expect(h.host.sign).not.toHaveBeenCalled();
});

it("unread repair observes history without seeding the channel window or consuming its cursor", async () => {
  const h = setup();
  const rows = Array.from({ length: 60 }, (_, i) =>
    message(h.alice, "room", `history ${i}`, i + 11),
  );
  h.query.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (!filter?.kinds?.includes(9)) return [];
    if (filter.limit === 500) return rows; // Roster-wide unread evidence, not a window page.
    const older = filter.until !== undefined;
    const cursor = rows[older ? 20 : 40];
    if (!cursor) throw new Error("Missing fixture cursor");
    return [
      ...rows.slice(older ? 20 : 40, older ? 40 : 60),
      bounds(
        h.relay,
        "room",
        older ? `${filter.until}:${filter.before_id}` : "head",
        {
          has_more: true,
          next_cursor: {
            created_at: cursor.created_at,
            id: cursor.id,
          },
        },
      ),
    ];
  });
  h.grant("room");
  h.session.channels.ensure("room");
  await vi.waitFor(() =>
    expect(h.session.channels.window("room").rows).toHaveLength(20),
  );
  const head = h.session.channels.window("room");
  await h.session.unread.ensure();
  expect(h.snapshot().observedCount).toBe(60);
  expect(h.session.channels.window("room")).toBe(head);
  expect(h.journal()?.state.frontiers).toEqual({});
  h.session.channels.loadOlder("room");
  await vi.waitFor(() =>
    expect(h.session.channels.window("room").rows).toHaveLength(40),
  );
  expect(h.session.channels.window("room").rows.map(({ id }) => id)).toEqual(
    rows.slice(20).map(({ id }) => id),
  );
  const cursorReads = h.query.mock.calls.flatMap(([filters]) =>
    filters.filter((filter) => filter.until !== undefined),
  );
  expect(cursorReads).toHaveLength(1);
  expect(cursorReads[0]).toMatchObject({
    until: rows[40]?.created_at,
    before_id: rows[40]?.id,
    limit: 20,
  });
});

it.each([5, 9005])(
  "later kind-%s deletions resolve repair-only evidence without seeding a window",
  async (kind) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "repair only", 11);
    h.query.mockImplementation(async (filters) =>
      filters[0]?.kinds?.includes(9) ? [row] : [],
    );
    await h.session.unread.ensure();
    expect(h.snapshot().observedCount).toBe(1);
    const window = h.session.channels.window("room");
    expect(window.rows).toHaveLength(0);
    const deletion = (author: typeof h.alice, ids = [row.id]) =>
      signed(author, {
        kind,
        content: "",
        tags: [["h", "room"], ...ids.map((id) => ["e", id])],
      });
    h.emit([deletion(h.viewer)]);
    expect(h.snapshot().observedCount).toBe(1);
    h.emit([deletion(h.alice, [row.id, "f".repeat(64)])]);
    expect(h.snapshot().observedCount).toBe(1); // Explicit #h cannot launder an unknown target.
    h.emit([deletion(h.alice)]);
    expect(h.snapshot().observedCount).toBe(0);
    expect(h.session.channels.window("room")).toBe(window);
  },
);

it("a deletion cannot use revoked unread evidence to delete an accessible target", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const hidden = message(h.alice, "room", "private", 11);
  const visible = message(h.alice, "other", "accessible", 12);
  h.query.mockImplementation(async (filters) =>
    filters[0]?.kinds?.includes(9) ? [hidden, visible] : [],
  );
  await h.session.unread.ensure();
  h.emit([roster(h.relay, "room", [], 20)]);
  const deletion = signed(h.alice, {
    kind: 5,
    content: "",
    tags: [
      ["h", "other"],
      ["e", visible.id],
      ["e", hidden.id],
    ],
  });
  h.emit([deletion]);
  expect(h.snapshot().observedCount).toBeNull();
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: "other" })
      .observedCount,
  ).toBe(1);
  h.grant("room", 21);
  await h.session.unread.refresh();
  expect(h.snapshot().observedCount).toBe(1);
});

it("promotes mentions, broadcasts and participating-thread replies without promoting ordinary unread", () => {
  const h = setup();
  h.grant("room");
  const root = message(h.viewer, "room", "root", 10);
  const ordinary = message(h.alice, "room", "ordinary", 11);
  h.emit([root, ordinary]);
  expect(h.snapshot()).toMatchObject({ observedCount: 1, attentionCount: 0 });

  const mentioned = message(h.alice, "room", "mentioned", 12, [
    ["p", h.viewer.pubkey],
  ]);
  const broadcast = message(h.alice, "room", "broadcast", 13, [
    ["e", root.id, "", "reply"],
    ["broadcast", "1"],
  ]);
  const participatingReply = message(h.alice, "room", "reply", 14, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([mentioned, broadcast, participatingReply]);
  expect(h.snapshot()).toMatchObject({ observedCount: 4, attentionCount: 3 });
});

it("late DM metadata updates an existing attention selector without expiring reading intent", async () => {
  const h = setup();
  h.grant("room");
  await h.session.unread.ensure(); // Settle initialization; no later read-state activity can mask invalidation.
  const row = message(h.alice, "room", "dm", 11);
  h.emit([row]);
  const before = h.snapshot();
  expect(before).toMatchObject({ observedCount: 1, attentionCount: 0 });
  const changed = vi.fn();
  h.session.unread.subscribe(h.target, changed);
  const reading = h.session.unread.reading("room");
  h.emit([
    signed(h.relay, {
      kind: 39000,
      content: "",
      created_at: 20,
      tags: [
        ["d", "room"],
        ["name", "room"],
        ["t", "dm"],
      ],
    }),
  ]);
  expect(
    h.session.channels.list().channels.find(({ id }) => id === "room")
      ?.channelType,
  ).toBe("dm");
  expect(h.snapshot()).toMatchObject({ observedCount: 1, attentionCount: 1 });
  expect(h.snapshot()).not.toBe(before);
  expect(changed).toHaveBeenCalledTimes(1);
  await reading.observe([row.id]);
  expect(h.journal()?.state.frontiers[`msg:${row.id}`]).toBe(11);
});

it.each(["lowercase", "uppercase reply", "uppercase root", "last valid"])(
  "thread row projection and unread ancestry agree on %s references",
  async (variant) => {
    const h = setup();
    h.grant("room");
    const root = message(h.viewer, "room", "root", 11);
    const unrelated = message(h.viewer, "room", "unrelated", 11);
    const reference = (id: string) =>
      variant === "lowercase" ? id : id.toUpperCase();
    const tags = (parentId: string) => [
      ...(variant === "last valid"
        ? [
            ["e", unrelated.id, "", "root"],
            ["e", unrelated.id, "", "reply"],
          ]
        : []),
      ...(variant === "uppercase root" || variant === "last valid"
        ? [["e", reference(root.id), "", "root"]]
        : []),
      ["e", reference(parentId), "", "reply"],
      ...(variant === "last valid"
        ? [
            ["e", "invalid", "", "root"],
            ["e", "invalid", "", "reply"],
          ]
        : []),
    ];
    const broadcast = message(h.viewer, "room", "broadcast", 12, [
      ...tags(root.id),
      ["broadcast", "1"],
    ]);
    const reply = message(h.alice, "room", "unread", 13, tags(broadcast.id));
    h.emit([root, unrelated, broadcast, reply]);
    const row = foldMessages("room", h.relay.pubkey, [broadcast])[0];
    assert(row?.threadRootId);
    expect(row.threadRootId).toBe(root.id);
    const target = {
      kind: "thread" as const,
      channelId: "room",
      rootId: row.threadRootId,
    };
    expect(h.session.unread.snapshot(target)).toMatchObject({
      observedCount: 1,
      attentionCount: 1,
      coverage: "observed",
    });
    expect(h.query).not.toHaveBeenCalled();
    await h.session.unread.markThrough(target, reply.id);
    expect(h.journal()?.state.frontiers).toEqual({ [`thread:${root.id}`]: 13 });
    expect(h.session.unread.snapshot(target).observedCount).toBe(0);
    expect(h.snapshot().observedCount).toBe(0); // Inherited thread frontier agrees too.
    const reading = h.session.unread.reading("room");
    await reading.observe([reply.id]);
    reading.dispose();
    expect(h.journal()?.state.frontiers).toEqual({ [`thread:${root.id}`]: 13 });
  },
);

it("groups unread thread activity by same-channel root and clears one item without clearing unrelated or manual unread", async () => {
  const h = setup();
  h.grant("room");
  const firstRoot = message(h.viewer, "room", "first root", 10);
  const secondRoot = message(h.viewer, "room", "second root", 11);
  const firstReply = message(h.alice, "room", "first reply", 12, [
    ["e", firstRoot.id, "", "reply"],
  ]);
  const latestFirstReply = message(h.alice, "room", "latest first reply", 14, [
    ["e", firstReply.id, "", "reply"],
  ]);
  const secondReply = message(h.alice, "room", "second reply", 13, [
    ["e", secondRoot.id, "", "reply"],
  ]);
  h.emit([
    firstRoot,
    secondRoot,
    firstReply,
    latestFirstReply,
    secondReply,
    message(h.alice, "room", "ordinary top level", 15),
  ]);

  expect(h.session.unread.activity("room")).toMatchObject({
    channelId: "room",
    coverage: "observed",
    freshness: "observed",
    items: [
      {
        channelId: "room",
        rootId: firstRoot.id,
        latestMessageId: latestFirstReply.id,
        authorId: h.alice.pubkey,
        createdAt: 14,
        preview: "latest first reply",
        unreadCount: 2,
      },
      {
        channelId: "room",
        rootId: secondRoot.id,
        latestMessageId: secondReply.id,
        authorId: h.alice.pubkey,
        createdAt: 13,
        preview: "second reply",
        unreadCount: 1,
      },
    ],
  });

  await h.session.unread.markUnreadLocal(h.target);
  await h.session.unread.markThrough(
    { kind: "thread", channelId: "room", rootId: firstRoot.id },
    latestFirstReply.id,
  );

  expect(h.session.unread.activity("room").items).toEqual([
    expect.objectContaining({
      rootId: secondRoot.id,
      latestMessageId: secondReply.id,
    }),
  ]);
  expect(h.snapshot()).toMatchObject({
    observedCount: 2,
    manual: "local-only",
  });
});

it("activity previews use edited and unwrapped current message content and notify subscribers", () => {
  const h = setup();
  h.grant("room");
  const root = message(h.viewer, "room", "root", 10);
  const reply = message(h.alice, "room", "ORIGINAL", 11, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply]);
  const before = h.session.unread.activity("room");
  const changes: ThreadActivitySnapshot[] = [];
  h.session.unread.subscribeActivity("room", () =>
    changes.push(h.session.unread.activity("room")),
  );
  h.emit([
    signed(h.alice, {
      kind: 40003,
      content: "EDITED",
      tags: [["e", reply.id]],
    }),
  ]);
  expect(h.session.unread.activity("room")).not.toBe(before);
  expect(h.session.unread.activity("room").items?.[0]?.preview).toBe("EDITED");
  expect(changes.at(-1)?.items?.[0]?.preview).toBe("EDITED");

  const agentReply = signed(h.alice, {
    kind: 40002,
    content: JSON.stringify({ content: "unwrapped hello" }),
    tags: [
      ["h", "room"],
      ["e", root.id, "", "reply"],
    ],
    created_at: 12,
  });
  h.emit([agentReply]);
  expect(h.session.unread.activity("room").items?.[0]).toMatchObject({
    latestMessageId: agentReply.id,
    preview: "unwrapped hello",
  });
});

it("resolves every activity item through its own channel hierarchy", () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const roomRoot = message(h.viewer, "room", "room root", 10);
  const otherRoot = message(h.viewer, "other", "other root", 10);
  const valid = message(h.alice, "room", "room reply", 12, [
    ["e", roomRoot.id, "", "reply"],
  ]);
  const foreign = message(h.alice, "room", "foreign ancestry", 13, [
    ["e", otherRoot.id, "", "reply"],
  ]);
  h.emit([roomRoot, otherRoot, valid, foreign]);

  expect(h.session.unread.activity("room").items).toEqual([
    expect.objectContaining({
      rootId: roomRoot.id,
      latestMessageId: valid.id,
    }),
  ]);
  expect(h.session.unread.activity("other").items).toEqual([]);
});

it("distinguishes unknown thread-activity evidence from observed evidence", () => {
  const h = setup();
  h.grant("room");
  expect(h.session.unread.activity("room")).toMatchObject({
    channelId: "room",
    items: null,
    coverage: "unknown",
    freshness: "unknown",
  });
  const root = message(h.viewer, "room", "root", 10);
  const reply = message(h.alice, "room", "retained reply", 11, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply]);
  expect(h.session.unread.activity("room")).toMatchObject({
    items: [expect.objectContaining({ latestMessageId: reply.id })],
    coverage: "observed",
    freshness: "observed",
  });
});

it("canonical unread ancestry still requires retained same-channel content", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const root = message(h.viewer, "room", "root", 11);
  const foreign = message(h.viewer, "other", "foreign", 11, [
    ["e", root.id.toUpperCase(), "", "reply"],
  ]);
  const unretained = message(h.viewer, "room", "unretained", 11, [
    ["e", root.id.toUpperCase(), "", "reply"],
  ]);
  const replies = [foreign, unretained].map((parent) =>
    message(h.alice, "room", parent.content, 12, [
      ["e", parent.id.toUpperCase(), "", "reply"],
    ]),
  );
  const rootOnly = message(h.alice, "room", "not a reply", 12, [
    ["e", root.id.toUpperCase(), "", "root"],
  ]);
  h.emit([root, foreign, rootOnly, ...replies]);
  const target = {
    kind: "thread" as const,
    channelId: "room",
    rootId: root.id,
  };
  expect(h.session.unread.snapshot(target).observedCount).toBe(0);
  for (const reply of replies)
    await expect(
      h.session.unread.markThrough(target, reply.id),
    ).rejects.toThrow("does not belong");
  expect(h.journal()?.state.frontiers ?? {}).toEqual({});
});

it("individual reply visibility leaves unseen siblings and the channel prefix untouched", async () => {
  const h = setup();
  h.grant("room");
  const root = message(h.alice, "room", "root", 11);
  const reply = message(h.alice, "room", "visible", 12, [
    ["e", root.id, "", "reply"],
  ]);
  const sibling = message(h.alice, "room", "unseen", 12, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply, sibling]);
  const handle = h.session.unread.reading("room");
  await handle.observe([reply.id]);
  expect(h.journal()?.state.frontiers).toEqual({ [`msg:${reply.id}`]: 12 });
  expect(h.snapshot().observedCount).toBe(2);
  expect(
    h.session.unread.snapshot({
      kind: "thread",
      channelId: "room",
      rootId: root.id,
    }).observedCount,
  ).toBe(1);
  await expect(
    h.session.unread.markThrough(h.target, reply.id),
  ).rejects.toThrow("reply");
  handle.dispose();
});

it.each([false, true])(
  "deletions/auxiliary events neither create counts nor depend on batch order (%s)",
  (reverse) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "deleted", 11);
    const deletion = signed(h.alice, {
      kind: 5,
      content: "",
      tags: [["e", row.id]],
    });
    const edit = signed(h.alice, {
      kind: 40003,
      content: "edited",
      tags: [["e", row.id]],
    });
    h.emit(reverse ? [deletion, edit, row] : [row, edit, deletion]);
    expect(h.snapshot().observedCount).toBe(0);
  },
);

it("a forged-author deletion does not hide a message", () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "retained", 11);
  h.emit([
    row,
    signed(h.viewer, { kind: 5, content: "", tags: [["e", row.id]] }),
  ]);
  expect(h.snapshot().observedCount).toBe(1);
});

it("all projections are denied before any revocation subscriber runs; durable intent survives", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "private", 11);
  h.emit([row]);
  await h.session.unread.markUnreadLocal(h.target);
  const exposed: (number | null)[] = [];
  h.session.profiles.subscribe(() => exposed.push(h.snapshot().observedCount));
  h.session.unread.subscribe(h.target, () =>
    exposed.push(h.snapshot().observedCount),
  );
  h.emit([roster(h.relay, "room", [], 20)]);
  expect(h.snapshot()).toMatchObject({ observedCount: null, manual: "none" });
  expect(exposed.length).toBeGreaterThan(0);
  expect(exposed.every((value) => value === null)).toBe(true);
  expect(h.journal()?.localUnread.room).toBeGreaterThan(0);
  h.grant("room", 21);
  expect(h.snapshot().observedCount).toBeNull();
});

it.each(["dispose", "revoke-regrant", "delete"])(
  "pending reading cannot outlive %s",
  async (action) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "visible", 11);
    h.emit([row]);
    await flush();
    const handle = h.session.unread.reading("room"),
      release = h.holdSave();
    const reading = handle.observe([row.id]);
    const result = reading.catch(() => {});
    await flush();
    if (action === "dispose") handle.dispose();
    if (action === "revoke-regrant") {
      h.emit([roster(h.relay, "room", [], 20)]);
      h.grant("room", 21);
    }
    if (action === "delete")
      h.emit([
        signed(h.alice, { kind: 5, content: "", tags: [["e", row.id]] }),
      ]);
    release();
    await result;
    expect(h.journal()?.state.frontiers).toEqual({});
  },
);

it("rejects manual unread targets whose signed message belongs to a different channel", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const row = message(h.alice, "other", "other channel", 11);
  h.emit([row]);
  await expect(
    h.session.unread.markUnreadLocal({
      kind: "message",
      channelId: "room",
      messageId: row.id,
    }),
  ).rejects.toThrow();
});

it("late reading leases cannot clear a newer manual unread action", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "visible", 11);
  h.emit([row]);
  const handle = h.session.unread.reading("room");
  await h.session.unread.markUnreadLocal(h.target);
  await handle.observe([row.id]);
  expect(h.journal()?.state.frontiers).toEqual({});
  expect(h.snapshot().manual).toBe("local-only");
});

it("reverified cache restore hands evidence to unread before exposing rows without network content", async () => {
  let saved: SavedHead[] = [];
  const h = setup({
    prepared: true,
    persistence: {
      read: async () => saved.slice(),
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close() {},
    },
  });
  const row = message(h.alice, "room", "cached readable message", 11);
  saved = [
    {
      channelId: "room",
      savedAt: Date.now(),
      events: [
        row,
        bounds(h.relay, "room", "head", { has_more: false, next_cursor: null }),
      ],
      profiles: [],
    },
  ];
  h.query.mockImplementation(async (filters) => {
    if (filters[0]?.kinds?.includes(39002))
      return [roster(h.relay, "room", [h.viewer.pubkey], 10)];
    if (filters[0]?.kinds?.includes(39000))
      return [metadata(h.relay, "room", "room", 10)];
    return new Promise(() => {}); // No network content can supply the missing evidence.
  });
  h.session.channels.ensureList();
  h.session.channels.ensure("room");
  const seen: (number | null)[] = [];
  const stop = h.session.channels.subscribeWindow("room", () => {
    if (h.session.channels.window("room").rows.length)
      seen.push(h.snapshot().observedCount);
  });
  await vi.waitFor(() =>
    expect(h.session.channels.window("room").rows).toHaveLength(1),
  );
  expect(seen).toContain(1);
  expect(h.snapshot().observedCount).toBe(1);
  h.emit([signed(h.viewer, { kind: 5, content: "", tags: [["e", row.id]] })]);
  expect(h.snapshot().observedCount).toBe(1);
  h.emit([signed(h.alice, { kind: 5, content: "", tags: [["e", row.id]] })]);
  expect(h.snapshot().observedCount).toBe(0);
  stop();
});

it("explicit read clears local manual unread", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "readable", 11);
  h.emit([row]);
  await h.session.unread.markUnreadLocal(h.target);
  await h.session.unread.markThrough(h.target, row.id);
  expect(h.journal()?.localUnread.room).toBeUndefined();
  expect(h.journal()?.state.frontiers.room).toBe(11);
});

it.each(["clear", "revoke-regrant"])(
  "reentrant cache-restore subscriber %s fences row publication",
  async (action) => {
    let saved: SavedHead[] = [];
    const h = setup({
      prepared: true,
      persistence: {
        read: async () => saved.slice(),
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close() {},
      },
    });
    const row = message(h.alice, "room", "cached readable message", 11);
    saved = [
      {
        channelId: "room",
        savedAt: Date.now(),
        events: [
          row,
          bounds(h.relay, "room", "head", {
            has_more: false,
            next_cursor: null,
          }),
        ],
        profiles: [],
      },
    ];
    h.query.mockImplementation(async (filters) => {
      if (filters[0]?.kinds?.includes(39002))
        return [roster(h.relay, "room", [h.viewer.pubkey], 10)];
      if (filters[0]?.kinds?.includes(39000))
        return [metadata(h.relay, "room", "room", 10)];
      return new Promise(() => {}); // No network content can supply the missing evidence.
    });
    let triggered = false;
    const stopUnread = h.session.unread.subscribe(h.target, () => {
      if (triggered || h.snapshot().observedCount !== 1) return;
      triggered = true;
      saved = [];
      if (action === "clear") void h.clearCache();
      else {
        h.emit([roster(h.relay, "room", [], 20)]);
        h.grant("room", 21);
      }
    });
    h.session.channels.ensureList();
    h.session.channels.ensure("room");
    const seen: (number | null)[] = [];
    const stop = h.session.channels.subscribeWindow("room", () => {
      if (h.session.channels.window("room").rows.length)
        seen.push(h.snapshot().observedCount);
    });
    await vi.waitFor(() => expect(triggered).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.session.channels.ensure("room");
    expect(seen).toEqual([]);
    expect(h.session.channels.window("room").rows).toHaveLength(0);
    stopUnread();
    stop();
  },
);

it.each([5, 9005])(
  "live kind-%s multi-channel deletion updates subscribed and dormant unread projections together",
  async (kind) => {
    const h = setup();
    h.grant("room");
    h.grant("other");
    await h.session.unread.ensure();
    const rows = ["room", "other"].map((id) =>
      message(h.alice, id, "delete together", 11),
    );
    h.emit(rows);
    const other = { kind: "channel" as const, channelId: "other" };
    const otherRow = rows[1];
    assert(otherRow);
    const dormant = {
      kind: "message" as const,
      channelId: "other",
      messageId: otherRow.id,
    };
    expect(h.session.unread.snapshot(other).observedCount).toBe(1);
    expect(h.session.unread.snapshot(dormant).observedCount).toBe(1);
    const seen: (number | null)[][] = [];
    h.session.unread.subscribe(h.target, () =>
      seen.push([
        h.session.unread.snapshot(other).observedCount,
        h.session.unread.snapshot(dormant).observedCount,
      ]),
    );
    h.session.unread.subscribe(other, () => {});
    h.emit([
      signed(h.alice, {
        kind,
        content: "",
        tags: rows.map((row) => ["e", row.id]),
      }),
    ]);
    expect(seen).toEqual([[0, 0]]);
  },
);
