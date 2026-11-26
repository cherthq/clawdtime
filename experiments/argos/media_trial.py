"""Bounded, execution-disabled Argos media trial; importing this module does no I/O.

``await run_media(settings, api_key, agent_id, smoke=True, seconds=30)`` joins
an isolated LiveKit room and a subscribe-only observer, then checks synthetic
video, ElevenLabs audio, and the two camera client tools. No Chert calls occur.

For a lead-owned call, pass ``smoke=False, seconds=180`` and async callbacks:
``on_ready(room_connection, settings, stop_event)`` places/reconciles the call;
``on_stop(reason)`` ends/reconciles it on EVERY exit, before media teardown.
The ready callback must honor cancellation and retain unknown external outcomes.
This module never owns or invokes Chert. Return values contain counts/status only.

The supplied ElevenLabs agent MUST be dedicated, allow prompt/first-message
overrides, have PCM16 input, and expose only show_code/show_full_screen client
tools and optionally built-in end_call. Lead must verify no remote execution
tools or provider recording/retention. This harness stores no media/transcripts;
it cannot independently control the providers' retention policies.

Only synthetic BGR images enter CodeCameraSource. No microphone, real display,
editor CLI, source search, training, patching, or decision queue is used.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass, replace
import inspect
import logging
from pathlib import Path
import re
import signal
import sys
import tempfile
import threading
import time
import uuid


@dataclass(frozen=True)
class Metrics:
    video_frames: int = 0
    audio_frames: int = 0
    nonzero_audio_frames: int = 0
    agent_responses: int = 0
    user_transcripts: int = 0
    corrections: int = 0
    focus_calls: int = 0
    overview_calls: int = 0
    output_chunks: int = 0
    output_bytes: int = 0
    output_sample_rate: int = 0
    disconnects: int = 0
    cleanup_errors: int = 0


async def _thread_call(fn, *args, timeout=10):
    """Bound waiting without leaving an unbounded default-executor shutdown."""
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    def deliver(value, error):
        if not future.done():
            if error:
                future.set_exception(RuntimeError("media_operation_failed"))
            else:
                future.set_result(value)

    def run():
        try:
            value, error = fn(*args), False
        except BaseException:
            value, error = None, True
        try:
            loop.call_soon_threadsafe(deliver, value, error)
        except RuntimeError:
            pass

    threading.Thread(target=run, daemon=True, name="media-trial-operation").start()
    return await asyncio.wait_for(future, timeout)


def _synthetic_camera(workspace):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    from escalation_mcp.screen.code_camera import CameraConfig, CodeCameraSource

    image = Image.new("RGB", (1600, 900), "#181c25")
    draw = ImageDraw.Draw(image)
    font_path = "/System/Library/Fonts/Menlo.ttc"
    try:
        font = ImageFont.truetype(font_path, 28)
    except OSError:
        font = ImageFont.load_default(size=28)
    draw.text((60, 45), "ARGOS / AUDIO + SYNTHETIC CAMERA TRIAL", font=font, fill="white")
    draw.text((60, 100), "Execution disabled. No real screen or microphone capture.", font=font, fill="#a4b0c6")
    draw.rounded_rectangle((60, 180, 1540, 760), 18, fill="#242a37")
    draw.text((100, 220), "synthetic/config.yaml", font=font, fill="#8ebcff")
    for i, line in enumerate(("# Synthetic training fixture", "batch_size: 64", "steps: 5000", "lr: 20.0", "log_every: 5")):
        y = 300 + 62 * i
        if i == 3:
            draw.rectangle((100, y - 5, 1460, y + 40), fill="#5c4400")
        draw.text((120, y), f"{i + 1:2}   {line}", font=font, fill="#e4eaf5")
    draw.text((60, 815), "Camera only: overview -> highlighted line -> overview", font=font, fill="#a4b0c6")
    rgb = np.asarray(image)
    bgra = np.concatenate((rgb[:, :, ::-1], np.full((900, 1600, 1), 255, dtype=np.uint8)), axis=2)
    return CodeCameraSource(CameraConfig(workspace=workspace), grab_raw=lambda: bgra,
        screen_size=(1600, 900), find_window=lambda: (1, (0, 0, 1600, 900)),
        window_at=lambda x, y: 1, max_width=1280)


async def run_media(settings, api_key, agent_id, *, smoke=True, seconds=30,
                    on_ready=None, on_stop=None):
    """Return sanitized status/counts; callbacks may be async, never log credentials.

    Smoke requires decoded video + nonzero decoded audio + agent response + both
    camera tool callbacks. Live counts are sender-side and are NOT physical
    acceptance. Live voice requires first remote media within 60s; duration is
    clamped to 180s from answer. Setup has a separate 60s cap; cleanup is bounded.
    SIGINT/SIGTERM set local Stop (when running on the main thread/event loop).
    """
    if not isinstance(seconds, (int, float)) or not 1 <= seconds <= 180:
        raise ValueError("seconds must be between 1 and 180")
    if not smoke and on_ready is None:
        raise ValueError("live media requires lead-owned on_ready lifecycle")
    source = str(Path(__file__).resolve().parent / "source")
    if source not in sys.path:
        sys.path.insert(0, source)
    from livekit import rtc
    from elevenlabs.client import ElevenLabs
    from elevenlabs.conversational_ai.conversation import ClientTools, Conversation, ConversationInitiationData
    from escalation_mcp.livekit_room import LiveKitRoomConnection, mint_token
    from escalation_mcp.screen.backends.livekit import LiveKitScreenBackend
    from escalation_mcp.screen.capture import CaptureLoop
    from escalation_mcp.voice.eleven_agent import LiveKitAudioInterface

    loop = asyncio.get_running_loop()
    stop, metadata_ready = asyncio.Event(), asyncio.Event()
    metrics = Metrics()
    room_name = "argos-media-trial-" + uuid.uuid4().hex
    room, observer, backend, capture, camera, audio, conv = (None,) * 7
    streams, stream_tasks = [], []
    capture_stop = threading.Event()
    capture_task = None
    signed_url = None
    status, reason = "failed", "setup_failed"
    error_type = None
    output_valid = False
    closing = False
    old_signals = {}
    # Upstream SDKs can log transcript or exception payloads. Drop all logging
    # while this exclusive trial runs; restore the prior process threshold.
    old_logging = logging.root.manager.disable
    logging.disable(sys.maxsize)
    workspace = tempfile.TemporaryDirectory(prefix="argos-media-synthetic-")

    def bump(key, value=1):
        nonlocal metrics
        metrics = replace(metrics, **{key: getattr(metrics, key) + value})

    def schedule(fn, *args):
        try:
            loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:
            pass

    def request_stop(why):
        nonlocal reason
        if not stop.is_set():
            reason = why
            stop.set()

    async def wait_event(event, timeout):
        event_task, stop_task = asyncio.create_task(event.wait()), asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait((event_task, stop_task), timeout=timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            return event_task in done and event.is_set() and not stop.is_set()
        finally:
            event_task.cancel()
            stop_task.cancel()
            await asyncio.gather(event_task, stop_task, return_exceptions=True)

    class AudioProxy:
        """Only event-loop callbacks may mutate the upstream room audio queue."""
        def play_pcm(self, pcm):
            schedule(self._play, pcm)

        def _play(self, pcm):
            if not closing and not stop.is_set():
                room.play_pcm(pcm)

        def clear_audio_queue(self):
            schedule(room.clear_audio_queue)

        def mark(self, event):
            pass

        def agent_speaking(self):
            # This is called on the event loop by incoming phone audio gating.
            return room.agent_speaking()

    class TrialAudio(LiveKitAudioInterface):
        def output(self, data):
            if output_valid and not closing:
                schedule(bump, "output_chunks")
                schedule(bump, "output_bytes", len(data))
                super().output(data)

    class TrialConversation(Conversation):
        def start_session(self):
            # Match this installed SDK's start_session, but a failed websocket
            # shutdown must not keep the standalone trial process alive forever.
            def guarded_run():
                try:
                    self._run(signed_url)
                except BaseException:
                    schedule(request_stop, "voice_worker_failed")
            self._thread = threading.Thread(target=guarded_run, daemon=True,
                                            name="media-trial-voice")
            self._thread.start()

        # Installed SDK exposes no metadata callback; inspect only format fields,
        # then delegate all SDK processing. No conversation IDs/content retained.
        def _handle_message_core(self, message, handler):
            nonlocal output_valid
            if message.get("type") == "conversation_initiation_metadata":
                info = message.get("conversation_initiation_metadata_event") or {}
                match = re.fullmatch(r"pcm_(\d+)", str(info.get("agent_output_audio_format", "")))
                input_format = info.get("user_input_audio_format", "pcm_16000")
                if match and input_format == "pcm_16000" and int(match[1]) in (8000, 16000, 22050, 24000, 44100, 48000):
                    hz = int(match[1])
                    audio.set_output_sample_rate(hz)
                    output_valid = True
                    schedule(bump, "output_sample_rate", hz)
                    schedule(metadata_ready.set)
                else:
                    schedule(request_stop, "unsupported_audio_format")
            return super()._handle_message_core(message, handler)

    async def show_code(parameters):
        if closing or stop.is_set():
            return "Trial stopped. No action performed."
        # Never call camera.focus(): that searches disk and executes an editor CLI.
        with camera._lock:
            camera.mode = "focus"
            camera.focus_started = time.monotonic()
            camera.last_seen = 0.0
            camera.lost = False
            camera.streak = 0
            camera.target_label = "synthetic/config.yaml:4"
        bump("focus_calls")
        return "Synthetic camera focus requested on the learning-rate line; no code changed."

    async def show_full_screen(parameters):
        if closing or stop.is_set():
            return "Trial stopped. No action performed."
        camera.overview()
        bump("overview_calls")
        return "Synthetic camera overview requested; no real screen is captured."

    def disconnected(details):
        schedule(bump, "disconnects")
        if not closing:
            schedule(request_stop, "voice_disconnected")

    async def consume(track):
        stream = rtc.VideoStream(track) if track.kind == rtc.TrackKind.KIND_VIDEO else rtc.AudioStream(track)
        streams.append(stream)
        try:
            async for event in stream:
                if closing:
                    break
                if track.kind == rtc.TrackKind.KIND_VIDEO:
                    bump("video_frames")
                else:
                    bump("audio_frames")
                    if any(event.frame.data):
                        bump("nonzero_audio_frames")
        except asyncio.CancelledError:
            raise
        except Exception:
            request_stop("observer_decode_failed")

    async def callback(fn, *args):
        result = fn(*args)
        if inspect.isawaitable(result):
            await result

    async def setup():
        nonlocal room, observer, backend, capture, camera, audio, conv, capture_task, signed_url
        room = LiveKitRoomConnection(settings)
        # The upstream implementation accepts every remote audio track. This
        # isolated trial accepts audio only from the authorized Chert bridge.
        original_consume = room._consume_remote_audio

        async def consume_bridge_only(track):
            bridge = room.room.remote_participants.get('chert-bridge')
            if bridge is None or not any(publication.sid == track.sid
                    for publication in bridge.track_publications.values()):
                return
            await original_consume(track)

        room._consume_remote_audio = consume_bridge_only
        room.add_bridge_left_hook(lambda: request_stop("bridge_left"))
        await room.connect(room_name)
        camera = _synthetic_camera(Path(workspace.name))
        capture = CaptureLoop(camera, lambda image: image, fps=15)
        capture.capture_once()
        capture_task = asyncio.create_task(capture.run(capture_stop))
        backend = LiveKitScreenBackend(room)
        await backend.start(capture)
        audio = TrialAudio(AudioProxy())
        client_tools = ClientTools(loop=loop)
        client_tools.register("show_code", show_code, is_async=True)
        client_tools.register("show_full_screen", show_full_screen, is_async=True)
        prompt = ("You are Argos conducting a synthetic audio/video test. Execution is disabled. "
            "Speak briefly and conversationally. The image is a synthetic editor, never the user's screen. "
            "The example file synthetic/config.yaml has batch_size 64, steps 5000, lr 20.0, and log_every 5. "
            "A prepared example proposal is to lower lr to 0.1 to address divergence; it has not been applied or verified. "
            "Only show_code and show_full_screen move this synthetic camera. Never claim code was changed. "
            "On a request to focus call show_code; on a request for overview call show_full_screen. "
            "Let the caller interrupt. Ask them to confirm audio and visibility, then invite a camera request. "
            "Do not end the call unless asked; when asked to stop or hang up, say a brief goodbye and use end_call. No other tools are authorized.")
        conv = TrialConversation(ElevenLabs(api_key=api_key, timeout=10), agent_id,
            requires_auth=True, audio_interface=audio, client_tools=client_tools,
            config=ConversationInitiationData(conversation_config_override={"agent": {
                "prompt": {"prompt": prompt}, "first_message": "Hi there, this is Argos. Can you hear me and see the demo code card? You can ask me to zoom in on the learning rate."}}),
            callback_agent_response=lambda _: schedule(bump, "agent_responses"),
            callback_user_transcript=lambda _: schedule(bump, "user_transcripts"),
            callback_agent_response_correction=lambda _a, _b: schedule(bump, "corrections"),
            callback_disconnect=disconnected)
        signed_url = await _thread_call(conv._get_signed_url, timeout=15)
        conv._get_signed_url = lambda: signed_url
        if smoke:
            observer = rtc.Room()

            @observer.on("track_subscribed")
            def subscribed(track, publication, participant):
                if participant.identity == "agent" and track.kind in (rtc.TrackKind.KIND_AUDIO, rtc.TrackKind.KIND_VIDEO):
                    stream_tasks.append(asyncio.create_task(consume(track)))

            token = mint_token(settings, identity="media-observer", room=room_name,
                can_publish=False, can_subscribe=True, can_publish_data=False)
            await observer.connect(settings.livekit_url, token)
        await asyncio.sleep(2.5)
        if on_ready is not None:
            await callback(on_ready, room, settings, stop)

    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                old_signals[sig] = signal.getsignal(sig)
                loop.add_signal_handler(sig, request_stop, "local_stop")
            except (ValueError, RuntimeError, NotImplementedError):
                old_signals.pop(sig, None)
        setup_task = asyncio.create_task(setup())
        stop_task = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait((setup_task, stop_task), timeout=60, return_when=asyncio.FIRST_COMPLETED)
            if setup_task not in done:
                request_stop("setup_timeout")
                setup_task.cancel()
            await setup_task
        finally:
            stop_task.cancel()
            await asyncio.gather(stop_task, return_exceptions=True)
        if not stop.is_set() and not smoke:
            reason = "no_answer"
            if not await wait_event(room.remote_audio_started, 60):
                request_stop("no_answer")
        if not stop.is_set():
            answered_at = (time.monotonic() if smoke else
                           room._marks.get("answered", time.monotonic()))
            deadline = answered_at + min(float(seconds), 180.0)
            reason = "voice_start_failed"
            # Signed URL is already ready: start_session only creates a thread.
            conv.start_session()
            if not smoke:
                room.set_user_audio_sink(audio.push_user_pcm16_16k)
            if not await wait_event(metadata_ready, min(15.0, max(0.01, deadline - time.monotonic()))):
                request_stop("voice_metadata_timeout")
            focus_sent = overview_sent = False
            while not stop.is_set() and time.monotonic() < deadline:
                elapsed = time.monotonic() - answered_at
                if smoke and not focus_sent and metrics.output_chunks and elapsed >= 4 and not room.agent_speaking():
                    await _thread_call(conv.send_user_message,
                        "Please use show_code now to focus the synthetic learning-rate line.", timeout=5)
                    focus_sent = True
                if smoke and focus_sent and not overview_sent and metrics.focus_calls and not room.agent_speaking() and elapsed >= 9:
                    await _thread_call(conv.send_user_message,
                        "Please use show_full_screen now to return the synthetic camera to overview.", timeout=5)
                    overview_sent = True
                await asyncio.sleep(0.1)
            if not stop.is_set():
                request_stop("duration_complete")
        if smoke:
            passed = (metrics.video_frames > 0 and metrics.nonzero_audio_frames > 0
                and metrics.agent_responses > 0 and metrics.focus_calls > 0 and metrics.overview_calls > 0)
            status = "passed" if passed and reason == "duration_complete" else "failed"
        else:
            status = "completed" if reason == "duration_complete" else "stopped"
    except asyncio.CancelledError:
        request_stop("cancelled")
        status = "stopped"
    except Exception as exc:
        error_type = type(exc).__name__
        request_stop("media_failed")
        status = "failed"
    finally:
        closing = True
        stop.set()
        if room:
            room.set_user_audio_sink(None)

        async def cleanup(operation, timeout=8):
            try:
                await asyncio.wait_for(operation(), timeout=timeout)
            except (Exception, asyncio.CancelledError):
                bump("cleanup_errors")

        if on_stop is not None:
            await cleanup(lambda: callback(on_stop, reason), timeout=32)
        if audio:
            await cleanup(lambda: _thread_call(audio.stop, timeout=3))
        if conv:
            await cleanup(lambda: _thread_call(conv.end_session, timeout=3))
            if getattr(conv, "_thread", None) is not None:
                await cleanup(lambda: _thread_call(conv.wait_for_session_end, timeout=4))
        capture_stop.set()
        if capture_task:
            await cleanup(lambda: asyncio.shield(capture_task))
        for task in stream_tasks:
            task.cancel()
        if stream_tasks:
            await asyncio.gather(*stream_tasks, return_exceptions=True)
        for stream in streams:
            await cleanup(stream.aclose)
        if observer:
            await cleanup(observer.disconnect)
        if backend:
            await cleanup(backend.stop)
        if room:
            await cleanup(room.disconnect)
        if camera:
            camera.close()
        workspace.cleanup()
        signed_url = None
        for sig, old_handler in old_signals.items():
            loop.remove_signal_handler(sig)
            signal.signal(sig, old_handler)
        logging.disable(old_logging)
    if metrics.cleanup_errors:
        status = "cleanup_incomplete"
    return {"status": status, "reason": reason, "smoke": bool(smoke),
        "room_name": room_name, "synthetic_only": True, "execution_enabled": False,
        "physical_acceptance": False, "error_type": error_type,
        "metrics": asdict(metrics)}
