"""Explicit local display-camera probe. Discards pixels; never submits native input."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "media"))
from aiohttp import ClientSession
from camera_preview import Preview


async def probe(display, seconds):
    preview = Preview({"mode": "actual", "surface": {
        "kind": "display", "id": str(display), "displayId": display},
        "displayStream": True, "sourceFps": 15, "renderFps": 30,
        "durationSeconds": seconds + 10,
        "nativeBinary": str(Path(__file__).resolve().parents[1] / "mac/.build/debug/ClawdTimeCompanion")})
    images = rejected = 0
    began = time.monotonic()
    failure = None
    try:
        async with asyncio.timeout(seconds + 8):
            info = await preview.setup()
            await preview.begin_capture()
            began = time.monotonic()
            async with ClientSession() as http:
                while time.monotonic() - began < seconds:
                    tick = time.monotonic()
                    async with http.get(info["origin"] + "/preview/image", headers={
                        "Authorization": "Bearer " + preview.token}) as response:
                        if response.status == 200:
                            await response.read()  # No files, images, or screen text in output.
                            images += 1
                        else:
                            rejected += 1
                    if preview.selection["leaseId"] in preview.screen.stopped:
                        failure = "capture_stopped"
                        break
                    await asyncio.sleep(max(0, 1 / 30 - (time.monotonic() - tick)))
    except Exception:
        failure = "probe_unavailable"
    finally:
        elapsed = time.monotonic() - began
        camera = getattr(getattr(preview, "screen", None), "camera", None)
        live = bool(camera and camera.status()["state"] == "live")
        metrics = preview.metrics() if hasattr(preview, "screen") else None
        await preview.close()
        source = preview.native_source
        print(json.dumps({"actualSelectedDisplay": display, "inputSubmitted": False, "pixelsSaved": False,
                          "elapsedSeconds": round(elapsed, 2), "imagesReceived": images,
                          "imageRejections": rejected, "liveAtEnd": live, "failure": failure,
                          "metrics": metrics, "stopped": preview.stopped,
                          "pixelsCleared": getattr(getattr(preview, "screen", None), "frame", None) is None,
                          "sourceClosed": source.closed if source else None,
                          "nativeProcessExited": source.process.returncode is not None
                          if source and source.process else None}))
    return 0 if failure is None and live and elapsed >= seconds else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--display", type=int, required=True)
    parser.add_argument("--seconds", type=int, default=45)
    args = parser.parse_args()
    if not 1 <= args.display <= 0xffffffff or not 5 <= args.seconds <= 120:
        parser.error("Use an explicit display ID and a duration of 5–120 seconds.")
    raise SystemExit(asyncio.run(probe(args.display, args.seconds)))
