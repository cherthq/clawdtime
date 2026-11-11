"""One authenticated outbound gateway socket; bounded requests, no write replay."""
import asyncio
import base64
import json
import secrets
from aiohttp import web,WSMsgType

MAX_BODY=2*1024*1024

class DeviceRelay:
    def __init__(self):
        self.socket=None
        self.pending={}

    @property
    def connected(self):
        return bool(self.socket and not self.socket.closed)

    async def connect(self,request):
        if self.connected:raise web.HTTPConflict(text='A device gateway is already connected.')
        socket=web.WebSocketResponse(max_msg_size=3*1024*1024,heartbeat=10)
        # Reserve before the handshake yields so competing sockets cannot replace it.
        self.socket=socket
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
            if self.socket is socket:self.socket=None
            for owner,future in list(self.pending.values()):
                if owner is socket and not future.done():future.set_exception(ConnectionError('Gateway disconnected; outcome unknown'))
        return socket

    async def request(self,method,path,body=None):
        if not self.connected or len(self.pending)>=8:raise ConnectionError('Device gateway unavailable')
        if method not in ('GET','POST','DELETE') or not path.startswith('/v1/leases'):raise ValueError('Invalid relay operation')
        request_id=secrets.token_hex(16)
        socket=self.socket
        future=asyncio.get_running_loop().create_future();self.pending[request_id]=(socket,future)
        try:
            await socket.send_json({'id':request_id,'method':method,'path':path,'body':body})
            return await asyncio.wait_for(future,2)
        finally:
            self.pending.pop(request_id,None)

    async def close(self):
        if self.socket:await self.socket.close()
