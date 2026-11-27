/** Rooms this worker accepted. The coordinator's durable claim stays the
 * authority; this ledger only refuses a second job for a room it holds. A room
 * the media server no longer lists has ended, and its entry is pruned when the
 * ledger is full. An unread room may still be live, so a failed lookup keeps
 * every entry and the request is refused. */
export function sharedRooms({ live, limit = 10000, batch = 100 }) {
  const claimed = new Set();
  let pruning;
  const sweep = async () => {
    try {
      const names = [...claimed];
      // Oldest first: one lookup on the request path usually frees space.
      for (let i = 0; i < names.length; i += batch) {
        const group = names.slice(i, i + batch);
        const present = new Set(await live(group));
        let freed = false;
        for (const room of group)
          if (!present.has(room)) freed = claimed.delete(room) || freed;
        if (freed) return;
      }
    } catch {
      /* keep the claims that were not read */
    }
  };
  const prune = () =>
    (pruning ??= sweep().finally(() => {
      pruning = undefined;
    }));
  return {
    async claim(room) {
      if (!room) return false;
      if (!claimed.has(room) && claimed.size >= limit) await prune();
      // Check and add without a pause, so two requests cannot both claim.
      if (claimed.has(room) || claimed.size >= limit) return false;
      claimed.add(room);
      return true;
    },
    get size() {
      return claimed.size;
    },
  };
}
