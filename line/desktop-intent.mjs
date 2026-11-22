/** Call-scoped provider-input provenance. No model text is compared with speech.
 * Only successful provider input-transcription events grant a response handle
 * its original human request. SDK-synthesized finals after transcription failure
 * do not enter this boundary. All text and provider IDs stay in memory.
 *
 * The provider cuts speech into one item at each pause, so one request can be
 * several items. The request is every item that is not yet answered: all items
 * since a tool last forwarded one, or since an answer was last said in full.
 * It goes out whole, in the order spoken, or not at all. */
export function makeCallerRequestBinding({
  now = Date.now,
  maxAgeMs = 20000,
  maxInputAgeMs = 120000,
  maxItems = 16,
  maxChars = 16000,
  defer = queueMicrotask,
  finalTimeoutMs = 15000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  diagnostic = () => {},
} = {}) {
  let session = null,
    provider = null,
    // The open request: its items, oldest first. A response is bound to the
    // newest item and speaks for all of them.
    request = null,
    deadline = null,
    stopped = false,
    queued = false;
  const handles = new WeakMap();
  const answers = new WeakMap();
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
  const newest = () => request?.turns.at(-1) ?? null;
  const broken = (own) => own.turns.some((turn) => turn.failed);
  const complete = (own) =>
    own.turns.every((turn) => turn.final && !turn.failed);
  const forget = (turns) => {
    for (const turn of turns ?? []) turn.text = null;
  };
  const clearDeadline = () => {
    if (deadline !== null) clearTimer(deadline);
    deadline = null;
  };
  const retire = () => {
    clearDeadline();
    forget(request?.turns);
    request = null;
  };
  const identity = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 256;
  // The library's history holds the newest item, and after it only older
  // items of this request, whose finals came late. Any other caller item
  // there is one that this binding did not follow.
  const held = (own) => {
    try {
      const ids = session.chatCtx.items
        .filter((item) => item.type === "message" && item.role === "user")
        .map((item) => item.id);
      const last = ids.lastIndexOf(own.turns.at(-1).id);
      const known = new Set(own.turns.map((turn) => turn.id));
      return last >= 0 && ids.slice(last + 1).every((id) => known.has(id));
    } catch {
      return false;
    }
  };
  // Fresh from the moment that the last final of the request came.
  const fresh = (own) => {
    const at = Math.max(...own.turns.map((turn) => turn.at));
    return now() >= at && now() - at <= maxAgeMs;
  };
  // The original words of every item, with one space at each joint. The two
  // outer ends stay as the provider gave them.
  const whole = (own) =>
    own.turns
      .map((turn, index, all) => {
        const text = index > 0 ? turn.text.trimStart() : turn.text;
        return index < all.length - 1 ? text.trimEnd() : text;
      })
      .join(" ");
  // The say-it-again path. A request with an item that has no successful
  // final is never forwarded, not even in part: the caller is asked for all of
  // it again, once the caller has stopped speaking.
  const notify = () => {
    const own = request,
      turn = newest();
    // Delivery may already have started before a late provider failure. Never
    // make a zero-effects claim in that case; diagnostics still record failure.
    if (
      stopped ||
      !own ||
      own.forwarded ||
      !turn.ended ||
      turn.used.size > 0 ||
      !broken(own) ||
      own.noticed === turn
    )
      return;
    own.noticed = turn;
    defer(() => {
      if (
        stopped ||
        request !== own ||
        newest() !== turn ||
        own.forwarded ||
        turn.used.size > 0
      )
        return;
      try {
        // This response has no tool authority, even through continuations.
        const handle = session.generateReply({
          instructions:
            "Tell the caller briefly that their request could not be transcribed in full, nothing was sent, and ask them to say the whole request again.",
          toolChoice: "none",
        });
        // Said in full, the notice ends this request: the caller starts again.
        watch(handle, { turn, parts: 0, cut: false });
        emit("transcription_notice");
      } catch {
        emit("notice_generation_failed");
      }
    });
  };
  // One deadline for the open request. After the caller stops, every final
  // must come in time; new speech puts the wait off until its own end.
  const arm = () => {
    const own = request;
    if (
      stopped ||
      !own ||
      own.forwarded ||
      !newest().ended ||
      own.turns.every((turn) => turn.final || turn.failed)
    ) {
      clearDeadline();
      return;
    }
    if (deadline !== null) return;
    deadline = setTimer(() => {
      clearDeadline();
      if (stopped || request !== own) return;
      for (const turn of own.turns)
        if (!turn.final && !turn.failed) {
          turn.failed = true;
          turn.text = null;
        }
      emit("transcription_timeout");
      notify();
    }, finalTimeoutMs);
    deadline?.unref?.();
  };
  const fail = (turn, code) => {
    turn.failed = true;
    turn.text = null;
    emit(code);
    arm();
    notify();
  };
  const schedule = () => {
    const own = request,
      turn = newest();
    if (
      queued ||
      stopped ||
      !own ||
      own.forwarded ||
      !turn.ended ||
      turn.generated ||
      !complete(own)
    )
      return;
    queued = true;
    // The provider emits its raw event before updating history; AgentActivity
    // then emits UserInputTranscribed before inserting its user ChatMessage.
    // One microtask lets that SDK stack finish. A delayed insertion is handled
    // by ConversationItemAdded, never by an arbitrary settling sleep.
    defer(() => {
      queued = false;
      if (stopped) return;
      if (request !== own || newest() !== turn) {
        schedule();
        return;
      }
      if (own.forwarded || turn.generated || !complete(own)) return;
      if (!fresh(own)) {
        emit("final_expired");
        return;
      }
      if (!held(own)) {
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
        watch(handle, { turn, parts: 0, cut: false });
        emit("response_bound");
      } catch {
        turn.failed = true;
        turn.text = null;
        emit("response_generation_failed");
      }
    });
  };
  // An answer that was said in full ends the request up to its item. Speech
  // that started after that item is a new request.
  const answered = (turn) => {
    const at = stopped || !request ? -1 : request.turns.indexOf(turn);
    if (at < 0) return;
    clearDeadline();
    forget(request.turns.slice(0, at + 1));
    const rest = request.turns.slice(at + 1);
    request = rest.length
      ? { turns: rest, forwarded: false, noticed: null }
      : null;
    emit("answer_finished");
    arm();
    notify();
    schedule();
  };
  // A reply and the replies that follow its tools are one answer. It counts
  // only when every part ended and none was interrupted or failed.
  const watch = (handle, answer) => {
    if (typeof handle?.addDoneCallback !== "function") return;
    answers.set(handle, answer);
    answer.parts++;
    handle.addDoneCallback(() => {
      let failed = true;
      try {
        failed = handle.exception?.() !== undefined;
      } catch {
        /* a handle that cannot tell did not finish an answer */
      }
      if (handle.interrupted || failed) answer.cut = true;
      if (--answer.parts === 0 && !answer.cut) answered(answer.turn);
    });
  };
  const speechCreated = (event) => {
    const handle = event?.speechHandle;
    let parent = handle?.parent;
    for (let depth = 0; parent && depth < 64; depth++, parent = parent.parent) {
      const answer = answers.get(parent);
      if (answer) {
        watch(handle, answer);
        return;
      }
    }
  };
  // New speech joins the open request. After a forward it starts a new one.
  const join = (id) => {
    clearDeadline();
    const last = newest();
    if (!request || request.forwarded) {
      forget(request?.turns);
      request = { turns: [], forwarded: false, noticed: null };
    }
    // A new start means that the item before it ended, even when its stop
    // event never came.
    else last.ended = true;
    const turn = {
      id,
      began: now(),
      at: now(),
      text: null,
      ended: false,
      final: false,
      generated: false,
      failed: false,
      used: new Set(),
    };
    request.turns.push(turn);
    // More items than one request may hold: refuse all of it, never a part.
    // The oldest item goes, so the count stays bounded.
    if (request.turns.length > maxItems) {
      forget(request.turns);
      request.turns.shift();
      turn.failed = true;
      emit("request_too_long");
    }
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
      // Bound memory without evicting replay fences during a call.
      if (started.size >= 4096) {
        retire();
        emit("input_limit");
        return;
      }
      started.add(event.item_id);
      join(event.item_id);
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
    const turn = request?.turns.find((item) => item.id === event.item_id);
    if (!turn) {
      emit("superseded_input_event");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      turn.ended = true;
      arm();
      notify();
      schedule();
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      fail(turn, "transcription_failed");
      return;
    }
    if (event.status === "in_progress") return;
    if (event.status !== undefined && event.status !== "completed") {
      emit("unsupported_final_status");
      return;
    }
    if (turn.final || turn.failed) {
      emit("duplicate_or_failed_final");
      return;
    }
    if (now() < turn.began || now() - turn.began > maxInputAgeMs) {
      fail(turn, "input_expired");
      return;
    }
    if (typeof event.transcript !== "string" || !event.transcript.trim()) {
      fail(turn, "empty_final");
      return;
    }
    // Keep the complete original transcript. The downstream request boundary
    // rejects over-limit text; never replace it with a truncated instruction.
    if (event.transcript.length > 16000) {
      fail(turn, "final_too_large");
      return;
    }
    // The same holds for the request as a whole: over the bound it is refused.
    const kept = request.turns.reduce(
      (sum, item) => sum + (item.text?.length ?? 0),
      0,
    );
    if (kept + event.transcript.length > maxChars) {
      fail(turn, "request_too_long");
      return;
    }
    turn.text = event.transcript;
    turn.final = true;
    turn.at = now();
    emit("final_received");
    arm();
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
      event.item.id === newest()?.id
    )
      schedule();
  };
  const detachSession = () => {
    session?.off("conversation_item_added", itemAdded);
    session?.off("speech_created", speechCreated);
  };
  return {
    bindSession(value) {
      if (stopped) return;
      detachSession();
      session = value;
      session.on("conversation_item_added", itemAdded);
      session.on("speech_created", speechCreated);
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
      const own = request;
      if (!own || turn !== newest()) return refuse("superseded_turn");
      if (
        !complete(own) ||
        own.turns.some((item) => typeof item.text !== "string")
      )
        return refuse("final_unavailable");
      if (!fresh(own)) return refuse("turn_expired");
      if (!held(own)) return refuse("superseded_sdk_item");
      if (turn.used.has(capability)) return refuse("request_already_used");
      turn.used.add(capability); // Before dispatch, even if delivery then fails.
      // The forward ends the request: what the caller says next is a new one.
      // The other tools forward no words, so they leave it open.
      if (capability === "computer") own.forwarded = true;
      emit("request_claimed");
      return { ok: true, text: whole(own) };
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
      detachSession();
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
