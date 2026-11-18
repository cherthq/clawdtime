"""Camera handlers shared by the production media service and local preview."""
from aiohttp import web
from camera import CameraError

# Exact internal strings only. Never copy exception text or peer data into a
# response, and never infer a more specific reason from a substring.
ERROR_CODES = {
    **{message: 'camera_invalid_command' for message in (
        'Invalid camera command', 'Invalid camera envelope', 'Invalid content revision',
        'Invalid source rectangle', 'Invalid camera label', 'Invalid annotation lifetime',
        'Invalid annotation', 'Label annotation requires text', 'Invalid camera motion',
        'Invalid zoom', 'Invalid annotation ID')},
    'Command identity reused': 'camera_identity_conflict',
    'Fresh source frame required': 'camera_frame_stale',
    'Stale source frame': 'camera_frame_stale',
    'Source content changed; observe again': 'camera_content_changed',
    'Presentation changed; observe again': 'camera_presentation_changed',
    'Camera update rate exceeded': 'camera_rate_limited',
    'Annotation count exceeded': 'camera_rate_limited',
    'Resume before changing paused camera': 'camera_paused',
}

def rejection(status, code):
    return web.json_response({'errorCode': code}, status=status, headers={'Cache-Control': 'no-store'})

async def camera_request(screen, request):
    if screen is None or screen.camera is None:return rejection(409, 'camera_not_negotiated')
    async with screen.frame_lock:
        screen.expire()
        try:
            value=screen.camera.command(await request.json()) if request.method=='POST' else screen.camera.status()
        except CameraError as error:
            return rejection(error.status if error.status in (400, 409, 429) else 409,
                             ERROR_CODES.get(str(error), 'camera_rejected'))
        return web.json_response(value,headers={'Cache-Control':'no-store'})
