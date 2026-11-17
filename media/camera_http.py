"""Camera handlers shared by the production media service and local preview."""
from aiohttp import web
from camera import CameraError

async def camera_request(screen, request):
    if screen is None or screen.camera is None:raise web.HTTPConflict(text='Camera was not negotiated for this selection.')
    async with screen.frame_lock:
        screen.expire()
        try:
            value=screen.camera.command(await request.json()) if request.method=='POST' else screen.camera.status()
        except CameraError as error:
            raise {
                400:web.HTTPBadRequest,409:web.HTTPConflict,429:web.HTTPTooManyRequests
            }.get(error.status,web.HTTPConflict)(text=str(error))
        return web.json_response(value,headers={'Cache-Control':'no-store'})
