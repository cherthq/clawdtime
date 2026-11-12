"""Authenticated outbound gateway sockets, one per paired Mac; bounded requests, no write replay."""
import asyncio
import base64
import json
import re
import secrets
import time
from datetime import datetime, timezone
from aiohttp import web,WSMsgType

MAX_BODY=2*1024*1024

class RelayFailure:
    """Only generated correlation and transport metadata; no request content."""
    def __init__(self, diagnostic):
        super().__init__('Gateway request unavailable; outcome unknown')
        self.diagnostic = diagnostic


class RelayTimeout(RelayFailure, TimeoutError):
    pass


class RelayDisconnected(RelayFailure, ConnectionError):
    pass


DEVICE=re.compile(r'[A-Za-z0-9_-]{1,160}')
DEVICES_HEADER='X-ClawdTime-Devices'
LEASE_PATH=re.compile(r'^/v1/leases/([A-Za-z0-9_-]{1,160})(?:/|$)')
DEVICE_PATH=re.compile(r'^/v1/devices/([A-Za-z0-9_-]{1,160})/')


def declared_devices(request):
    """Device IDs a gateway serves. Missing header means a legacy single-Mac gateway."""
    raw=request.headers.get(DEVICES_HEADER)
    if raw is None:return None
    devices=frozenset(part.strip() for part in raw.split(',') if part.strip())
    if not devices or len(devices)>32 or any(not DEVICE.fullmatch(d) for d in devices):
        raise web.HTTPBadRequest(text='Invalid device declaration.')
    return devices


class DeviceRelay:
    """One authenticated outbound socket per paired Mac gateway.

    Gateways declare the device IDs they serve; requests route to the socket
    serving that device. A gateway without a declaration (older build) is a
    legacy socket used only for devices no declaring gateway serves.
    """
    def __init__(self):
        self.sockets={}  # id(socket) -> (socket, frozenset of device IDs or None for legacy)
        self.leases={}   # lease ID -> socket that created/served it
        self.pending={}

    @property
    def socket(self):
        """Compatibility: the single live socket when exactly one is connected."""
        live=self.live()
        return live[0] if len(live)==1 else None

    @socket.setter
    def socket(self,value):
        self.sockets={} if value is None else {id(value):(value,None)}

    def live(self):
        return [s for s,_ in self.sockets.values() if not s.closed]

    def claimed(self,socket):
        return self.sockets[id(socket)][1]

    @property
    def connected(self):
        return bool(self.live())

    def connected_for(self,device):
        return self.route(device=device) is not None

    def route(self,path='',body=None,device=None):
        live=self.live()
        if not live:return None
        match=DEVICE_PATH.match(path) if isinstance(path,str) else None
        device=match.group(1) if match else device
        if device is None and isinstance(body,dict) and isinstance(body.get('deviceId'),str):device=body['deviceId']
        if device is not None:
            for s in live:
                if self.claimed(s) is not None and device in self.claimed(s):return s
            legacy=[s for s in live if self.claimed(s) is None]
            return legacy[0] if len(legacy)==1 else None
        lease=LEASE_PATH.match(path) if isinstance(path,str) else None
        if lease and lease.group(1) in self.leases and not self.leases[lease.group(1)].closed:
            return self.leases[lease.group(1)]
        return live[0] if len(live)==1 else None

    async def connect(self,request):
        devices=declared_devices(request)
        for s in self.live():
            claimed=self.claimed(s)
            if (devices is None and claimed is None) or (devices is not None and claimed is not None and devices&claimed):
                raise web.HTTPConflict(text='A device gateway is already connected for this device.')
        socket=web.WebSocketResponse(max_msg_size=3*1024*1024,heartbeat=10)
        # Reserve before the handshake yields so competing sockets cannot replace it.
        self.sockets[id(socket)]=(socket,devices)
        try:
            await socket.prepare(request)
            async for message in socket:
                if message.type!=WSMsgType.TEXT:continue
                try:
                    item=json.loads(message.data)
                    request_id=item['id'];entry=self.pending.get(request_id)
                    if not entry or entry[0] is not socket:continue
                    future=entry[1]
                    if future.done():continue
                    raw=base64.b64decode(item['body'],validate=True)
                    if len(raw)>MAX_BODY or type(item['status']) is not int or not 100<=item['status']<=599 or not isinstance(item.get('headers'),dict):raise ValueError()
                    headers={k.lower():v for k,v in item['headers'].items() if isinstance(k,str) and isinstance(v,str) and len(k)<100 and len(v)<300}
                    future.set_result((item['status'],raw,headers))
                except Exception:
                    await socket.close(code=1008,message=b'Invalid gateway response')
                    break
        finally:
            self.sockets.pop(id(socket),None)
            for lease in [l for l,s in self.leases.items() if s is socket]:self.leases.pop(lease,None)
            for owner,future in list(self.pending.values()):
                if owner is socket and not future.done():future.set_exception(ConnectionError('Gateway disconnected; outcome unknown'))
        return socket

    async def request(self,method,path,body=None,device=None):
        if method not in ('GET','POST','DELETE') or not isinstance(path,str) or not re.fullmatch(r'/v1/(?:leases(?:/[A-Za-z0-9_-]{1,160}(?:/(?:renew|frame|actions(?:/[A-Za-z0-9_-]{1,160})?))?)?|devices/[A-Za-z0-9_-]{1,160}/(?:readiness(?:/[A-Za-z0-9_-]{1,160}/[0-9]{1,10})?|panel))',path) or ('/devices/' in path and method!=('POST' if path.endswith('/panel') else 'GET')):
            if not self.connected:raise ConnectionError('Device gateway unavailable')
            raise ValueError('Invalid relay operation')
        socket=self.route(path,body,device)
        if socket is None or sum(1 for owner,_ in self.pending.values() if owner is socket)>=8:raise ConnectionError('Device gateway unavailable')
        lease=LEASE_PATH.match(path)
        lease_id=lease.group(1) if lease else body.get('id') if method=='POST' and path=='/v1/leases' and isinstance(body,dict) and isinstance(body.get('id'),str) else None
        if lease_id:
            self.leases[lease_id]=socket
            while len(self.leases)>1024:self.leases.pop(next(iter(self.leases)))
        request_id=secrets.token_hex(16)
        future=asyncio.get_running_loop().create_future();self.pending[request_id]=(socket,future)
        started=time.monotonic()
        sent_at=None
        phase='send'
        def diagnostic():
            return {'requestId':request_id,'phase':phase,
                'startedAt':datetime.fromtimestamp(started_wall,timezone.utc).isoformat(),
                'sendDurationMs':min(999999,max(0,round(((sent_at or time.monotonic())-started)*1000))),
                'socketConnected':id(socket) in self.sockets and not socket.closed}
        started_wall=time.time()
        try:
            await socket.send_json({'id':request_id,'method':method,'path':path,'body':body})
            sent_at=time.monotonic()
            phase='response'
            return await asyncio.wait_for(future,2)
        except TimeoutError as error:
            raise RelayTimeout(diagnostic()) from error
        except ConnectionError as error:
            raise RelayDisconnected(diagnostic()) from error
        finally:
            self.pending.pop(request_id,None)

    async def close(self):
        for socket,_ in list(self.sockets.values()):await socket.close()
