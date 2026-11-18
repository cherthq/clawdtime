"""Real browser stale-frame/Stop checks; only synthetic pixels and fake audio."""
import asyncio
import io
import os
from pathlib import Path
import signal
import time
import unittest

from aiohttp import web
from aiohttp.test_utils import TestServer
from PIL import Image


class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_pcm_timeline_is_contiguous_bounded_and_stop_fences_late_receipts(self):
        async def route(request):
            if request.path == '/':
                return web.Response(text=Path(__file__).with_name('task_presentation_local.html').read_text(), content_type='text/html')
            if request.path == '/frame':
                return web.Response(status=410)
            return web.json_response({'ready': True, 'state': 'visible'})
        app = web.Application()
        app.router.add_route('*', '/{tail:.*}', route)
        server = TestServer(app)
        await server.start_server()
        script = r'''import {chromium} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.addInitScript(()=>{
 window.sources=[];window.acks=[];
 window.AudioContext=class {state='suspended';origin=performance.now();destination={};get currentTime(){return(performance.now()-this.origin)/1000;}async resume(){this.state='running';}async close(){this.state='closed';}
 createBuffer(channels,length,rate){if(channels!==1||rate!==16000)throw Error('Format changed');const samples=new Float32Array(length);return{duration:length/rate,getChannelData:()=>samples};}
 createBufferSource(){const context=this;return{connect(){},start(at){this.at=at;this.lead=at+this.buffer.duration-context.currentTime;this.samples=Array.from(this.buffer.getChannelData(0));window.sources.push(this);this.timer=setTimeout(()=>this.onended?.(),Math.max(0,(at+this.buffer.duration-context.currentTime)*1000));},stop(){clearTimeout(this.timer);this.stopped=true;}};}};
 window.WebSocket=class {static OPEN=1;readyState=1;constructor(){window.fixtureSocket=this;queueMicrotask(()=>this.onopen?.());}send(value){window.acks.push(JSON.parse(value));}close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}};
 });await page.goto(process.argv[1]);await page.locator('#start:enabled').waitFor();await page.locator('#start').click();
 await page.waitForFunction(()=>document.getElementById('state').textContent==='Ready for the prepared walkthrough.');
 await page.evaluate(async()=>{
 const expected=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 function send(index){const bytes=new Uint8Array(960),view=new DataView(bytes.buffer);for(let j=0;j<480;j++){const sample=Math.round(Math.sin((index*480+j)*2*Math.PI*440/16000)*8192);view.setInt16(j*2,sample,true);expected.push(sample/32768);}fixtureSocket.onmessage({data:JSON.stringify({kind:'audio',id:index+1,epoch:0,pcm:btoa(String.fromCharCode(...bytes))})});}
 for(let i=0;i<12;i++){while(sources.length-acks.length>=4)await sleep(1);if(i>=4)await sleep(8);send(i);}
 while(acks.length<12)await sleep(1);
 for(let i=0;i<12;i++){if(sources[i].lead>.200001)throw Error('Unbounded lead');if(Math.abs(sources[i].buffer.duration-.03)>1e-12)throw Error('PCM duration changed');if(i&&Math.abs(sources[i].at-sources[i-1].at-.03)>1e-6)throw Error('Gap or overlap between adjacent PCM chunks');}
 const decoded=sources.slice(0,12).flatMap(source=>source.samples);if(decoded.length!==expected.length||decoded.some((sample,i)=>sample!==expected[i]))throw Error('PCM endian, scaling or continuity changed');
 for(let i=12;i<16;i++)send(i);const late=sources.slice(12).map(source=>source.onended);document.getElementById('stop').click();for(const callback of late)callback();
 if(acks.length!==12||sources.slice(12).some(source=>!source.stopped))throw Error('Stop failed to cancel queued samples or late receipts');
 });await page.close();
}finally{await browser.close();}'''
        process = None
        try:
            process = await asyncio.create_subprocess_exec('node', '--input-type=module', '-e', script, str(server.make_url('/')) + '#synthetic',
                cwd=Path(__file__).resolve().parents[1], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
            _, stderr = await asyncio.wait_for(process.communicate(), 20)
            self.assertEqual(process.returncode, 0, stderr.decode()[-2500:])
        finally:
            if process and process.returncode is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            await server.close()

    async def test_stalled_frame_clears_and_stop_fences_delayed_start_and_decode(self):
        events = {'audio': 0, 'closed': 0, 'start': 0, 'stop': 0, 'frames': 0, 'paint': 0, 'terminal': False}
        gate = asyncio.Event()
        stop_gate = asyncio.Event()
        frame_times = []
        data = io.BytesIO()
        Image.new('RGB', (1280, 720), '#568cab').save(data, 'JPEG')
        async def index(request):
            return web.Response(text=Path(__file__).with_name('task_presentation_local.html').read_text(), content_type='text/html')
        async def bootstrap(request):
            return web.json_response({'ready': True})
        async def start(request):
            events['start'] += 1
            return web.json_response({'started': True})
        async def stop(request):
            events['stop'] += 1
            await stop_gate.wait()
            return web.json_response({})
        async def paint(request):
            events['paint'] += 1
            return web.json_response({'received': True})
        async def release(request):
            gate.set()
            return web.json_response({})
        async def status(request):
            return web.json_response({'state': 'stopped' if events['terminal'] else 'visible',
                'diagnostics': {'runtime': {'failure': {'reason': 'operation_failed'} if events['terminal'] else None}}})
        async def terminal(request):
            events['terminal'] = True
            return web.json_response({})
        async def frame(request):
            events['frames'] += 1
            if events['frames'] <= 12:
                frame_times.append(time.monotonic())
            if events['frames'] >= 13 and not gate.is_set():
                await gate.wait()
            return web.Response(body=data.getvalue(), content_type='image/jpeg', headers={'X-Captured-At-Ms': str(time.time() * 1000), 'X-Frame-Token': 'synthetic'})
        async def audio(request):
            events['audio'] += 1
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            async for _ in ws:
                pass
            events['closed'] += 1
            return ws
        async def counts(request):
            return web.json_response(dict(events, cadenceMs=(frame_times[-1] - frame_times[0]) * 1000 if len(frame_times) == 12 else None))
        app = web.Application()
        app.router.add_get('/', index)
        app.router.add_post('/bootstrap', bootstrap)
        app.router.add_post('/local/start', start)
        app.router.add_post('/local/stop', stop)
        app.router.add_post('/preview/paint', paint)
        app.router.add_post('/release', release)
        app.router.add_get('/preview/status', status)
        app.router.add_post('/terminal', terminal)
        app.router.add_get('/frame', frame)
        app.router.add_get('/audio', audio)
        app.router.add_get('/counts', counts)
        server = TestServer(app)
        await server.start_server()
        script = r'''import {chromium} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
const fake=`window.AudioContext=class {state='suspended';async resume(){if(window.holdResume)await new Promise(r=>window.resumeRelease=r);this.state='running';}async close(){this.state='closed';}}`;
try{
 const delayed=await browser.newPage();await delayed.addInitScript(fake+';window.holdResume=true;');
 await delayed.goto(process.argv[1]);await delayed.locator('#start:enabled').waitFor();await delayed.locator('#start').click();
 await delayed.waitForFunction(()=>!!window.resumeRelease);await delayed.locator('#stop').click();
 await delayed.evaluate(()=>window.resumeRelease());await delayed.waitForTimeout(100);
 let counts=await (await delayed.request.get(new URL('/counts',process.argv[1]).href)).json();
 if(counts.audio||counts.start)throw Error('Stopped delayed Start opened resources');await delayed.close();
 const page=await browser.newPage();await page.addInitScript(fake);await page.goto(process.argv[1]);
 await page.locator('#start:enabled').waitFor();await page.locator('#start').click();await page.locator('#view:visible').waitFor();
 await page.waitForFunction(async()=>{const c=await(await fetch('/counts')).json();return c.cadenceMs!==null;});
 counts=await(await page.request.get(new URL('/counts',process.argv[1]).href)).json();
 if(counts.cadenceMs>1000)throw Error('Frame cadence adds a full idle period after decode/paint work');
 await page.locator('#view').waitFor({state:'hidden',timeout:2500});
 await page.evaluate(()=>{window.decodeRelease=null;window.Image.prototype.decode=()=>new Promise(r=>window.decodeRelease=r);});
 await page.request.post(new URL('/release',process.argv[1]).href);
 await page.waitForFunction(()=>!!window.decodeRelease);await page.locator('#stop').click();await page.evaluate(()=>window.decodeRelease());
 await page.waitForTimeout(200);if(await page.locator('#view').isVisible())throw Error('Late decoded frame restored stopped pixels');
 counts=await(await page.request.get(new URL('/counts',process.argv[1]).href)).json();
 if(counts.closed!==1)throw Error('Stop waited for stalled POST before closing audio socket');
 if(counts.paint<1)throw Error('Decoded frame never acknowledged');
 await page.close();
 const terminalPage=await browser.newPage();await terminalPage.addInitScript(fake);await terminalPage.goto(process.argv[1]);
 await terminalPage.locator('#start:enabled').waitFor();await terminalPage.locator('#start').click();
 await terminalPage.locator('#view:visible').waitFor();await terminalPage.request.post(new URL('/terminal',process.argv[1]).href);
 await terminalPage.waitForFunction(()=>document.getElementById('state').textContent==='Walkthrough stopped. Narration could not complete.');
 if(await terminalPage.locator('#view').isVisible())throw Error('Host terminal state retained pixels');
 counts=await(await terminalPage.request.get(new URL('/counts',process.argv[1]).href)).json();
 if(counts.closed!==2)throw Error('Host terminal state retained audio socket');await terminalPage.close();
}finally{await browser.close();}'''
        process = None
        try:
            process = await asyncio.create_subprocess_exec('node', '--input-type=module', '-e', script, str(server.make_url('/')) + '#synthetic',
                cwd=Path(__file__).resolve().parents[1], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
            stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
            self.assertEqual(process.returncode, 0, stderr.decode()[-3000:])
            self.assertEqual(events['audio'], 2)
            self.assertEqual(events['start'], 2)
        finally:
            gate.set()
            stop_gate.set()
            if process and process.returncode is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            await server.close()
