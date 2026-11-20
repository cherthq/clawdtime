// ClawdTime on a FaceTime line: the person calls the line, and this agent answers on the Mac.
// It speaks with a realtime voice model, but it knows nothing by itself: every fact and every action comes from
// the `clawdtime` command on this Mac (desk.mjs). The video is the ClawdTime stone (picture.mjs) until the
// caller asks to see the screen. Then it is the screen, with the stone small in the corner.
//
// The rules of a Chert line that this file keeps:
//  - Join the room at once, but open the model session only when a caller is there.
//  - Publish one audio track and one camera track, both from this agent.
//  - Greet once, on the signal that FaceTime is ready (greet.mjs), and within 10 seconds of it.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AutoSubscribe,
  cli,
  defineAgent,
  llm,
  ServerOptions,
  voice,
} from "@livekit/agents";
import { realtime } from "@livekit/agents-plugin-openai";
import {
  LocalVideoTrack,
  RoomEvent,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
} from "@livekit/rtc-node";
import { z } from "zod";
import { ask, jobDoneInstructions, watchJobs } from "./desk.mjs";
import { greetOnBridgeReady } from "./greet.mjs";
import { makePicture } from "./picture.mjs";
import { FPS, HEIGHT, startScreen, WIDTH } from "./screen.mjs";

const instructions = `You are ClawdTime, the supervisor of the coding agents on this Mac. You are on a FaceTime video call with the person. You are an AI.
Speak in one or two short sentences. Use plain words.
You know nothing about the Mac by yourself. For every question or request about the Mac, its agent sessions, their status, a request that waits, an approval, a window or a job, call ask_clawdtime with the request in the caller's own words. Then say its answer. Never invent a status or a result.
Never say that something cannot be done before you asked ask_clawdtime.
When the caller asks to see something (a session, the screen, a window), call show_screen with on true, and call ask_clawdtime with the request so that the right window comes to the front. When the caller asks to hide the screen, call show_screen with on false.
When the caller asks for a new session to do a job, call ask_clawdtime with the job. When a job finishes, you are told, and you say its result.
Before a tool call that takes time, say "One moment."
If a tool fails, say so in one sentence. Do not guess.`;
const greeting =
  "Greet the caller in one short sentence: say that you are ClawdTime on this Mac, and ask what the caller needs.";

/** One JSON line for each event. It carries the name of the event, never what was said. */
const log = (event, detail = {}) =>
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      clawdtime_line: event,
      ...detail,
    }),
  );
const SHOWN = new Set(["listening", "thinking", "speaking"]);

const agent = defineAgent({
  entry: async (ctx) => {
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    // Chert prepares a room before a caller exists. Join at once, but open no model session and no capture yet.
    const caller = await ctx.waitForParticipant();
    const callStarted = Date.now();
    log("call_started");

    // One camera track from this agent: the line shows video only from the participant that speaks.
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack("agent-video", source);
    const picture = makePicture();
    let tick = 0,
      heard = "idle",
      busy = 0,
      screen = null,
      jobs = null,
      stopGreeting = null,
      frameFailed = false,
      ended = false;
    // The stone shows what the agent does: it speaks, it works on a request, it listens.
    const state = () =>
      heard === "speaking" ? "speaking" : busy > 0 ? "thinking" : heard;
    const frame = () => {
      try {
        const pixels = picture.frame(tick++, state(), screen?.latest());
        source.captureFrame(
          new VideoFrame(pixels, WIDTH, HEIGHT, VideoBufferType.RGBA),
        );
      } catch {
        if (!frameFailed) log("frame_failed");
        frameFailed = true;
      }
    };
    frame();
    await ctx.room.localParticipant.publishTrack(track, {
      source: TrackSource.SOURCE_CAMERA,
    });
    const timer = setInterval(frame, 1000 / FPS);

    const showScreen = async (on) => {
      if (!on) {
        screen?.stop();
        screen = null;
        return "The screen is hidden.";
      }
      if (!screen) {
        const capture = startScreen({
          onExit: (code) => {
            log("screen_capture_stopped", { code });
            if (screen === capture) screen = null;
          },
        });
        screen = capture;
      }
      const capture = screen;
      if (await capture.started()) return "The screen is on the call now.";
      capture.stop();
      if (screen === capture) screen = null;
      return "The screen capture did not start on this Mac.";
    };

    const tools = [
      llm.tool({
        name: "ask_clawdtime",
        description:
          "Ask the ClawdTime supervisor on the Mac. Use it for status, for anything about agent sessions and their windows, to bring a session to the front, to answer or approve a request that waits, and to start a session for a job. Pass the request in the caller's own words.",
        parameters: z.object({
          request: z
            .string()
            .describe("The request, in the caller's own words"),
        }),
        execute: async ({ request }) => {
          log("ask_clawdtime");
          busy++;
          try {
            return await ask(request);
          } finally {
            busy--;
            jobs?.check();
          }
        },
      }),
      llm.tool({
        name: "show_screen",
        description:
          "Show the Mac screen on the call, or hide it. The caller sees it as the video.",
        parameters: z.object({
          on: z.boolean().describe("true to show the screen, false to hide it"),
        }),
        execute: async ({ on }) => {
          log("show_screen", { on: on === true });
          return showScreen(on === true);
        },
      }),
    ];

    const session = new voice.AgentSession({
      llm: new realtime.RealtimeModel({
        model: "gpt-realtime",
        voice: process.env.CLAWDTIME_LINE_VOICE || "marin",
      }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      heard = SHOWN.has(event.newState) ? event.newState : "idle";
    });
    const say = (words) => {
      try {
        session.generateReply({ instructions: words });
      } catch {
        /* the call ended first */
      }
    };
    const quiet = async (step) => {
      try {
        await step();
      } catch {
        /* the rest must still close */
      }
    };
    ctx.addShutdownCallback(async () => {
      ended = true;
      clearInterval(timer);
      stopGreeting?.();
      jobs?.stop();
      screen?.stop();
      screen = null;
      await quiet(() => session.close());
      await quiet(() => track.close());
      await quiet(() => source.close());
      log("call_ended");
    });
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions, tools }),
      record: false,
      inputOptions: {
        participantIdentity: caller.identity,
        audioEnabled: true,
        videoEnabled: false,
        textEnabled: false,
        closeOnDisconnect: true,
        deleteRoomOnClose: false,
      },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });
    if (ended) return;
    // Greet once when chert dev reports that FaceTime is ready. Without the signal there is no greeting, and
    // the caller speaks first.
    stopGreeting = greetOnBridgeReady(
      ctx.room,
      () => {
        log("greeting");
        say(greeting);
      },
      { event: RoomEvent.RoomMetadataChanged },
    );
    // Say the result of a job as soon as it is done: the caller must not have to ask at the right moment.
    jobs = watchJobs({
      since: callStarted,
      say: (job) => {
        log("job_done");
        say(jobDoneInstructions(job));
      },
    });
  },
});

export default agent;

/** True when this file is the program that node runs. A call's own process only imports it, for `entry`. */
function isProgram() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isProgram()) {
  // The worker has a small HTTP port for its health, 8081 by default. Give another one when two agents run on
  // one Mac.
  const port = Number(process.env.CLAWDTIME_LINE_PORT);
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: process.env.AGENT_NAME || "clawdtime",
      ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    }),
  );
}
