/** Call-scoped provider-input provenance. No model text is compared with speech.
 * Only successful OpenAI input-transcription events grant a response handle its
 * original human request. SDK-synthesized finals after transcription failure do
 * not enter this boundary. All text and provider IDs stay in memory. */
export function makeCallerRequestBinding({
  now = Date.now,
  maxAgeMs = 20000,
  maxInputAgeMs = 120000,
  defer = queueMicrotask,
  finalTimeoutMs = 15000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  diagnostic = () => {},
} = {}) {
  let session = null,
    provider = null,
    current = null,
    stopped = false,
    queued = false;
  const handles = new WeakMap();
  const started = new Set();
  const emit = (code) => diagnostic(code);
  const refuse = (code) => {
    emit(code);
    return {
      ok: false,
      code,
      message:
        "I could not use that caller turn for this action. No new action was sent.",
    };
  };
  const clearDeadline = (turn) => {
    if (turn?.timer) clearTimer(turn.timer);
    if (turn) turn.timer = null;
  };
  const retire = () => {
    clearDeadline(current);
    if (current) current.text = null;
    current = null;
  };
  const identity = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 256;
  const latestUser = () => {
    try {
      return session?.chatCtx.items
        .filter((item) => item.type === "message" && item.role === "user")
        .at(-1)?.id;
    } catch {
      return null;
    }
  };
  const fresh = (turn) => now() >= turn.at && now() - turn.at <= maxAgeMs;
  const failureNotice = (turn) => {
    // Delivery may already have started before a late provider failure. Never
    // make a zero-effects claim in that case; diagnostics still record failure.
    if (!turn.ended || turn.noticeQueued || turn.used.size > 0) return;
    turn.noticeQueued = true;
    defer(() => {
      if (stopped || current !== turn || !turn.failed) return;
      try {
        // This response has no tool authority, even through continuations.
        session.generateReply({
          instructions:
            "Tell the caller briefly that this turn could not be transcribed, nothing was sent, and ask them to repeat it.",
          toolChoice: "none",
        });
        emit("transcription_notice");
      } catch {
        emit("notice_generation_failed");
      }
    });
  };
  const fail = (turn, code) => {
    clearDeadline(turn);
    turn.failed = true;
    turn.text = null;
    emit(code);
    failureNotice(turn);
  };
  const schedule = () => {
    if (
      queued ||
      stopped ||
      !current?.final ||
      !current.ended ||
      current.generated ||
      current.failed
    )
      return;
    const turn = current;
    queued = true;
    // The provider emits its raw event before updating history; AgentActivity
    // then emits UserInputTranscribed before inserting its user ChatMessage.
    // One microtask lets that SDK stack finish. A delayed insertion is handled
    // by ConversationItemAdded, never by an arbitrary settling sleep.
    defer(() => {
      queued = false;
      if (stopped) return;
      if (current !== turn) {
        schedule();
        return;
      }
      if (turn.generated || turn.failed) return;
      if (!fresh(turn)) {
        emit("final_expired");
        return;
      }
      if (latestUser() !== turn.id) {
        emit("waiting_for_sdk_item");
        return;
      }
      turn.generated = true;
      try {
        // SpeechHandle is thenable: do NOT await it. Bind synchronously before
        // any tool can execute; child tool-response handles inherit this root.
        const handle = session.generateReply({ inputModality: "audio" });
        if (
          !handle ||
          (typeof handle !== "object" && typeof handle !== "function")
        )
          throw Error("No speech handle");
        handles.set(handle, turn);
        emit("response_bound");
      } catch {
        turn.failed = true;
        turn.text = null;
        emit("response_generation_failed");
      }
    });
  };
  const raw = (event) => {
    if (stopped || !event || typeof event !== "object") return;
    if (event.type === "input_audio_buffer.speech_started") {
      if (!identity(event.item_id)) {
        retire();
        emit("missing_input_id");
        return;
      }
      if (started.has(event.item_id)) {
        emit("duplicate_input_start");
        return;
      }
      retire();
      // Bound memory without evicting replay fences during a call.
      if (started.size >= 4096) {
        emit("input_limit");
        return;
      }
      started.add(event.item_id);
      current = {
        id: event.item_id,
        began: now(),
        at: now(),
        text: null,
        ended: false,
        final: false,
        generated: false,
        failed: false,
        used: new Set(),
      };
      emit("input_started");
      return;
    }
    if (event.type === "input_audio_buffer.cleared") {
      retire();
      emit("input_cleared");
      return;
    }
    if (
      ![
        "input_audio_buffer.speech_stopped",
        "conversation.item.input_audio_transcription.completed",
        "conversation.item.input_audio_transcription.failed",
      ].includes(event.type)
    )
      return;
    if (!current || event.item_id !== current.id) {
      emit("superseded_input_event");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      current.ended = true;
      if (current.failed) failureNotice(current);
      else if (!current.final && !current.timer) {
        const turn = current;
        turn.timer = setTimer(() => {
          if (!stopped && current === turn && !turn.final)
            fail(turn, "transcription_timeout");
        }, finalTimeoutMs);
        turn.timer?.unref?.();
      }
      schedule();
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      fail(current, "transcription_failed");
      return;
    }
    if (event.status === "in_progress") return;
    if (event.status !== undefined && event.status !== "completed") {
      emit("unsupported_final_status");
      return;
    }
    if (current.final || current.failed) {
      emit("duplicate_or_failed_final");
      return;
    }
    if (now() < current.began || now() - current.began > maxInputAgeMs) {
      fail(current, "input_expired");
      return;
    }
    if (typeof event.transcript !== "string" || !event.transcript.trim()) {
      fail(current, "empty_final");
      return;
    }
    // Keep the complete original transcript. The downstream request boundary
    // rejects over-limit text; never replace it with a truncated instruction.
    if (event.transcript.length > 16000) {
      fail(current, "final_too_large");
      return;
    }
    clearDeadline(current);
    current.text = event.transcript;
    current.final = true;
    current.at = now();
    emit("final_received");
    schedule();
  };
  const disconnected = () => {
    retire();
    emit("provider_connection_changed");
  };
  const detachProvider = () => {
    provider?.off("openai_server_event_received", raw);
    provider?.off("session_reconnected", disconnected);
    provider?.off("error", disconnected);
    provider?.off("close", disconnected);
  };
  const itemAdded = (event) => {
    if (
      event?.item?.type === "message" &&
      event.item.role === "user" &&
      event.item.id === current?.id
    )
      schedule();
  };
  return {
    bindSession(value) {
      if (stopped) return;
      session?.off("conversation_item_added", itemAdded);
      session = value;
      session.on("conversation_item_added", itemAdded);
    },
    attachProvider(value) {
      if (stopped) return;
      detachProvider();
      retire();
      provider = value;
      provider.on("openai_server_event_received", raw);
      provider.on("session_reconnected", disconnected);
      provider.on("error", disconnected);
      provider.on("close", disconnected);
    },
    take(options, capability = "computer") {
      if (stopped) return refuse("call_ended");
      if (options?.abortSignal?.aborted) return refuse("tool_aborted");
      if (!session || options?.ctx?.session !== session)
        return refuse("wrong_session");
      let handle = options.ctx.speechHandle;
      let turn = null;
      const seen = new Set();
      for (
        let depth = 0;
        handle && depth < 64;
        depth++, handle = handle.parent
      ) {
        if (seen.has(handle)) return refuse("invalid_handle_chain");
        seen.add(handle);
        if (handle.interrupted) return refuse("turn_interrupted");
        turn ||= handles.get(handle);
      }
      if (handle) return refuse("invalid_handle_chain");
      if (!turn) return refuse("unbound_response");
      if (turn !== current) return refuse("superseded_turn");
      if (turn.failed || !turn.final || typeof turn.text !== "string")
        return refuse("final_unavailable");
      if (!fresh(turn)) return refuse("turn_expired");
      if (latestUser() !== turn.id) return refuse("superseded_sdk_item");
      if (turn.used.has(capability)) return refuse("request_already_used");
      turn.used.add(capability); // Before dispatch, even if delivery then fails.
      emit("request_claimed");
      return { ok: true, text: turn.text };
    },
    cancel() {
      retire();
      emit("request_canceled");
    },
    stop() {
      stopped = true;
      retire();
      started.clear();
      detachProvider();
      session?.off("conversation_item_added", itemAdded);
      provider = session = null;
    },
  };
}

/** Install the raw-event observer in the public factory before audio can start.
 * Server VAD still detects/interrupts speech; successful final transcripts alone
 * explicitly schedule responses through the call-scoped binding above. */
export function makeCallerRealtimeModel(Base, options, binding) {
  class CallerRealtimeModel extends Base {
    session() {
      const value = super.session();
      binding.attachProvider(value);
      return value;
    }
  }
  return new CallerRealtimeModel({
    ...options,
    turnDetection: { ...options.turnDetection, create_response: false },
  });
}
