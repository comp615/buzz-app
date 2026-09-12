import { useChannelPanels } from "./useChannelPanels";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import { UnreadBadge, UnreadOptions } from "./UnreadBadge";
import { ChannelActivityPopover } from "./ChannelActivityPopover";
import { SidebarUnread } from "./SidebarUnread";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Hash,
  Search,
  MoreHorizontal,
  PlugZap,
  MessageCircle,
  Users,
} from "lucide-react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { PanelCard } from "../../features/panels/PanelCard";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { OutboxStatus } from "./OutboxStatus";
import { RelayTimings } from "./RelayTimings";
import { LiveStatus } from "./LiveStatus";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { readView, writeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useSidebarPreferences } from "./useSidebarPreferences";
import { useSidebarView } from "./useSidebarView";
import { sidebarSections } from "./sidebar-sections";
import styles from "./Channels.module.css";

export function ChannelsPage({
  extensions,
  relay,
  panels,
  companion,
  navigation,
  navigator,
}: {
  extensions?: ConversationExtensions | undefined;
  relay: RelayData;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  panels: Panels;
  companion?: ReactNode;
}) {
  const session = useRelayConnection(relay);
  const sessionNavigation = navigation?.forSession(relay, session);
  useEffect(() => {
    if (!navigation || !sessionNavigation) return;
    if (
      navigation.target.kind === "conversation" &&
      navigation.target.messageId
    )
      sessionNavigation.complete({ status: "failed", reason: "unavailable" });
    else if (
      session.status === "disconnected" &&
      navigation.target.kind === "page"
    )
      sessionNavigation.complete({ status: "opened" });
    else if (session.status === "error")
      sessionNavigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, sessionNavigation, session.status]);
  return (
    <section className={styles.root} aria-label="Channels">
      {session.status !== "ready" ? (
        <PanelFrame companion={companion}>
          <div className={styles.connect}>
            <div className={styles.connectIcon}>
              <PlugZap size={30} />
            </div>
            <h1>Your channels, one conversation.</h1>
            <p>
              {session.status === "connecting"
                ? "Connecting to your relay…"
                : (session.error ??
                  "Use Switch community at the top left to choose or add a community. Your profile and settings work without a community.")}
            </p>
            {session.status === "error" && (
              <>
                <button type="button" onClick={relay.retry}>
                  Connect relay
                </button>
                <p className={styles.note}>
                  For development, set <code>BUZZ_DEV_VIEWER</code> to your Buzz
                  public key in <code>.env.local</code>, then restart{" "}
                  <code>just web</code> or <code>just desktop</code>. See
                  README.md for requirements.
                </p>
              </>
            )}
          </div>
        </PanelFrame>
      ) : (
        <ChannelWorkspace
          extensions={extensions}
          key={`${session.scope ?? "disconnected"}:${session.generation}`}
          scope={session.scope ?? "disconnected"}
          queries={session.session}
          relay={relay}
          navigation={sessionNavigation}
          navigator={navigator}
          viewer={session.viewer}
          panels={panels}
          companion={companion}
        />
      )}
    </section>
  );
}

