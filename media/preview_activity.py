"""Render synthetic phone fixtures only; no capture, server, credentials or calls.

Usage: media/.venv/bin/python media/preview_activity.py /tmp/clawdtime-phone-preview
"""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image
from captions import CaptionRenderer, CaptionScene


def render(directory):
    directory.mkdir(parents=True,exist_ok=True)
    renderer=CaptionRenderer()
    binding={'sessionId':'synthetic_session','memberId':'synthetic_member','deviceId':'synthetic_mac','displayId':1}
    previews=[]
    cases=[('executing','agent_observed'),('pending_approval','not_verified'),
           ('completed','agent_observed'),('completed','not_verified'),('uncertain','unknown'),('ended','unknown')]
    for index,(state,verification) in enumerate(cases):
        now=datetime.now(timezone.utc)
        scene=CaptionScene('synthetic')
        scene.apply_policy({'callId':'synthetic_call','state':'listening','captionsEnabled':True,
                            'expiresAt':(now+timedelta(seconds=20)).isoformat(),'presentationBinding':binding})
        scene.hearing('Synthetic correction — please check the selected example before continuing.')
        value={'version':1,'sequence':index+1,'delivery':'acknowledged','work':state,
               'currentSummary':'Résumé synthetic activity — verify selected example',
               'expiresAt':(now+timedelta(seconds=60)).isoformat(),
               'entries':[{'activityId':'synthetic_activity','sequence':index+1,'kind':'status',
                           'summary':'Résumé synthetic activity — verify selected example'}]}
        if state in ('completed','uncertain'):
            value['outcome']={'outcomeId':'synthetic_outcome','status':state,'verification':verification,'summary':'Synthetic result — verified only when explicitly observed'}
        if state=='ended':scene.clear('ended')
        else:scene.apply_presentation({**binding,'callId':'synthetic_call','callState':'connected',
                                      'expiresAt':(now+timedelta(seconds=5)).isoformat(),
                                      'presentationVersion':1,'activity':value},'synthetic_mac')
        for background in ('light','dark'):
            image=renderer.overlay(Image.new('RGBA',(1280,720),'#dce6ed' if background=='light' else '#496482'),scene.snapshot())
            image.save(directory/f'{index}-{state}-{verification}-{background}-landscape.png')
            portrait=image.crop((437,0,843,720))
            portrait.save(directory/f'{index}-{state}-{verification}-{background}-portrait.png')
            if background=='dark':previews.append(portrait)
    sheet=Image.new('RGB',(406*3,720*2),'white')
    for index,image in enumerate(previews):sheet.paste(image,(406*(index%3),720*(index//3)))
    sheet.save(directory/'contact-sheet.png')
    return directory/'contact-sheet.png'


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    print(render(parser.parse_args().directory))
