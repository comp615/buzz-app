import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import styles from "./Messages.module.css";

/** Shared presentation only. Mounting more consumers creates no relay work. */
export function TypingIndicator({
  session,
  channelId,
  threadRootId,
}: {
  session: RelaySession;
  channelId: string;
  threadRootId?: string | undefined;
}) {
  const entries = useSyncExternalStore(
    session.typing.subscribe,
    session.typing.snapshot,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const matching = entries.filter(
    (entry) =>
      entry.channelId === channelId && entry.threadRootId === threadRootId,
  );
  // Reuse already available names; optional typing must not trigger profile reads.
  const names = matching
    .slice(0, 3)
    .map(({ pubkey }) => profiles.get(pubkey)?.name ?? pubkey.slice(0, 10));
  const others = matching.length - names.length;
  return (
    <div className={styles.typing}>
      {matching.length > 0 && (
        <span role="status" aria-label="Typing activity">
          {names.join(", ")}
          {others > 0 ? ` and ${others} others` : ""}
          {matching.length === 1 ? " is typing…" : " are typing…"}
        </span>
      )}
    </div>
  );
}