function ChannelWorkspace({
  extensions,
  queries,
  relay,
  panels,
  scope,
  companion,
  navigation,
  navigator,
  viewer,
}: {
  extensions?: ConversationExtensions | undefined;
  companion?: ReactNode;
  scope: string;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  viewer?: string | undefined;
  queries: RelaySession;
  relay: RelayData;
  panels: Panels;
}) {
  const list = useChannelList(queries.channels);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  useEffect(() => {
    if (list.status === "ready") void queries.unread.ensure();
  }, [queries, list.status]);
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    readView(scope, "selected-channel", undefined),
  );
  const navigate = useCallback(
    (id: string) => {
      setSelected(id);
      writeView(scope, "selected-channel", id);
      if (navigator && viewer) {
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      }
    },
    [navigator, viewer, scope],
  );
  const [thread, setThread] = useState<{
    channelId: string;
    messageId: string;
  }>();
  const select = useCallback(
    (id: string) => {
      navigate(id);
      setThread(undefined);
    },
    [navigate],
  );
  const threadTrigger = useRef<HTMLElement | null>(null);
  const [sent, setSent] = useState<{ channelId: string; id: string }>();
  const sidebar = useSidebarView(
    scope,
    list.status === "ready" && preferences.status !== "loading",
  );
  const { search } = sidebar;
  const channels = useChannelLabels(list.channels, queries.profiles);
  const requestedChannel =
    navigation?.target.kind === "conversation"
      ? navigation.target.channelId
      : undefined;
  const current = requestedChannel
    ? (channels.find((channel) => channel.id === requestedChannel) ??
      (list.coverage === "partial"
        ? { id: requestedChannel, name: "Conversation" }
        : undefined))
    : (channels.find((channel) => channel.id === selected) ?? channels[0]);
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    if (requestedChannel && list.status === "ready" && !current)
      navigation?.complete({ status: "failed", reason: "unavailable" });
    if (!requestedChannel && !current && list.status === "ready")
      navigation?.complete({ status: "opened" });
    if (!requestedChannel && current && navigation && viewer) {
      // Resolve the saved default within this attempt, keeping its caller and deadline.
      navigation.resolve({
        version: 1,
        kind: "conversation",
        channelId: current.id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    }
  }, [requestedChannel, current, list.status, navigation, viewer, scope]);
  const showingThread = thread?.channelId === current?.id ? thread : undefined;
  useEffect(() => {
    if (thread && !showingThread) setThread(undefined);
  }, [thread, showingThread]);
  type Opening = { channelId: string; panel: RegisteredPanel; target: string };
  const [opened, setOpened] = useState<Opening>();
  const opening = useRef<Opening | undefined>(undefined);
  const open = useCallback((next: Opening | undefined) => {
    // Retire callbacks synchronously, before React commits the next opening.
    opening.current = next;
    setOpened(next);
  }, []);
  const panel =
    opened &&
    opened.channelId === current?.id &&
    available.includes(opened.panel)
      ? opened.panel
      : undefined;
  const mounted = useRef(false);
  const channel = useRef(current?.id);
  useLayoutEffect(() => {
    channel.current = current?.id;
  }, [current?.id]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (opened && !panel) open(undefined);
  }, [opened, panel, open]);
  const openThread = useCallback(
    (messageId: string) => {
      if (!current) return;
      threadTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setThread({ channelId: current.id, messageId });
      open(undefined);
    },
    [current, open],
  );
  const openActivityThread = useCallback(
    (channelId: string, rootId: string) => {
      navigate(channelId);
      threadTrigger.current =
        sidebar.list.current?.querySelector<HTMLElement>(
          `[data-channel-id="${CSS.escape(channelId)}"]`,
        ) ?? null;
      setThread({ channelId, messageId: rootId });
      open(undefined);
    },
    [navigate, sidebar.list],
  );
  const closeThread = useCallback(() => {
    setThread(undefined);
    if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  }, []);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    open(undefined);
    if (panelTrigger.current?.isConnected)
      panelTrigger.current.focus({ preventScroll: true });
    else if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  }, [open]);
  // Availability follows active contributions; dispatch still re-resolves at click time.
  const canOpenLink = useCallback(
    (target: string) =>
      available.some((candidate) => {
        try {
          return candidate.matches(target);
        } catch {
          return false;
        }
      }),
    [available],
  );
  const openLink = useCallback(
    (url: string) => {
      const candidate = panels.resolve(url);
      if (current && candidate) {
        panelTrigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        setThread(undefined);
        open({
          channelId: current.id,
          panel: candidate,
          target: url,
        });
        return true;
      }
      return false;
    },
    [panels, current, open],
  );
  const panelActive = () => {
    const connection = relay.snapshot();
    return !!(
      mounted.current &&
      opened &&
      panel &&
      opening.current === opened &&
      channel.current === opened.channelId &&
      panels.snapshot().includes(panel) &&
      connection.status === "ready" &&
      connection.session === queries &&
      !navigation?.signal.aborted
    );
  };
  const panelContext =
    opened && panel
      ? {
          channelId: opened.channelId,
          canOpen: (target: string) => !!panels.resolve(target),
          open: (target: string) => {
            if (!panelActive()) return false;
            const next = panels.resolve(target);
            if (!next) return false;
            // Keep the original conversation trigger for close/focus restoration.
            open({ channelId: opened.channelId, panel: next, target });
            return true;
          },
        }
      : undefined;
  const drawerContext = useMemo(
    () =>
      current && viewer
        ? {
            scope,
            viewer,
            channelId: current.id,
            channelName: current.name,
            relayUrl: scope
              .slice(0, -(viewer.length + 1))
              .replace(/^https:/, "wss:")
              .replace(/^http:/, "ws:"),
            ...(showingThread && { threadId: showingThread.messageId }),
          }
        : undefined,
    [scope, viewer, current, showingThread],
  );
  const drawer = useChannelPanels(panels, drawerContext);
  const visible = useMemo(
    () =>
      channels.filter((channel) =>
        channel.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [channels, search],
  );
  return (
    <div
      className={`${styles.board} ${panel || showingThread || companion ? styles.withPanel : ""}`}
    >
      <aside className={styles.sidebar} aria-label="Channel sidebar">
        <div className={styles.search}>
          <Search size={17} />
          <input
            aria-label="Search channels"
            placeholder="Search"
            value={search}
            onChange={(event) => sidebar.setSearch(event.target.value)}
          />
        </div>
        <SidebarUnread listRef={sidebar.list}>
          {sidebarSections(visible, preferences.data).map((section) => (
            <details
              key={section.key}
              className={styles.channelSection}
              open={!sidebar.collapsed.includes(section.key)}
              onToggle={(event) =>
                sidebar.toggle(section.key, event.currentTarget.open)
              }
            >
              <summary>
                {section.icon && (
                  <span aria-hidden="true">{section.icon} </span>
                )}
                {section.title}
              </summary>
              {section.rows.map((channel) => {
                const Icon =
                  channel.channelType === "dm"
                    ? (channel.participants?.length ?? 0) > 1
                      ? Users
                      : MessageCircle
                    : Hash;
                return (
                  <ChannelActivityPopover
                    key={channel.id}
                    session={queries}
                    channelId={channel.id}
                    channelName={channel.name}
                    onOpenThread={(item) =>
                      openActivityThread(item.channelId, item.rootId)
                    }
                    trigger={
                      <button
                        type="button"
                        title={channel.name}
                        data-channel-id={channel.id}
                        data-channel-type={channel.channelType}
                        aria-current={
                          current?.id === channel.id ? "page" : undefined
                        }
                        onPointerEnter={() =>
                          queries.channels.prepare?.(channel.id)
                        }
                        onFocus={() => queries.channels.prepare?.(channel.id)}
                        onClick={() => select(channel.id)}
                      >
                        <Icon size={17} />
                        <span className={styles.channelLabel}>
                          {channel.name}
                        </span>
                        <UnreadBadge
                          session={queries}
                          channelId={channel.id}
                          dm={channel.channelType === "dm"}
                        />
                      </button>
                    }
                  />
                );
              })}
            </details>
          ))}
          {list.status === "loading" && !list.channels.length && (
            <p className={styles.empty}>Loading your channels…</p>
          )}
          {list.status === "error" && (
            <p role="alert" className={styles.empty}>
              {list.error}
            </p>
          )}
          {list.status === "ready" && !visible.length && (
            <p className={styles.empty}>
              {search ? "No matching channels." : "No channels yet."}
            </p>
          )}
        </SidebarUnread>
        {preferences.status !== "ready" && (
          <div className={styles.preferenceNotice} role="status">
            {preferences.status === "loading"
              ? "Loading saved groups and stars…"
              : preferences.status === "unsupported"
                ? "Saved groups and stars aren’t supported by this host yet."
                : "Couldn’t refresh saved groups and stars. Your conversations are still available."}
            {preferences.status === "error" && (
              <button type="button" onClick={preferences.reload}>
                Retry
              </button>
            )}
          </div>
        )}
      </aside>
      <article className={styles.conversation} aria-label="Conversation">
        <header className={styles.heading}>
          <div className={styles.channelTitle}>
            {current?.channelType === "dm" ? (
              <MessageCircle size={20} />
            ) : (
              <Hash size={20} />
            )}
            <strong>{current?.name ?? "Channels"}</strong>
          </div>
          {drawer.launchers}
          <details className={styles.diagnostics}>
            <summary
              aria-label="Conversation options"
              title="Conversation options"
            >
              <MoreHorizontal size={19} aria-hidden="true" />
            </summary>
            <div className={styles.diagnosticsMenu}>
              <UnreadOptions session={queries} channelId={current?.id} />
              <details>
                <summary>Diagnostics</summary>
                <LiveStatus
                  live={queries.live}
                  channelId={current?.id}
                  partialRoster={list.coverage === "partial"}
                  diagnostics
                />
                <p>
                  {list.coverage === "partial" ? "Partial roster" : "Roster"} ·{" "}
                  {channels.length} channels
                </p>
                <button
                  type="button"
                  onClick={() => queries.channels.refreshList?.()}
                >
                  Refresh channels
                </button>
                {preferences.error && (
                  <p>Saved groups and stars: {preferences.error}</p>
                )}
                {preferences.status !== "unsupported" && (
                  <button
                    type="button"
                    disabled={preferences.status === "loading"}
                    onClick={preferences.reload}
                  >
                    Refresh groups and stars
                  </button>
                )}
                {current && (
                  <button
                    type="button"
                    onClick={() => queries.channels.refresh?.(current.id)}
                  >
                    Refresh messages
                  </button>
                )}
                {queries.outbox ? (
                  <OutboxStatus
                    outbox={queries.outbox}
                    profiling={queries.profiling}
                  />
                ) : (
                  <RelayTimings profiling={queries.profiling} />
                )}
              </details>
            </div>
          </details>
        </header>
        <LiveStatus
          live={queries.live}
          channelId={current?.id}
          partialRoster={list.coverage === "partial"}
        />
        {current ? (
          <ChannelBody
            viewer={viewer}
            extensions={extensions}
            key={current.id}
            queries={queries}
            scope={scope}
            channelId={current.id}
            navigation={navigation}
            onOpenLink={openLink}
            canOpenLink={canOpenLink}
            onOpenThread={openThread}
            revealMessageId={
              sent?.channelId === current.id ? sent.id : undefined
            }
          />
        ) : (
          <div className={styles.empty}>Select a channel to read it.</div>
        )}
        {current && (
          <MessageComposer
            extensions={extensions}
            key={`composer:${current.id}`}
            session={queries}
            scope={scope}
            channelId={current.id}
            channelName={current.name}
            onSend={(id) => setSent({ channelId: current.id, id })}
          />
        )}
        {drawer.content}
      </article>
      {(panel || showingThread || companion) && (
        <div className={styles.panelStack}>
          {showingThread && (
            <ThreadPanel
              extensions={extensions}
              key={`${showingThread.channelId}:${showingThread.messageId}`}
              session={queries}
              scope={scope}
              channelName={current?.name ?? ""}
              channelId={showingThread.channelId}
              messageId={showingThread.messageId}
              close={closeThread}
              onOpenLink={openLink}
              canOpenLink={canOpenLink}
            />
          )}

          {panel && opened && (
            <PanelCard
              key="target"
              panel={panel}
              target={opened.target}
              context={panelContext}
              close={close}
              closeLabel="Close channel panel"
            />
          )}
          {companion && (
            <div key="companion" className={styles.companion}>
              {companion}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelBody({
  viewer,
  extensions,
  scope,
  queries,
  channelId,
  onOpenLink,
  canOpenLink,
  revealMessageId,
  onOpenThread,
  navigation,
}: {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  queries: RelaySession;
  viewer?: string | undefined;
  channelId: string;
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  onOpenThread(messageId: string): void;
}) {
  const window = useChannelWindow(queries.channels, channelId);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    else if (window.status === "error")
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, window.status]);
  if (window.status === "error" && !window.rows.length)
    return (
      <div className={styles.empty} role="alert">
        <p>{window.error}</p>
        <button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </button>
      </div>
    );
  if (window.status !== "ready" && !window.rows.length)
    return (
      <div className={styles.empty} role="status">
        Loading messages…
      </div>
    );
  return (
    <ChannelTimeline
      viewer={viewer}
      extensions={extensions}
      scope={scope}
      channelId={channelId}
      queries={queries}
      window={window}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      onOpenThread={onOpenThread}
      revealMessageId={revealMessageId}
    />
  );
}
