import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Channels.module.css";

export function UnreadBadge({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId: string;
}) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const get = useCallback(
    () => session.unread.snapshot(target),
    [session, target],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const count = snapshot.observedCount;
  const manual = snapshot.manual !== "none";
  if (!manual && !count) return null;
  const attention = (snapshot.attentionCount ?? 0) > 0;
  const label = manual
    ? `Marked unread${snapshot.manual === "local-only" ? " on this device only" : ""}`
    : `${count} observed unread messages${snapshot.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`;
  return (
    <span
      className={styles.unreadBadge}
      data-channel-unread=""
      role="img"
      aria-label={label}
      title={label}
      data-attention={attention}
    >
      {attention ? (manual ? "•" : (count ?? 0) > 99 ? "99+" : count) : null}
    </span>
  );
}
export function UnreadOptions({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId?: string | undefined;
}) {
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const [error, setError] = useState<string>();
  const run = (operation: Promise<unknown>) => {
    setError(undefined);
    void operation.catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Read-state operation failed",
      ),
    );
  };
  return (
    <>
      {channelId && (
        <button
          type="button"
          onClick={() =>
            run(session.unread.markUnreadLocal({ kind: "channel", channelId }))
          }
        >
          Mark unread on this device
        </button>
      )}
      {channelId && sync.capability === "frontier-sync" && (
        <button
          type="button"
          onClick={() => {
            const last = session.channels
              .window(channelId)
              .rows.filter((row) => !row.membership)
              .at(-1);
            if (last)
              run(
                session.unread.markThrough(
                  { kind: "channel", channelId },
                  last.id,
                ),
              );
            else setError("Load a verified message before marking through it.");
          }}
        >
          Mark read through loaded messages
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Unread status</summary>
        <p>
          Observed messages only—not exact totals. Manual unread is local to
          this device. Older read hints can expire; this is not an everlasting
          read receipt log.
        </p>
        <p>
          Read sync: {sync.capability} · {sync.status}
        </p>
        {sync.error && <p role="alert">{sync.error}</p>}
        <button type="button" onClick={() => run(session.unread.refresh())}>
          Refresh unread observations
        </button>
        {sync.capability === "frontier-sync" && (
          <button type="button" onClick={() => run(session.unread.retrySync())}>
            Retry read sync
          </button>
        )}
      </details>
    </>
  );
}
