"""Real HTML/AudioWorklet path with Chromium's fake mic and a localhost provider.

No hardware microphone, account, provider key, audio recording or live call.
"""
import asyncio
import base64
import json
import os
import signal
import socket
import struct
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

from task_voice_local import local_app
from test_task_voice import API, metadata, audio


class BrowserAudioTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_worklet_pcm_reaches_local_provider_with_fake_microphone(self):
        api = API()
        observed = {'opens': 0, 'chunks': 0, 'bytes': 0, 'nonzero': 0}
        snapshots = []
        provider_app = web.Application()
        async def provider_endpoint(request):
            observed['opens'] += 1
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            async for message in ws:
                value = json.loads(message.data)
                if value.get('type') == 'conversation_initiation_client_data':
                    await ws.send_json(metadata())
                    await ws.send_json(audio())
                if 'user_audio_chunk' in value:
                    pcm = base64.b64decode(value['user_audio_chunk'], validate=True)
                    observed['chunks'] += 1
                    observed['bytes'] += len(pcm)
                    observed['nonzero'] += int(any(struct.unpack('<' + 'h' * (len(pcm) // 2), pcm)))
            return ws
        provider_app.router.add_get('/provider', provider_endpoint)
        provider_server = TestServer(provider_app)
        await provider_server.start_server()
        async with ClientSession() as http:
            class Provider:
                async def open(self):
                    return await http.ws_connect(provider_server.make_url('/provider'))
                async def close(self):
                    pass
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            app, url = local_app({'taskOrigin': 'http://127.0.0.1:1', 'taskId': 'task_fixture',
                                  'voiceSessionId': 'voice_fixture', 'voiceToken': 's' * 40},
                                 {'elevenlabsApiKey': 'synthetic', 'elevenlabsAgentId': 'agent_fixture'},
                                 port, snapshots.append)
            async def progress(request):
                return web.json_response(observed)
            app.router.add_get('/test-input-count', progress)
            local_server = TestServer(app, port=port)
            try:
                with patch('task_voice_local.TaskVoiceAPI', return_value=api), patch('task_voice_local.ElevenLabsProvider', return_value=Provider()):
                    await local_server.start_server()
                    script = '''import { chromium } from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
try {
// A suspended graph must remain local and cannot admit a provider socket.
const paused=await browser.newPage();
await paused.addInitScript(()=>{AudioContext.prototype.resume=async function(){await this.suspend();};});
await paused.goto(process.argv[1]);
await paused.getByRole('button',{name:'Check microphone',exact:true}).click();
await paused.locator('#microphone').filter({hasText:'Microphone:'}).waitFor();
if(await paused.locator('#start').isEnabled())throw Error('Suspended microphone admitted voice');
if(!(await paused.locator('#audio-state').textContent()).includes('suspended'))throw Error('Missing suspended diagnosis');
await paused.getByRole('button',{name:'Stop microphone',exact:true}).click();
await paused.locator('#track-state').filter({hasText:'not started'}).waitFor();
await paused.close();
// A pending acquisition can be stopped and explicitly retried; its late stream is discarded.
const delayed=await browser.newPage();
await delayed.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);let first=true;window.testRelease=null;window.testLateStream=null;navigator.mediaDevices.getUserMedia=async args=>{const stream=await original(args);if(first){first=false;window.testLateStream=stream;await new Promise(resolve=>window.testRelease=resolve);}return stream;};});
await delayed.goto(process.argv[1]);
await delayed.getByRole('button',{name:'Check microphone',exact:true}).click();
await delayed.waitForFunction(()=>window.testRelease!==null);
await delayed.getByRole('button',{name:'Stop microphone',exact:true}).click();
await delayed.locator('#check:enabled').waitFor();
await delayed.getByRole('button',{name:'Check microphone',exact:true}).click();
await delayed.locator('#start:enabled').waitFor();
await delayed.evaluate(()=>window.testRelease());
await delayed.waitForFunction(()=>window.testLateStream.getTracks().every(track=>track.readyState==='ended'));
if(!(await delayed.locator('#start').isEnabled()))throw Error('Canceled check corrupted current graph');
await delayed.getByRole('button',{name:'Stop microphone',exact:true}).click();
await delayed.close();
const page=await browser.newPage(); await page.goto(process.argv[1]);
await page.getByRole('button',{name:'Check microphone',exact:true}).click();
await page.locator('#mic-signal').filter({hasText:'Microphone signal detected'}).waitFor({timeout:10000});
await page.locator('#start:enabled').waitFor();
// Stop and retry microphone preflight without consuming the one-shot voice admission.
await page.getByRole('button',{name:'Stop microphone',exact:true}).click();
await page.locator('#track-state').filter({hasText:'not started'}).waitFor();
await page.getByRole('button',{name:'Check microphone',exact:true}).click();
await page.locator('#start:enabled').waitFor();
const progressUrl=new URL(process.argv[1]);progressUrl.pathname='/test-input-count';
if((await (await page.request.get(progressUrl.href)).json()).opens!==0)throw Error('Provider opened before explicit Start');
await page.getByRole('button',{name:'Start voice',exact:true}).click();
await page.locator('#state').filter({hasText:'Listening.'}).waitFor({timeout:10000});
await page.locator('#microphone').filter({hasText:'Microphone:'}).waitFor();
await page.locator('#mic-signal').filter({hasText:'Microphone signal detected'}).waitFor({timeout:10000});
const deadline=Date.now()+10000;
while((await (await page.request.get(progressUrl.href)).json()).chunks<25){if(Date.now()>deadline)throw Error('PCM progress timeout');await new Promise(resolve=>setTimeout(resolve,50));}
await page.getByRole('button',{name:'Stop voice',exact:true}).click();
await page.locator('#track-state').filter({hasText:'not started'}).waitFor();
console.log('Synthetic browser audio path completed');
} finally { await browser.close(); }'''
                    process = await asyncio.create_subprocess_exec('node', '--input-type=module', '-e', script, url,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
                    try:
                        output, error = await asyncio.wait_for(process.communicate(), 40)
                    finally:
                        if process.returncode is None:
                            try:
                                os.killpg(process.pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                            try:
                                await asyncio.wait_for(process.wait(), 3)
                            except asyncio.TimeoutError:
                                try:
                                    os.killpg(process.pid, signal.SIGKILL)
                                except ProcessLookupError:
                                    pass
                                await process.wait()
                    self.assertEqual(process.returncode, 0, (output + error).decode()[-2000:])
                    for _ in range(100):
                        if snapshots:
                            break
                        await asyncio.sleep(.01)
                self.assertGreaterEqual(observed['chunks'], 20)
                self.assertGreater(observed['nonzero'], 0)
                self.assertEqual(observed['bytes'], observed['chunks'] * 3200)
                self.assertTrue(snapshots)
                timing = snapshots[-1]
                self.assertEqual(timing['input']['sentChunks'], observed['chunks'])
                self.assertEqual(timing['input']['receivedChunks'], observed['chunks'])
                self.assertEqual(timing['counts']['browser_pcm'], observed['chunks'])
                self.assertGreater(timing['input']['maxPeak'], 0)
                self.assertNotIn('final_transcript', timing['counts'])
                self.assertNotIn('failure', timing['counts'])
                self.assertEqual(timing['counts'].get('closed'), 1)
            finally:
                await local_server.close()
                await provider_server.close()


if __name__ == '__main__':
    unittest.main()
