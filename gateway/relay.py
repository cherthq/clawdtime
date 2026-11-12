"""Outbound-only WSS transport for the fixed local gateway API; never a proxy URL."""
import asyncio
import base64
import json
import logging
import os
import re
import ssl
import time
import certifi
from urllib.parse import urlsplit
from aiohttp import ClientSession,ClientTimeout,TCPConnector,WSMsgType,web
from service import Gateway,MAX_FRAME
from relay_diagnostics import milliseconds, stamp

PATH=re.compile(r'^/v1/(?:leases(?:/[A-Za-z0-9_-]{1,160}(?:/(?:renew|frame|actions(?:/[A-Za-z0-9_-]{1,160})?))?)?|devices/[A-Za-z0-9_-]{1,160}/(?:readiness(?:/[A-Za-z0-9_-]{1,160}/[0-9]{1,10})?|panel))$')

def trusted_tls_context():
    # Isolated trust roots: macOS framework Python may have no default CA file.
    # Hostname and certificate verification remain mandatory.
    return ssl.create_default_context(cafile=certifi.where())


class ReconnectLog:
    """One bounded diagnostic per 30 seconds, never exception text or traceback."""
    def __init__(self, clock=time.monotonic):
        self.clock=clock
        self.last=float('-inf')
        self.suppressed=0

    def failure(self, error):
        now=self.clock()
        if now-self.last<30:
            self.suppressed=min(self.suppressed+1,999999)
            return
        name=type(error).__name__
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}',name):name='Exception'
        status=getattr(error,'status',None)
        safe_status=status if type(status) is int and 100<=status<=599 else 'none'
        logging.getLogger('clawdtime.gateway').warning(
            'gateway_reconnect_failed exception=%s http_status=%s suppressed=%d at=%s',
            name,safe_status,self.suppressed,stamp())
        self.last=now
        self.suppressed=0


async def relay(gateway,url):
    parsed=urlsplit(url)
    if parsed.scheme!='wss' or parsed.path!='/device-gateway' or parsed.query or parsed.fragment or parsed.username or parsed.password:raise ValueError('Relay URL must be wss://media-origin/device-gateway')
    key=gateway.env['DEVICE_GATEWAY_KEY']
    runner=web.AppRunner(gateway.app());await runner.setup()
    site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
    local=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
    diagnostics=ReconnectLog()
    try:
        async with ClientSession(timeout=ClientTimeout(total=2),connector=TCPConnector(ssl=trusted_tls_context())) as http:
            while True:
                pending=set()
                try:
                    async with http.ws_connect(url,headers={'Authorization':'Bearer '+key,'X-ClawdTime-Devices':','.join(sorted(gateway.devices))},max_msg_size=32768,heartbeat=10) as socket:
                        async def perform(item):
                            started=time.monotonic()
                            # Idle readiness traffic must not evict the failed call's hop history.
                            path=item.get('path')
                            identity=item['id'] if isinstance(path,str) and path.startswith('/v1/leases') else None
                            record=lambda phase, **fields: gateway.relay_diagnostics.record(identity,phase,duration=milliseconds(time.monotonic()-started),**fields)
                            record('received')
                            result={'id':item['id'],'status':503,'headers':{},'body':''}
                            try:
                                method,path=item['method'],item['path']
                                if method not in ('GET','POST','DELETE') or not isinstance(path,str) or not PATH.fullmatch(path) or ('/devices/' in path and method!=('POST' if path.endswith('/panel') else 'GET')):raise ValueError()
                                record('forwarded')
                                async with http.request(method,local+path,headers={'Authorization':'Bearer '+key,'X-ClawdTime-Relay-Request':identity or ''},**({'json':item['body']} if item.get('body') is not None else {}),allow_redirects=False) as response:
                                    chunks=[];size=0
                                    async for chunk in response.content.iter_chunked(65536):
                                        size+=len(chunk)
                                        if size>MAX_FRAME:raise ValueError()
                                        chunks.append(chunk)
                                    result.update(status=response.status,body=base64.b64encode(b''.join(chunks)).decode(),headers={k:v for k,v in response.headers.items() if k.lower() in ('content-type','x-frame-id','x-captured-at','x-frame-width','x-frame-height')})
                            except asyncio.CancelledError:
                                record('cancelled');raise
                            except Exception as error:
                                record('failed',error='timeout' if isinstance(error,TimeoutError) else 'connection' if isinstance(error,ConnectionError) else 'invalid' if isinstance(error,ValueError) else 'other')
                            record('response_ready',status=result['status'])
                            if socket.closed:
                                record('failed',error='closed');return
                            try:
                                await socket.send_json(result)
                                record('response_sent',status=result['status'])
                            except asyncio.CancelledError:
                                record('cancelled');raise
                            except Exception:
                                record('failed',error='connection')
                        async for message in socket:
                            if message.type!=WSMsgType.TEXT:continue
                            item=json.loads(message.data)
                            if not isinstance(item,dict) or not isinstance(item.get('id'),str) or len(item['id'])>64:raise ValueError()
                            if len(pending)>=8:
                                await socket.send_json({'id':item['id'],'status':503,'headers':{},'body':''});continue
                            task=asyncio.create_task(perform(item));pending.add(task);task.add_done_callback(pending.discard)
                    diagnostics.failure(ConnectionError())  # clean remote close also requires reconnect
                except asyncio.CancelledError:raise
                except Exception as error:diagnostics.failure(error)
                finally:
                    for task in pending:task.cancel()
                    await asyncio.gather(*pending,return_exceptions=True)
                # Reconnect only the transport. Requests, leases and actions are
                # never replayed here; active helper leases expire independently.
                await asyncio.sleep(2)
    finally:await runner.cleanup()

if __name__=='__main__':asyncio.run(relay(Gateway(),os.environ['DEVICE_GATEWAY_RELAY_URL']))
