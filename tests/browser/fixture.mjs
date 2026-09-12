import { fixtureRelayUrl, fixtureAliases } from "../relay-config.ts";
import { test as base, expect } from "@playwright/test";
import { preview } from "vite";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { writeFile } from "node:fs/promises";
import { platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { relayBrokerPlugin } from "../../dev/relay-broker.mjs";
import { policyRelay } from "./policy-relay.mjs";
import { buildApp } from "./build.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const channels = ["alpha", "beta"];
export const historySize = 640;

// The built app, React, services, verification, IndexedDB and Virtua stay real.
// Layout journeys use synthetic broker HTTP; live journeys retain the production
// broker/subscriber and model only the upstream relay policy with ephemeral keys.
export const test = base.extend({
  productionBroker: [false, { option: true }],
  readState: [false, { option: true }],
  threadUnread: [false, { option: true }],
  sidebarUnread: [false, { option: true }],
  savedSidebar: [false, { option: true }],
  expectedPageFailure: [false, { option: true }],
  largeSidebar: [false, { option: true }],
  dmLabels: [false, { option: true }],
  tallMessages: [false, { option: true }],
  membershipActivity: [false, { option: true }],
  developmentReact: [false, { option: true, scope: "worker" }],
  pluginFixtures: [false, { option: true, scope: "worker" }],
  compiledApp: [buildApp, { scope: "worker" }],
  app: async (
    {
      page,
      context,
      browserName,
      browser,
      productionBroker,
      readState,
      threadUnread,
      sidebarUnread,
      savedSidebar,
      expectedPageFailure,
      largeSidebar,
      dmLabels,
      tallMessages,
      membershipActivity,
      pluginFixtures,
      developmentReact,
      compiledApp,
    },
    use,
    testInfo,
  ) => {
    const relayKey = generateSecretKey();
    const userKey = generateSecretKey();
    const viewer = getPublicKey(userKey);
    const membershipKeys = membershipActivity
      ? [generateSecretKey(), generateSecretKey()]
      : [];
    const membershipEvent = (
      type,
      targetIndex,
      time,
      actorIndex = -1,
      forged = false,
    ) =>
      sign(
        40099,
        [["h", "alpha"]],
        JSON.stringify({
          type,
          actor:
            actorIndex < 0 ? viewer : getPublicKey(membershipKeys[actorIndex]),
          target: getPublicKey(membershipKeys[targetIndex]),
        }),
        forged ? userKey : relayKey,
        time,
      );
    const peerKey = dmLabels || readState ? generateSecretKey() : undefined;
    const communityIds = {
      primary: "01234567-89ab-cdef-0123-456789abcdef",
      secondary: "11234567-89ab-cdef-0123-456789abcdef",
    };
    const readEvents = new Map([
      ["primary", new Map()],
      ["secondary", new Map()],
    ]);
    const sign = (
      kind,
      tags,
      content = "",
      key = relayKey,
      time = 1700000000,
    ) => finalizeEvent({ kind, tags, content, created_at: time }, key);
    const participants = largeSidebar
      ? Array.from({ length: 1001 }, (_, i) =>
          (i + 1).toString(16).padStart(64, "0"),
        )
      : peerKey
        ? [getPublicKey(peerKey)]
        : [];
    const dmIds = largeSidebar
      ? Array.from(
          { length: 128 },
          (_, i) => `dm-${i.toString().padStart(3, "0")}`,
        )
      : dmLabels
        ? ["dm-peer"]
        : [];
    const rosterIds = [...channels, ...dmIds];
    if (savedSidebar) {
      const key = nip44.v2.utils.getConversationKey(userKey, viewer);
      for (const community of ["primary", "secondary"]) {
        const records = readEvents.get(community);
        for (const [coordinate, value] of [
          [
            "channel-sections",
            {
              version: 1,
              sections: [{ id: "work", name: "Work", order: 0 }],
              assignments: { beta: "work" },
            },
          ],
          [
            "channel-stars",
            {
              version: 1,
              channels: { alpha: { starred: true, updatedAt: 1 } },
            },
          ],
        ]) {
          records.set(
            coordinate,
            sign(
              30078,
              [["d", coordinate]],
              nip44.v2.encrypt(JSON.stringify(value), key),
              userKey,
            ),
          );
        }
      }
    }
    const hiddenChannels = new Set();
    const streams = new Map();
    const histories = new Map();
    for (const community of ["primary", "secondary"])
      for (const channel of channels)
        histories.set(
          `${community}/${channel}`,
          Array.from(
            { length: channel === "alpha" ? historySize : 80 },
            (_, i) =>
              sign(
                9,
                [["h", channel]],
                `${community} ${channel} message ${i}\n${"Mixed height message content. ".repeat((1 + (i % 7) * 3) * (tallMessages ? 3 : 1))}`,
                readState ? peerKey : userKey,
                1700000100 + i,
              ),
          ),
        );
    for (const community of ["primary", "secondary"])
      for (const id of dmIds) histories.set(`${community}/${id}`, []);
    if (membershipActivity) {
      const history = histories.get("primary/alpha");
      history.push(
        membershipEvent("member_joined", 0, 1700000740),
        membershipEvent("member_joined", 1, 1700000741),
      );
    }
    if (sidebarUnread) {
      for (const id of ["dm-030", "dm-090"])
        histories.set(`primary/${id}`, [
          sign(9, [["h", id]], `Unread in ${id}`, peerKey, 1700000900),
        ]);
    }
    // Opt-in upstream thread evidence: no client cache/read-state injection.
    // Uppercase signed references exercise canonical thread/unread parity.
    const threadReplies = new Map();
    const threadSummaries = [];
    if (threadUnread) {
      const history = histories.get("primary/alpha");
      for (const [index, event] of history.slice(-2).entries()) {
        const root = sign(
          9,
          [["h", "alpha"]],
          `Thread root ${index}`,
          peerKey,
          event.created_at,
        );
        history[history.length - 2 + index] = root;
        const replies = [
          sign(
            9,
            [
              ["h", "alpha"],
              ["e", root.id.toUpperCase(), "", "reply"],
              ["p", viewer],
            ],
            `Unread reply ${index}`,
            peerKey,
            root.created_at + 10,
          ),
        ];
        threadReplies.set(root.id, replies);
        threadSummaries.push(
          sign(
            39005,
            [
              ["h", "alpha"],
              ["e", root.id],
              ["d", root.id],
            ],
            JSON.stringify({
              reply_count: 23,
              participants: [getPublicKey(peerKey)],
            }),
          ),
        );
      }
    }
    if (threadUnread) {
      const history = histories.get("primary/alpha");
      const root = history.at(-2);
      const broadcast = sign(
        9,
        [
          ["h", "alpha"],
          ["e", root.id.toUpperCase(), "", "reply"],
          ["broadcast", "1"],
        ],
        "Broadcast reply",
        peerKey,
        root.created_at + 2,
      );
      history.push(broadcast);
      const replies = threadReplies.get(root.id);
      replies.push(broadcast);
      replies.push(
        sign(
          9,
          [
            ["h", "alpha"],
            ["e", root.id.toUpperCase(), "", "root"],
            ["e", broadcast.id.toUpperCase(), "", "reply"],
          ],
          "Broadcast descendant",
          peerKey,
          root.created_at + 11,
        ),
      );
      threadSummaries.push(
        sign(
          39005,
          [
            ["h", "alpha"],
            ["e", broadcast.id],
            ["d", broadcast.id],
          ],
          JSON.stringify({
            reply_count: 23,
            participants: [getPublicKey(peerKey)],
          }),
        ),
      );
    }
    const report = {
      state: {
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }),
        browserName,
        developmentReact,
        pluginFixtures,
        compiledBuild: {
          worker: testInfo.workerIndex,
          durationMs: compiledApp.durationMs,
        },
        largeSidebar,
        readState,
        sidebarUnread,
        savedSidebar,
        dmLabels,
        tallMessages,
        browserVersion: browser.version(),
        node: process.version,
        platform: platform(),
        arch: arch(),
        viewport: testInfo.project.use.viewport,
        build: `${developmentReact ? "Vite production build with development React" : "production frontend"}; ${productionBroker ? "production broker; modeled upstream WS/HTTP policy" : "fixture broker HTTP"}; no native or real relay`,
      },
      queries: [],
      publications: [],
      readPublications: [],
      sessions: [],
      streamConnections: [],
      errors: [],
      consoleErrors: [],
      unexpected: [],
      measurements: [],
    };
    const pending = [];
    const retiredStreams = new Set();
    const observerFailures = [];
    const consoleLocations = new Map();
    const send = (response, body, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const answer = (community, filter) => {
      if (filter.kinds?.includes(39002))
        return rosterIds.map((id) =>
          sign(39002, [
            ["d", id],
            ["p", viewer],
            ...participants
              .slice(dmIds.indexOf(id) * 8, (dmIds.indexOf(id) + 1) * 8)
              .map((pubkey) => ["p", pubkey]),
          ]),
        );
      if (filter.kinds?.includes(39000))
        return rosterIds.map((id) =>
          sign(39000, [
            ["d", id],
            ["name", id === "alpha" ? "Alpha" : id === "beta" ? "Beta" : id],
            ...(dmIds.includes(id) ? [["t", "dm"], ["hidden"]] : []),
            ...(hiddenChannels.has(id) ? [["hidden"]] : []),
          ]),
        );
      if (filter.kinds?.includes(30078)) {
        const events = [...readEvents.get(community).values()];
        if (readState && filter.read_state_snapshot === 1)
          return {
            read_state_snapshot: 1,
            complete: true,
            community_id: communityIds[community],
            pubkey: viewer,
            snapshot_id: "a".repeat(64),
            events,
          };
        return events.filter(
          (event) =>
            filter["#t"]?.includes("read-state") ||
            filter["#d"]?.includes(event.tags.find(([k]) => k === "d")?.[1]),
        );
      }
      if (filter.kinds?.includes(30030)) {
        expect(filter).toEqual({
          kinds: [30030],
          "#d": ["buzz:custom-emoji"],
          limit: 500,
        });
        return [];
      }
      if (filter.kinds?.includes(0))
        return [
          sign(0, [], JSON.stringify({ name: "Fixture Reader" }), userKey),
          ...membershipKeys
            .filter((key) => filter.authors?.includes(getPublicKey(key)))
            .map((key) =>
              sign(
                0,
                [],
                JSON.stringify({
                  name: key === membershipKeys[0] ? "Pinky" : "Brain",
                }),
                key,
              ),
            ),
          ...(peerKey && filter.authors?.includes(getPublicKey(peerKey))
            ? [
                sign(
                  0,
                  [],
                  JSON.stringify({ display_name: "Alice Fixture" }),
                  peerKey,
                ),
              ]
            : []),
        ];
      if (threadUnread && filter.ids)
        return [...histories.values()]
          .flat()
          .filter((event) => filter.ids.includes(event.id));
      if (threadUnread && filter.depth_limit)
        return (threadReplies.get(filter["#e"]?.[0]) ?? [])
          .filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor ||
              (event.created_at === filter.thread_cursor &&
                event.id > filter.thread_cursor_id),
          )
          .slice(0, filter.limit);
      // Unread evidence is not a top-level window, even for a one-ID final batch.
      if (
        filter.kinds?.includes(9) &&
        !filter.top_level &&
        filter["#h"]?.length
      )
        return filter["#h"]
          .flatMap((channel) => [
            ...(histories.get(`${community}/${channel}`) ?? []),
            ...(threadUnread && community === "primary" && channel === "alpha"
              ? [...threadReplies.values()].flat()
              : []),
          ])
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      const channel = filter["#h"]?.[0];
      const history = histories.get(`${community}/${channel}`);
      if (!history)
        throw new Error(`Unexpected query: ${JSON.stringify(filter)}`);
      const candidates = history
        .filter((event) => !filter.kinds || filter.kinds.includes(event.kind))
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until && event.id > filter.before_id),
        )
        .toSorted(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      const events = candidates.slice(0, filter.limit);
      const hasMore = candidates.length > events.length;
      const last = events.at(-1);
      const suffix =
        filter.until === undefined
          ? "head"
          : `${filter.until}:${filter.before_id}`;
      return filter.include_aux
        ? [
            ...events,
            ...threadSummaries.filter((summary) =>
              events.some((event) =>
                summary.tags.some(
                  ([key, value]) => key === "e" && value === event.id,
                ),
              ),
            ),
            sign(
              39006,
              [
                ["h", channel],
                ["d", `${channel}:${suffix}`],
              ],
              JSON.stringify({
                has_more: hasMore,
                next_cursor: hasMore
                  ? { created_at: last.created_at, id: last.id }
                  : null,
              }),
            ),
          ]
        : events;
    };
    const relay = productionBroker
      ? policyRelay({
          viewer,
          answer,
          report,
          pending,
          ...(readState
            ? {
                discovery: (community) => ({
                  self: getPublicKey(relayKey),
                  read_state_snapshot: {
                    version: 1,
                    community_id: communityIds[community],
                    max_events: 4096,
                    max_bytes: 8388608,
                  },
                }),
                acceptPublication: (community, event) => {
                  expect(verifyEvent(event)).toBe(true);
                  expect(event.pubkey).toBe(viewer);
                  expect(event.kind).toBe(30078);
                  expect(event.tags).toContainEqual(["t", "read-state"]);
                  const blob = JSON.parse(
                    nip44.v2.decrypt(
                      event.content,
                      nip44.v2.utils.getConversationKey(userKey, viewer),
                    ),
                  );
                  const coordinate = event.tags.find(
                    ([key]) => key === "d",
                  )?.[1];
                  expect(coordinate).toMatch(/^read-state:[0-9a-f]{32}$/);
                  const previous = readEvents.get(community).get(coordinate);
                  if (
                    !previous ||
                    event.created_at > previous.created_at ||
                    (event.created_at === previous.created_at &&
                      event.id < previous.id)
                  )
                    readEvents.get(community).set(coordinate, event);
                  report.readPublications.push({ community, event, blob });
                },
              }
            : {}),
        })
      : undefined;
    const middleware = async (request, response, next) => {
      if (!request.url?.startsWith("/api/relay/")) return next();
      try {
        const parts = request.url.split("/");
        const route = parts.at(-1);
        const requestedCommunity = decodeURIComponent(parts[3]);
        const community =
          requestedCommunity.match(
            /^https:\/\/(primary|secondary)\.(?:example|fixture\.invalid)$/,
          )?.[1] ?? requestedCommunity;
        let raw = "";
        for await (const part of request) raw += part;
        const body = raw ? JSON.parse(raw) : undefined;
        if (route === "identity") return send(response, { viewer });
        if (route === "register") return send(response, {});
        if (!["primary", "secondary"].includes(community))
          throw new Error(`Unexpected community: ${request.url}`);
        if (route === "gif-info" && request.method === "GET")
          return send(response, {});
        if (route === "info" && request.method === "GET")
          return send(response, { policy: null });
        if (route === "session") {
          report.sessions.push(community);
          return send(response, {
            viewer,
            relayAuthor: getPublicKey(relayKey),
            writeKinds: [9],
            relayUrl: JSON.parse(fixtureAliases)[community],
            live: true,
          });
        }
        if (route === "stream") {
          // Match the production broker: WebKit can buffer trailing HTTP chunks.
          // Close-delimited SSE must deliver each append without a later write.
          response.useChunkedEncodingByDefault = false;
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.flushHeaders();
          response.write(
            `event: state\ndata: ${JSON.stringify({ status: "connected", routes: body.channels.map((channelId) => ({ id: `channel:${channelId}`, channelId, status: "live", replay: "unknown" })) })}\n\n`,
          );
          const clients = streams.get(community) ?? new Set();
          streams.set(community, clients);
          clients.add(response);
          report.streamConnections.push({ community, channels: body.channels });
          // The real broker pulses every 15s; the production reader expires
          // streams after 45s without bytes, even while history HTTP is active.
          const heartbeat = setInterval(
            () => response.write(": keepalive\n\n"),
            15000,
          );
          response.on("close", () => {
            clearInterval(heartbeat);
            clients.delete(response);
          });
          return;
        }
        if (route !== "query" || request.method !== "POST")
          throw new Error(
            `Unexpected fixture request: ${request.method} ${request.url}`,
          );
        expect(body).toHaveLength(1);
        const filter = body[0];
        report.queries.push({ community, filter });
        const result = answer(community, filter);
        if (filter.until !== undefined) {
          pending.push({
            community,
            channel: filter["#h"][0],
            filter,
            events: result.filter((event) => event.kind === 9),
            release: () => send(response, result),
          });
        } else send(response, result);
      } catch (error) {
        report.unexpected.push(String(error));
        send(response, { error: String(error) }, 500);
      }
    };
    let server;
    try {
      server = await preview({
        ...compiledApp.config,
        plugins: [
          {
            name: "fixture-relay",
            async configurePreviewServer(server) {
              if (relay) {
                report.brokerRequests = [];
                server.middlewares.use((req, res, next) => {
                  if (req.url?.startsWith("/api/relay/"))
                    report.brokerRequests.push({
                      url: req.url,
                      at: performance.now(),
                    });
                  if (req.url?.endsWith("/stream"))
                    res.once("close", () => {
                      retiredStreams.add(res.getHeader("x-buzz-live-id"));
                    });
                  next();
                });
                const broker = relayBrokerPlugin({
                  relayUrl: fixtureRelayUrl,
                  communityAliases: fixtureAliases,
                  identity: () => userKey.slice(),
                  ...(readState
                    ? {}
                    : {
                        authority: async () => ({
                          relayAuthor: getPublicKey(relayKey),
                        }),
                      }),
                  upstreamFetch: relay.fetch,
                  socketFactory: relay.socket,
                });
                await broker.configureServer(server);
              } else server.middlewares.use(middleware);
            },
          },
        ],
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin)
          return route.continue();
        report.unexpected.push(
          `Blocked external request: ${route.request().url()}`,
        );
        return route.abort();
      });
      await context.routeWebSocket("**/*", (socket) => {
        report.unexpected.push(`Blocked WebSocket: ${socket.url()}`);
        socket.close();
      });
      page.on("pageerror", (error) => report.errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleLocations.set(
            report.consoleErrors.length,
            message.location().url,
          );
          report.consoleErrors.push(message.text());
        }
      });
      page.on("response", (response) => {
        if (
          response.url().endsWith("/stream-observer") &&
          response.status() === 404
        ) {
          const { streamId } = response.request().postDataJSON();
          observerFailures.push({
            streamId,
            url: response.url(),
            retired: retiredStreams.has(streamId),
          });
        }
      });
      await page.addInitScript(
        ({ viewer }) => {
          const key = `buzz-client.v1:${viewer}`;
          if (!localStorage.getItem(key))
            localStorage.setItem(
              key,
              JSON.stringify({
                profile: { name: "Browser Fixture", picture: "" },
                memberships: [
                  { id: "primary", name: "Primary" },
                  { id: "secondary", name: "Secondary" },
                ],
                selected: "primary",
              }),
            );
        },
        { viewer },
      );
      await use({
        origin,
        report,
        pending,
        histories,
        membership(
          type,
          targetIndex,
          actorIndex = -1,
          forged = false,
          deliver = true,
        ) {
          const history = histories.get("primary/alpha");
          const event = membershipEvent(
            type,
            targetIndex,
            history.at(-1).created_at + 1,
            actorIndex,
            forged,
          );
          history.push(event);
          if (!deliver) return event;
          if (relay) relay.publish("primary", event);
          else
            for (const client of streams.get("primary") ?? [])
              client.write(`data: ${JSON.stringify(event)}\n\n`);
          return event;
        },
        participants,
        viewer,
        relay,
        observer(raw, agentKey, community = "primary") {
          const agent = getPublicKey(agentKey);
          const plaintext = JSON.stringify(raw);
          const event = sign(
            24200,
            [
              ["p", viewer],
              ["agent", agent],
              ["frame", "telemetry"],
            ],
            nip44.v2.encrypt(
              plaintext,
              nip44.v2.utils.getConversationKey(agentKey, viewer),
            ),
            agentKey,
            Math.floor(Date.now() / 1000),
          );
          relay.observer(community, event);
          return { event, plaintext, agent };
        },
        // Change only modeled relay state. The app must consume the next real
        // roster response; this does not call client purge/recovery internals.
        hideChannel(id) {
          expect(rosterIds).toContain(id);
          hiddenChannels.add(id);
        },
        omitChannel(id) {
          expect(rosterIds).toContain(id);
          rosterIds.splice(rosterIds.indexOf(id), 1);
        },
        edit(community, channel, target, content) {
          const event = sign(
            40003,
            [
              ["h", channel],
              ["e", target.id],
            ],
            content,
            userKey,
            target.created_at + 1,
          );
          report.publications.push({
            id: event.id,
            target: target.id,
            kind: event.kind,
            frameBytes: Buffer.byteLength(`data: ${JSON.stringify(event)}\n\n`),
          });
          if (relay) relay.publish(community, event);
          else {
            expect(streams.get(community)?.size).toBeGreaterThan(0);
            for (const client of streams.get(community))
              client.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return event;
        },
        reply(rootId, own = false) {
          const replies = threadReplies.get(rootId);
          if (!replies) throw new Error("Unknown fixture thread");
          const event = sign(
            9,
            [
              ["h", "alpha"],
              ["e", rootId, "", "reply"],
            ],
            own ? "My reply" : "New peer reply",
            own ? userKey : peerKey,
            replies.at(-1).created_at + 1,
          );
          replies.push(event);
          relay.publish("primary", event);
          return event;
        },
        append(community, channel, content, deliver = true, own = true) {
          const history = histories.get(`${community}/${channel}`);
          const event = sign(
            9,
            [["h", channel]],
            content ?? `Live append ${history.length}`,
            own ? userKey : peerKey,
            (history.at(-1)?.created_at ?? 1700000900) + 1,
          );
          history.push(event);
          if (relay && deliver) relay.publish(community, event);
          else if (relay) return event;
          else {
            expect(streams.get(community)?.size).toBeGreaterThan(0);
            for (const client of streams.get(community))
              client.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return event;
        },
      });
      expect(report.unexpected).toEqual([]);
      // Aborted startup streams can race an already-dispatched observer control.
      // Permit only 404s whose exact stream was already closed by the real host;
      // a current/unknown stream failure still fails, and all errors stay recorded.
      report.retiredObserverControls = [...observerFailures];
      expect(observerFailures.every((failure) => failure.retired)).toBe(true);
      const retiredConsole = (message, index) => {
        if (
          !/^Failed to load resource: the server responded with a status of 404/.test(
            message,
          )
        )
          return false;
        const match = observerFailures.findIndex(
          (failure) => failure.url === consoleLocations.get(index),
        );
        if (match < 0) return false;
        observerFailures.splice(match, 1);
        return true;
      };
      expect(
        report.consoleErrors.filter(
          (message, index) =>
            !retiredConsole(message, index) &&
            !(
              expectedPageFailure &&
              message.includes("Fixture page render failure")
            ) &&
            !(
              relay?.expectedHttpErrors() &&
              /^Failed to load resource: the server responded with a status of 429/.test(
                message,
              )
            ),
        ),
      ).toEqual([]);
      // Existing WebKit observer warning is recorded, never silently swallowed.
      expect(
        report.errors.filter(
          (message) =>
            !(
              browserName === "webkit" &&
              message ===
                "ResizeObserver loop completed with undelivered notifications."
            ),
        ),
      ).toEqual([]);
    } finally {
      await writeFile(
        testInfo.outputPath("evidence.json"),
        JSON.stringify(report, null, 2),
      );
      await testInfo.attach("browser-evidence", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      await page.close();
      for (const clients of streams.values())
        for (const response of clients) response.end();
      if (server) {
        server.httpServer.closeAllConnections();
        await new Promise((resolve) => server.httpServer.close(resolve));
      }
    }
  },
});
export { expect };
