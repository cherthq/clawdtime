"""Explicit live-provider smoke: synthetic PCM only; never invokes Chert or FaceTime.

Run with LIVEKIT_* and DEEPGRAM_API_KEY in the environment. Creates and removes
one isolated room and temporary local policy server. Consumes provider credits.
"""
import asyncio
import json
import os
import tempfile
import uuid
from pathlib import Path
from aiohttp import ClientSession, web
from livekit import rtc
from server import Service


async def main():
    if not all(os.getenv(k) for k in ['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','DEEPGRAM_API_KEY']):
        raise RuntimeError('Configure fresh media provider credentials first.')
    sid='ct_'+uuid.uuid4().hex+uuid.uuid4().hex[:8]
    captions = os.getenv('MEDIA_SMOKE_CAPTIONS') == 'true'
    captured=[]
    state={'state':'listening'}
    async def policy(request):
        return web.json_response({'state':state['state'],'callId':'synthetic-call','expiresAt':'2099-01-01T00:00:00Z', 'captionsEnabled':captions, 'title':'Synthetic launch review'})
    async def segment(request):
        item=await request.json();captured.append(item['text'])
        if 'pause notes' in item['text'].lower():state['state']='paused'
        return web.json_response({'captured':True})
    app=web.Application();app.router.add_get('/media/{id}/policy',policy);app.router.add_post('/media/{id}/segments',segment)
    runner=web.AppRunner(app);await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
    port=site._server.sockets[0].getsockname()[1]
    with tempfile.TemporaryDirectory() as directory:
        service=Service({**os.environ,'MEDIA_API_KEY':'s'*40,'BACKEND_URL':f'http://127.0.0.1:{port}','MEDIA_DATABASE_PATH':str(Path(directory)/'media.sqlite'), 'MEDIA_CAPTIONS_ENABLED':str(captions).lower()})
        media_runner=web.AppRunner(service.app());await media_runner.setup();media_site=web.TCPSite(media_runner,'127.0.0.1',0);await media_site.start()
        media_port=media_site._server.sockets[0].getsockname()[1]
        room=rtc.Room();source=None;listen_tasks=[];received=[];video_frames=[]
        @room.on('track_subscribed')
        def subscribed(track,publication,participant):
            if participant.identity != 'notes-' + sid:
                raise RuntimeError('Unexpected synthetic publisher')
            async def listen():
                if track.kind == rtc.TrackKind.KIND_VIDEO:
                    async for event in rtc.VideoStream(track, capacity=2):
                        video_frames[:] = [(event.frame.width, event.frame.height)]
                    return
                async for frame in rtc.AudioStream(track,capacity=10,sample_rate=48000,num_channels=1):
                    received.append(max(abs(sample) for sample in frame.frame.data))
                    if len(received)>3000:received.pop(0)
            listen_tasks.append(asyncio.create_task(listen()))
        try:
            async with ClientSession(headers={'Authorization':'Bearer '+'s'*40}) as http:
                base=f'http://127.0.0.1:{media_port}'
                async with http.post(base+'/sessions',json={'id':sid,'meetingId':'synthetic','lineId':'synthetic', **({'captions':True} if captions else {})}) as r:
                    if r.status!=200:raise RuntimeError('Media prepare failed '+str(r.status))
                    prepared=await r.json()
                await room.connect(os.environ['LIVEKIT_URL'],prepared['credentials']['participant_token'])
                source=rtc.AudioSource(48000,1,queue_size_ms=100)
                await room.local_participant.publish_track(rtc.LocalAudioTrack.create_audio_track('synthetic',source),rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
                for _ in range(50):
                    if len(received)>=10:break
                    await asyncio.sleep(.1)
                if not received:raise RuntimeError('No subscribed PCM before activation')
                if max(received)>64:raise RuntimeError('Pre-activation audio peak exceeds codec silence tolerance: '+str(max(received)))
                if captions:
                    for _ in range(50):
                        if video_frames:break
                        await asyncio.sleep(.1)
                    if not prepared.get('videoPublisherReady') or not video_frames:raise RuntimeError('Caption video was not decoded')
                    if video_frames[-1] != (1280,720):raise RuntimeError('Caption resolution mismatch')
                async with http.post(base+f'/sessions/{sid}/activate',json={'callId':'synthetic-call'}) as r:
                    if r.status!=200:raise RuntimeError('Activation failed '+str(r.status))
                    await r.read()
                if max(received)<=64:raise RuntimeError('Notice audio was not received')
                for _ in range(50):
                    if service.sessions[sid].stream and service.sessions[sid].ws:break
                    await asyncio.sleep(.1)
                if not service.sessions[sid].stream:raise RuntimeError('STT subscription was not ready')
                async def inject(text):
                    async with http.post('https://api.deepgram.com/v1/speak',params={'model':'aura-2-thalia-en','encoding':'linear16','container':'none','sample_rate':'48000','mip_opt_out':'true'},headers={'Authorization':'Token '+os.environ['DEEPGRAM_API_KEY']},json={'text':text}) as r:
                        if r.status!=200:raise RuntimeError('Synthetic TTS failed '+str(r.status))
                        pcm=await r.read()
                    pcm+=bytes(48000*2*2)
                    for offset in range(0,len(pcm),1920):
                        await source.capture_frame(rtc.AudioFrame(pcm[offset:offset+1920].ljust(1920,b'\0'),48000,1,960));await asyncio.sleep(.02)
                await inject('The synthetic launch review is scheduled for Friday.')
                for _ in range(50):
                    if any('friday' in t.lower() for t in captured):break
                    await asyncio.sleep(.1)
                if not any('friday' in t.lower() for t in captured):raise RuntimeError('Synthetic transcript missing')
                if captions and not service.sessions[sid].caption_scene.snapshot()['segments']:raise RuntimeError('Accepted transcript missing from caption scene')
                utterance={'id':'synthetic-recap','callId':'synthetic-call','text':'The launch review is Friday.'}
                async with http.post(base+f'/sessions/{sid}/speak',json=utterance) as r:
                    if r.status!=202:raise RuntimeError('Speech was not accepted')
                    receipt=await r.json()
                    if receipt['state'] != 'accepted':raise RuntimeError('Unexpected initial receipt')
                for _ in range(150):
                    async with http.get(base+f'/sessions/{sid}/speech/synthetic-recap') as r:
                        receipt=await r.json()
                    if receipt['state'] in {'completed','failed','cancelled','unknown'}:break
                    await asyncio.sleep(.1)
                if receipt['state'] != 'completed':raise RuntimeError('Speech playout not completed')
                async with http.post(base+f'/sessions/{sid}/speak',json=utterance) as r:
                    duplicate=await r.json()
                    if r.status != 200 or duplicate != receipt:raise RuntimeError('Speech retry changed terminal receipt')
                await asyncio.sleep(.8)
                await inject('Hey ClawdTime, pause notes.')
                for _ in range(80):
                    if state['state']=='paused':break
                    await asyncio.sleep(.1)
                if not any('friday' in t.lower() for t in captured):raise RuntimeError('Synthetic transcript missing')
                if state['state']!='paused':raise RuntimeError('Voice pause did not reach policy')
                await asyncio.sleep(.7)
                if service.sessions[sid].allowed:raise RuntimeError('STT still allowed after pause')
                if captions and service.sessions[sid].caption_scene.snapshot()['segments']:raise RuntimeError('Private captions remained after pause')
                state['state']='listening';await asyncio.sleep(.8)
                if not service.sessions[sid].allowed:raise RuntimeError('Text policy resume failed')
                async with http.post(base+f'/sessions/{sid}/close',json={}) as r:
                    if r.status!=200:raise RuntimeError('Cleanup failed')
                print(json.dumps({'silentBeforeActivation':True,'noticeReceived':True,'livekitAudio':True,'syntheticTranscription':True,'voicePause':True,'textResume':True,'speechCompleted':True,'speechRetryDeduplicated':True,'captionVideoDecoded':captions,'captionPrivacyCleared':captions,'cleanup':True}))
        finally:
            for task in listen_tasks:task.cancel()
            await asyncio.gather(*listen_tasks,return_exceptions=True)
            if source:await source.aclose()
            await room.disconnect();await media_runner.cleanup();await runner.cleanup()


if __name__=='__main__':
    asyncio.run(asyncio.wait_for(main(),70))
