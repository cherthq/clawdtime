"""Synthetic Retina-sized display pipeline measurement; never captures or sends input."""
import asyncio
import base64
import hashlib
import io
import json
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "media"))
from aiohttp import ClientSession
from PIL import Image, ImageDraw
from camera_preview import Preview, iso


async def main():
    selected = {"kind": "display", "id": "1", "displayId": 1}
    preview = Preview({"mode": "actual", "surface": selected, "displayStream": True,
                       "sourceFps": 15, "renderFps": 30, "durationSeconds": 30})
    # Both native entry points are replaced before setup. No native binary runs.
    preview.native_command = AsyncMock(return_value={"surface": selected,
        "windowFrame": [0, 0, 1512, 982], "displayBounds": [0, 0, 1512, 982]})
    frames = []
    for index in range(15):
        image = Image.new("RGB", (3024, 1964), "#182235")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((200 + index * 20, 350, 1400 + index * 20, 1250), 28, fill="#567e9e")
        output = io.BytesIO(); image.save(output, "JPEG", quality=85)
        raw = output.getvalue()
        frames.append((base64.b64encode(raw).decode(), hashlib.sha256(raw).hexdigest()))
    delivered = 0

    async def frame():
        nonlocal delivered
        encoded, revision = frames[delivered % len(frames)]
        delivered += 1
        return {"frameId": f"synthetic_{delivered}", "capturedAt": iso(), "jpegBase64": encoded,
                "camera": {"version": 1, "surface": selected, "geometryGeneration": "synthetic_geometry",
                           "contentRevision": revision, "source": {
                               "width": 3024, "height": 1964, "originX": 0, "originY": 0,
                               "pointWidth": 1512, "pointHeight": 982, "displayOriginX": 0,
                               "displayOriginY": 0, "displayPointWidth": 1512, "displayPointHeight": 982}}}

    preview.native_source = AsyncMock()
    preview.native_source.frame.side_effect = frame
    preview.native_source.metrics = lambda: {"transport": "synthetic_retina_fixture", "frames": delivered}
    try:
        info = await preview.setup()
        await preview.begin_capture()
        async with ClientSession() as http:
            headers = {"Authorization": "Bearer " + preview.token}
            began = time.monotonic()
            rendered = 0
            while time.monotonic() - began < 10:
                tick = time.monotonic()
                async with http.get(info["origin"] + "/preview/image", headers=headers) as response:
                    if response.status != 200: raise RuntimeError("Synthetic image unavailable")
                    await response.read()  # Discard pixels; never save them.
                rendered += 1
                await asyncio.sleep(max(0, 1 / 30 - (time.monotonic() - tick)))
            elapsed = time.monotonic() - began
            metrics = preview.metrics()
            print(json.dumps({"syntheticOnly": True, "nativeCapture": False, "inputSubmitted": False,
                              "elapsedSeconds": round(elapsed, 2), "sourceFrames": delivered,
                              "sourceFps": round(delivered / elapsed, 2),
                              "receivedImageFps": round(rendered / elapsed, 2), "metrics": metrics}))
        await preview.stop()
        assert preview.screen.frame is None
        assert preview.native_source.stop.called
    finally:
        await preview.close()


if __name__ == "__main__":
    asyncio.run(main())
