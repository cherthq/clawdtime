"""Render synthetic camera evidence only; never reads real screens or config."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw
from camera import ScreenCamera
from camera_preview import fixture


def render(directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    snapshots=[]
    for kind in ('coding','finder','timeline'):
        now=[100.]
        binding={'sessionId':'fixture_session','deviceId':'fixture_device','leaseId':'fixture_lease','displayId':1,'surface':{'kind':'display','id':'1','displayId':1}}
        camera=ScreenCamera(binding,clock=lambda:now[0],wall=lambda:1000.)
        image=fixture(kind)
        source={'width':2560,'height':1440,'originX':-1280,'originY':0,'pointWidth':1280,'pointHeight':720,'displayOriginX':-1280,'displayOriginY':0,'displayPointWidth':1280,'displayPointHeight':720}
        camera.accept(image,'fixture_frame',1000.,{'version':1,'surface':binding['surface'],'geometryGeneration':'fixture_geometry','contentRevision':'fixture_content','source':source})
        serial=0
        def command(op,**extra):
            nonlocal serial
            serial+=1;state=camera.status();camera.command({'version':1,'commandId':str(serial),'expectedRevision':state['revision'],'sourceFrameId':state['sourceFrameId'],'geometryGeneration':state['geometryGeneration'],'op':op,**extra})
        camera.render().save(directory/(kind+'-overview.png'))
        command('focus_region',rect={'x':.14,'y':.18,'width':.52,'height':.38},durationMs=450)
        command('annotation_upsert',annotation={'id':'mark','kind':'highlight','rect':{'x':.19,'y':.26,'width':.35,'height':.14},'text':'Selected region · fixture only','ttlMs':8000})
        command('context',text='Review requested: the source pixels remain pristine.',ttlMs=8000)
        frames=[]
        for n in range(16):
            now[0]=100+n*.05;frames.append(camera.render().convert('RGB'))
        frames[0].save(directory/(kind+'-motion.gif'),save_all=True,append_images=frames[1:],duration=50,loop=0)
        camera.render().save(directory/(kind+'-focused.png'));snapshots.extend([Image.open(directory/(kind+'-overview.png')),camera.render()])
        command('freeze');camera.render().save(directory/(kind+'-paused.png'))
        camera.clear();camera.render().save(directory/(kind+'-stopped.png'))
    sheet=Image.new('RGB',(1280,1080),'#101722')
    for n,img in enumerate(snapshots):sheet.paste(img.convert('RGB').resize((640,360)),((n%2)*640,(n//2)*360))
    sheet.save(directory/'contact-sheet.png')
    return directory/'contact-sheet.png'

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('directory');args=parser.parse_args();print(render(args.directory))
