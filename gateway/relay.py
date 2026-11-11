"""Outbound-only WSS transport for the fixed local gateway API; never a proxy URL."""
import asyncio
import base64
import json
import os
import re
from urllib.parse import urlsplit
from aiohttp import ClientSession,ClientTimeout,WSMsgType,web
from service import Gateway,MAX_FRAME

PATH=re.compile(r'^/v1/leases(?:/[A-Za-z0-9_-]{1,160}(?:/(?:renew|frame|actions(?:/[A-Za-z0-9_-]{1,160})?))?)?$')

async def relay(gateway,url):
    parsed=urlsplit(url)
    if parsed.scheme!='wss' or parsed.path!='/device-gateway' or parsed.query or parsed.fragment or parsed.username:raise ValueError('Relay URL must be wss://media-origin/device-gateway')
    key=gateway.env['DEVICE_GATEWAY_KEY']
    runner=web.AppRunner(gateway.app());await runner.setup()
    site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
    local=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
    try:
        async with ClientSession(timeout=ClientTimeout(total=2)) as http:
            while True:
                pending=set()
                try:
                    async with http.ws_connect(url,headers={'Authorization':'Bearer '+key},max_msg_size=32768,heartbeat=10) as socket:
                        async def perform(item):
                            result={'id':item['id'],'status':503,'headers':{},'body':''}
                            try:
                                method,path=item['method'],item['path']
                                if method not in ('GET','POST','DELETE') or not isinstance(path,str) or not PATH.fullmatch(path):raise ValueError()
                                async with http.request(method,local+path,headers={'Authorization':'Bearer '+key},**({'json':item['body']} if item.get('body') is not None else {}),allow_redirects=False) as response:
                                    chunks=[];size=0
                                    async for chunk in response.content.iter_chunked(65536):
                                        size+=len(chunk)
                                        if size>MAX_FRAME:raise ValueError()
                                        chunks.append(chunk)
                                    result.update(status=response.status,body=base64.b64encode(b''.join(chunks)).decode(),headers={k:v for k,v in response.headers.items() if k.lower() in ('content-type','x-frame-id','x-captured-at','x-frame-width','x-frame-height')})
                            except Exception:pass
                            if not socket.closed:await socket.send_json(result)
                        async for message in socket:
                            if message.type!=WSMsgType.TEXT:continue
                            item=json.loads(message.data)
                            if not isinstance(item,dict) or not isinstance(item.get('id'),str) or len(item['id'])>64:raise ValueError()
                            if len(pending)>=8:
                                await socket.send_json({'id':item['id'],'status':503,'headers':{},'body':''});continue
                            task=asyncio.create_task(perform(item));pending.add(task);task.add_done_callback(pending.discard)
                except asyncio.CancelledError:raise
                except Exception:pass
                finally:
                    for task in pending:task.cancel()
                    await asyncio.gather(*pending,return_exceptions=True)
                # Reconnect only the transport. Requests, leases and actions are
                # never replayed here; active helper leases expire independently.
                await asyncio.sleep(2)
    finally:await runner.cleanup()

if __name__=='__main__':asyncio.run(relay(Gateway(),os.environ['DEVICE_GATEWAY_RELAY_URL']))
