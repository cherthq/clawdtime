/** Retire caller authority synchronously on departure; asynchronous SDK teardown
 * can drain later. Only the paired caller leaving ends this call. */
export function bindCallEnd({
  room,
  callerIdentity,
  roomEvents,
  sessionCloseEvent,
  binding,
  cleanup,
}) {
  let closed = false,
    session = null;
  const detach = () => {
    room.off(roomEvents.ParticipantDisconnected, participantLeft);
    room.off(roomEvents.Disconnected, close);
    session?.off(sessionCloseEvent, close);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    binding.stop();
    detach();
    // cleanup sets the agent's ended flag before its first await.
    void cleanup();
  };
  const participantLeft = (participant) => {
    if (participant?.identity === callerIdentity) close();
  };
  room.on(roomEvents.ParticipantDisconnected, participantLeft);
  room.on(roomEvents.Disconnected, close);
  return {
    attachSession(value) {
      session?.off(sessionCloseEvent, close);
      session = value;
      if (!closed) session.on(sessionCloseEvent, close);
    },
    detach,
  };
}
