"""Local evaluation harness. Upstream source stays unchanged; all imagery is synthetic."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
from pathlib import Path
import signal
import sys
import time
from datetime import datetime, timezone

LAB = Path(__file__).resolve().parent
SOURCE = LAB / "source"
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
os.environ["ESCALATION_MODE"] = "mock"
sys.path.insert(0, str(SOURCE))

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from escalation_mcp import config, packet, session
from escalation_mcp.channel.mock import MockChannel
from escalation_mcp.config import Settings
from escalation_mcp.models import HumanDecision
from escalation_mcp.screen.code_camera import CameraConfig, CodeCameraSource
from escalation_mcp.sink.mock import MockSink
from escalation_mcp.state import STATE
from incident.builder import build_incident
from triage.grok import fallback_triage
from watcher.detectors import Detectors
from watcher.runner import Runner


def synthetic_camera(workspace: Path) -> CodeCameraSource:
    image = Image.new("RGB", (1600, 1000), "#181c25")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 27)
    small = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 21)
    draw.text((64, 45), "ARGOS / LOCAL CAMERA EVALUATION", font=font, fill="#ffffff")
    draw.text((64, 95), "Synthetic editor fixture. No screen capture, calls or AI execution.", font=small, fill="#a4b0c6")
    draw.rounded_rectangle((64, 180, 1536, 820), 18, fill="#242a37")
    draw.text((100, 215), "demo/configs/bad_lr.yaml", font=font, fill="#8ebcff")
    lines = ["# Training configuration", "batch_size: 64", "steps: 5000", "lr: 20.0", "log_every: 5", "checkpoint_every: 200"]
    for i, line in enumerate(lines):
        y = 295 + i * 52
        if i == 3:
            draw.rectangle((100, y - 4, 1470, y + 40), fill="#5c4400")
        draw.text((120, y), f"{i + 1:2}   {line}", font=font, fill="#e4eaf5")
    draw.text((100, 680), "1 REQUIRED   Lower learning rate: 20.0 -> 0.1", font=small, fill="#ffdc8a")
    draw.text((100, 725), "2 OPTIONAL   Use linear output for negative targets", font=small, fill="#a3ddc9")
    draw.text((64, 875), "Camera cycles: overview -> highlighted line -> overview", font=small, fill="#a4b0c6")
    rgb = np.asarray(image)
    bgra = np.concatenate([rgb[:, :, ::-1], np.full((1000, 1600, 1), 255, dtype=np.uint8)], axis=2)
    return CodeCameraSource(
        CameraConfig(workspace=workspace, zoom=1.8),
        grab_raw=lambda: bgra,
        screen_size=(1600, 1000),
        find_window=lambda: (1, (0, 0, 1600, 1000)),
        window_at=lambda x, y: 1,
        max_width=1280,
    )


def train(run_dir: Path) -> dict:
    detections = []
    def failure(detection, runner):
        detections.append(build_incident(detection, runner.run_id, runner.log_tail,
            runner.metrics_path, SOURCE / "demo/configs/bad_lr.yaml", SOURCE))
    command = [sys.executable, str(SOURCE / "demo/train.py"), "--config",
        str(SOURCE / "demo/configs/bad_lr.yaml"), "--run-dir", str(run_dir / "training"),
        "--warmup-steps", "5", "--max-steps", "80", "--step-delay", "0"]
    code = Runner(command, run_dir / "training", failure, Detectors(), cwd=SOURCE).run()
    incident = next((i for i in detections if i.type == "nan"), None)
    if incident is None:
        raise RuntimeError(f"Expected real NaN detection; exit={code}, detections={[i.type for i in detections]}")
    triage = fallback_triage(incident)
    return {"exit_code": code, "detection": incident.type, "step": incident.step,
        "summary": triage.summary, "cause": triage.cause,
        "proposed_changes": triage.fix.changes,
        "diagnosis": "upstream deterministic fallback; no model called"}


async def run(args):
    run_dir = LAB / "output" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    run_dir.mkdir(parents=True)
    config.runs_dir = lambda: run_dir
    packet.runs_dir = lambda: run_dir
    training = train(run_dir)
    camera = synthetic_camera(run_dir)
    session.configure_runtime(settings=Settings(mode="mock", preview_port=args.port, screen_fps=15),
        sink=MockSink(), channel=MockChannel(), fake_frames=camera)
    # Exercise the live-Mentor keep-open setting using mock transport only.
    session.RUNTIME.auto_reset_on_decision = False
    result = await session.start_escalation(title="Local fixture: training diverged",
        summary=training["summary"], failure_type="nan", severity="HIGH",
        proposed_fix="Review learning rate and output activation", share="screen",
        details={"local_fixture": True, "training": training})
    if not result.get("preview_url") or result["warnings"]:
        raise RuntimeError(f"Preview failed: {result}")
    iid = result["incident_id"]
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    print(json.dumps({"preview_url": result["preview_url"], "synthetic": True,
        "seconds": args.seconds, "output": str(run_dir), "training": training}), flush=True)
    try:
        await session.report_action(iid, "review", "Synthetic fixture / required and optional fixes", "done")
        if args.smoke:
            for decision in ("approve", "instruction"):
                await STATE.enqueue_decision(HumanDecision(incident_id=iid,
                    ts=datetime.now(timezone.utc).isoformat(), decision=decision,
                    text="Synthetic test only; no edits authorized", **{"from": "local-fixture"}))
                observed = await session.poll_human_response(iid, 1)
                assert observed["decision"] == decision
                assert STATE.active is not None and session.RUNTIME.preview is not None
            async with __import__("httpx").AsyncClient() as client:
                response = await client.get(result["preview_url"] + "/frame.jpg")
                assert response.status_code == 200 and response.content[:2] == b"\xff\xd8"
            print("PASS: real training failure, fallback triage, mock multi-turn decisions, JPEG preview", flush=True)
        else:
            started = time.monotonic()
            prior = None
            while not stop.is_set() and time.monotonic() - started < args.seconds:
                focused = int((time.monotonic() - started) / 6) % 2 == 1
                if focused != prior:
                    if focused:
                        with camera._lock:
                            camera.mode = "focus"
                            camera.focus_started = time.monotonic()
                            camera.last_seen = 0
                            camera.lost = False
                    else:
                        camera.overview()
                    prior = focused
                await asyncio.sleep(0.1)
        (run_dir / "result.json").write_text(json.dumps({"training": training,
            "mock_preview": True, "live_call": False, "real_screen": False,
            "ai_repair": False, "smoke": args.smoke}, indent=2))
    finally:
        await session.end_escalation(iid, "aborted", "Local synthetic evaluation ended; no repair executed")
        camera.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--seconds", type=int, default=600)
    parser.add_argument("--port", type=int, default=18766)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600 or not 1024 <= args.port <= 65535:
        parser.error("seconds must be 1..3600; port 1024..65535")
    asyncio.run(run(args))
