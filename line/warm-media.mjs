import { voice } from "@livekit/agents";
import {
  RoomEvent,
  TrackKind,
  TrackSource,
  TrackPublishOptions,
} from "@livekit/rtc-node";

const frameDelay = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });

/** Stable publications for a waiting room. Only synthetic avatar/silent output:
 * no caller input, model session, screen capture or desktop authority. Publication
 * acknowledgements do not guarantee a bridge joining concurrently saw the roster.
 */
export function makeWarmMedia({
  room,
  camera,
  firstFrame,
  diagnostic = () => {},
  onFailure = () => {},
  timeoutMs = 10000,
  delay = frameDelay,
  createOutput = () =>
    new voice.ParticipantAudioOutput(room, {
      sampleRate: 24000,
      numChannels: 1,
      queueSizeMs: 200,
      trackPublishOptions: new TrackPublishOptions({
        source: TrackSource.SOURCE_MICROPHONE,
      }),
    }),
}) {
  const controller = new AbortController();
  const retired = Promise.withResolvers();
  // A background SDK subscription can outlive publication readiness. Never
  // await that promise during warm startup or teardown.
  let output = null,
    preparation = null,
    closing = null,
    closed = false,
    ready = false,
    audioStarted = false,
    audioFailed = false,
    audioPublication = null,
    videoPublication = null,
    detach = () => {};
  const retiredPublications = new Map();
  const publications = () => [
    ...(room.localParticipant?.trackPublications?.values() ?? []),
  ];
  const live = () => {
    if (closed || audioFailed || !room.isConnected)
      throw new Error("Warm media retired");
  };
  const wait = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        retired.promise.then(() => {
          throw new Error("Warm media retired");
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Warm publication timeout")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const owns = (publication) =>
    publication?.track === camera ||
    (audioStarted &&
      publication?.name === "roomio_audio" &&
      publication?.kind === TrackKind.KIND_AUDIO);
  const retirePublication = (publication) => {
    if (!owns(publication) || !publication.sid || !room.isConnected)
      return Promise.resolve();
    if (retiredPublications.has(publication.sid))
      return retiredPublications.get(publication.sid);
    let timer;
    const result = Promise.race([
      Promise.resolve().then(() =>
        room.localParticipant.unpublishTrack(publication.sid, false),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Unpublish timeout")), 2000);
      }),
    ])
      .catch(() => {
        diagnostic("media_unpublish_unknown");
      })
      .finally(() => clearTimeout(timer));
    retiredPublications.set(publication.sid, result);
    return result;
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    ready = false;
    controller.abort();
    retired.resolve();
    // Keep only the late-audio-ack listener when its publication is still in
    // flight. The room disconnect also detaches it. Late camera ACK is handled
    // by its publication promise; neither ACK can restart startup.
    if (audioPublication || !audioStarted || !room.isConnected) detach();
    closing = Promise.allSettled([
      Promise.resolve().then(() => output?.close()),
      ...publications().map(retirePublication),
    ]).then(() => {});
    return closing;
  };
  const exactRoster = () => {
    const values = publications();
    return (
      values.length === 2 &&
      values.includes(audioPublication) &&
      values.includes(videoPublication) &&
      audioPublication?.track &&
      audioPublication.muted === false &&
      videoPublication?.track === camera &&
      videoPublication.muted === false
    );
  };
  const lost = () => {
    if (closed || audioFailed) return;
    audioFailed = true;
    ready = false;
    diagnostic("media_lost");
    onFailure();
  };
  const prepare = () => {
    if (preparation) return preparation;
    preparation = (async () => {
      live();
      if (publications().length)
        throw new Error("Warm publisher already has tracks");
      const acknowledged = Promise.withResolvers();
      // Observe before start(): the SDK's start resolves only after subscription,
      // while LocalTrackPublished/local inventory proves publication immediately.
      const check = () => {
        const values = publications();
        if (closed) {
          for (const publication of values) void retirePublication(publication);
          if (values.some((p) => p.kind === TrackKind.KIND_AUDIO && owns(p)))
            detach();
          return;
        }
        if (ready) {
          if (!exactRoster()) lost();
          return;
        }
        const audio = values.filter((p) => p.kind === TrackKind.KIND_AUDIO);
        if (
          values.length > 1 ||
          audio.length > 1 ||
          (audio.length === 1 &&
            (audio[0].name !== "roomio_audio" ||
              audio[0].source !== TrackSource.SOURCE_MICROPHONE ||
              audio[0].muted !== false))
        ) {
          acknowledged.reject(new Error("Unexpected warm publication"));
          return;
        }
        if (audio.length === 1 && audio[0].track)
          acknowledged.resolve(audio[0]);
      };
      const events = [
        RoomEvent.LocalTrackPublished,
        RoomEvent.LocalTrackUnpublished,
        RoomEvent.TrackMuted,
      ];
      for (const event of events) room.on(event, check);
      detach = () => {
        for (const event of events) room.off(event, check);
        room.off(RoomEvent.Disconnected, detach);
      };
      room.on(RoomEvent.Disconnected, detach);
      diagnostic("audio_publishing");
      output = createOutput();
      audioStarted = true;
      void output.start(controller.signal).catch(() => {
        if (closed) return;
        acknowledged.reject(new Error("Warm audio startup failed"));
        if (ready) lost();
        else audioFailed = true;
      });
      check();
      const audio = await wait(acknowledged.promise);
      audioPublication = audio;
      live();
      diagnostic("audio_published");
      diagnostic(firstFrame() ? "first_frame" : "first_frame_failed");
      live();
      diagnostic("camera_publishing");
      const video = await wait(
        room.localParticipant
          .publishTrack(camera, {
            source: TrackSource.SOURCE_CAMERA,
          })
          .then((publication) => {
            if (closed) void retirePublication(publication);
            return publication;
          }),
      );
      live();
      const values = publications();
      if (
        values.length !== 2 ||
        !values.includes(audio) ||
        !values.includes(video) ||
        video.track !== camera ||
        video.kind !== TrackKind.KIND_VIDEO ||
        video.source !== TrackSource.SOURCE_CAMERA ||
        video.muted !== false
      )
        throw new Error("Warm publication roster changed");
      videoPublication = video;
      diagnostic("camera_published");
      // Encoder/signaling negotiation can discard immediate frames even after
      // local ACK. A bounded synthetic burst spans that startup interval; it is
      // transport settling, not proof of remote receipt/bridge readiness. There
      // is no idle animation loop, caller input, screen capture or model here.
      let framesSent = 0;
      for (let index = 0; index < 8; index++) {
        await wait(delay(250, controller.signal));
        live();
        if (!exactRoster()) throw new Error("Warm publication roster changed");
        if (firstFrame()) framesSent++;
        live();
        if (!exactRoster()) throw new Error("Warm publication roster changed");
      }
      diagnostic(framesSent === 8 ? "warm_frame" : "warm_frame_failed");
      if (framesSent === 0)
        throw new Error("Warm synthetic frames unavailable");
      ready = true;
      diagnostic("media_ready");
      return output;
    })();
    return preparation;
  };
  return { prepare, close, isReady: () => ready && !closed && exactRoster() };
}
