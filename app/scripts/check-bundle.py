"""Exercise the actual bundled executable with synthetic models and native PDF rendering."""
import argparse
import hashlib
import json
import selectors
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

import httpx
import uvicorn
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'server'))
from scripts.recovery_provider import app_for


def fixtures(root):
    (root/'text.txt').write_text('1. Synthetic recovery question')
    (root/'table.csv').write_text('Question,Answer\nSynthetic recovery question,A\n')
    img=Image.new('RGB',(600,400),'white')
    img.save(root/'image.png')
    img.save(root/'document.pdf','PDF')
    return [('text.txt','text','text/plain'),('table.csv','csv','text/csv'),('image.png','image','image/png'),('document.pdf','pdf','application/pdf')]


def run(bundle,output):
    report={'bundle':str(bundle),'model':'synthetic-local-stub','checks':[],'passed':False}
    output.parent.mkdir(parents=True,exist_ok=True)
    assert not (bundle/'LibreOffice.app').exists(), 'Retired office suite was bundled'
    manifest=json.loads((bundle/'build-manifest.json').read_text())
    assert 'libreoffice' not in manifest
    assert 'python-docx' not in {p['name'].lower() for p in manifest['packages']}
    with tempfile.TemporaryDirectory(prefix='practiq-bundle-test-') as tmp:
        root=Path(tmp)
        sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(128)
        provider=uvicorn.Server(uvicorn.Config(app_for(root/'calls.jsonl'),log_level='error'))
        thread=threading.Thread(target=lambda:provider.run(sockets=[sock]),daemon=True);thread.start()
        bootstrap={'AI_SERVICE_TOKEN':'bundled-test-token','LLM_API_KEY':'synthetic-test-key','LLM_BASE_URL':f'http://127.0.0.1:{sock.getsockname()[1]}/v1','LLM_MODEL':'synthetic-model','AI_DATABASE_DIR':str(root/'db'),'AI_STORAGE_DIR':str(root/'files')}
        process=None
        try:
            with (root/'stderr.log').open('w') as log:
                process=subprocess.Popen([str(bundle/'python/practiq-ai'),'serve'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,
                    cwd=root,env={'PATH':'/usr/bin:/bin','HOME':str(root),'TMPDIR':tmp,'LANG':'en_US.UTF-8'},text=True)
                process.stdin.write(json.dumps(bootstrap)+'\n');process.stdin.flush()
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout,selectors.EVENT_READ)
                    if not selector.select(60):raise RuntimeError('Bundled startup timed out')
                line=process.stdout.readline()
                if not line:raise RuntimeError((root/'stderr.log').read_text()[-8000:])
                ready=json.loads(line)
                with httpx.Client(base_url=f"http://127.0.0.1:{ready['port']}",headers={'Authorization':'Bearer bundled-test-token'},timeout=30,trust_env=False) as client:
                    assert client.get('/ready').status_code==200
                    assert client.get('/api/document-tasks',headers={'Authorization':''}).status_code==401
                    assert client.get('/api/document-tasks').json()['items']==[]
                    assert client.post('/api/uploads',json={'sourceType':'xlsx','fileName':'removed.xlsx','mediaType':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','sha256':'a'*64,'sizeBytes':1}).status_code==422
                    report['removedExcelRejected']=True
                    for kind,media in [('doc','application/msword'),('docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')]:
                        assert client.post('/api/uploads',json={'sourceType':kind,'fileName':f'removed.{kind}','mediaType':media,'sha256':'a'*64,'sizeBytes':1}).status_code==422
                    report['removedWordRejected']=True
                    for extension in ['webp','gif']:
                        assert client.post('/api/uploads',json={'sourceType':'image','fileName':f'removed.{extension}','mediaType':f'image/{extension}','sha256':'a'*64,'sizeBytes':1}).status_code==422
                    report['removedImageFormatsRejected']=True
                    for filename,kind,media in fixtures(root):
                        data=(root/filename).read_bytes();started=time.monotonic()
                        response=client.post('/api/uploads',json={'sourceType':kind,'fileName':filename,'mediaType':media,'sha256':hashlib.sha256(data).hexdigest(),'sizeBytes':len(data)})
                        response.raise_for_status();prepared=response.json()
                        if prepared['upload']:client.put(prepared['upload']['url'],content=data).raise_for_status()
                        response=client.post('/api/document-tasks',json={'requestId':str(uuid4()),'document':prepared['document'],'failurePolicy':'return_partial'})
                        response.raise_for_status();task_id=response.json()['threadId']
                        deadline=time.monotonic()+180
                        while True:
                            state=client.get('/api/document-tasks/'+task_id).json()
                            if state.get('state') in {'COMPLETED','FAILED','WAITING_REVIEW'}:break
                            if time.monotonic()>deadline:raise RuntimeError(f'{filename} timed out: {state}')
                            time.sleep(.1)
                        report['checks'].append({'format':kind,'state':state.get('state'),'status':state.get('status'),'failures':state.get('failures'),'blocking':state.get('blocking'),'seconds':round(time.monotonic()-started,3),'modelCalls':len(state.get('usage',[]))})
                        assert state['state']=='COMPLETED' and not state['failures'], report['checks'][-1]
                        for visual in (state.get('result') or {}).get('visualElements',[]):
                            if visual.get('imageRef'):
                                reference=visual['imageRef'];image=client.post('/api/artifacts/read',json=reference)
                                image.raise_for_status();assert hashlib.sha256(image.content).hexdigest()==reference['sha256']
                    assert len(client.get('/api/document-tasks').json()['items'])==4
                    assert client.post('/api/subjective-grades',json={},headers={'Authorization':''}).status_code==401
                    grade_payload={'requestId':str(uuid4()),'question':{'stem':'Synthetic subjective question','answerMode':'short_answer','questionTypeId':'简答','answerPayload':{'text':'Reference evidence'}},'answer':'Student answer','maxCents':500}
                    raw_grade=json.dumps({k:v for k,v in grade_payload.items() if k!='requestId'},ensure_ascii=False,separators=(',',':'))
                    grade_payload={'requestId':grade_payload['requestId'],'inputDigest':hashlib.sha256(raw_grade.encode()).hexdigest(),'payload':raw_grade}
                    graded=client.post('/api/subjective-grades',json=grade_payload);graded.raise_for_status()
                    result=graded.json();assert result['status']=='graded' and result['result']['scoreCents']==300,result
                    assert len(result['usage'])==1 and len(result['calls'])==1
                    assert client.post('/api/subjective-grades',json=grade_payload).json()==result
                    report['subjectiveGrading']={'passed':True,'scoreCents':300,'replayIdentical':True,'usageCalls':len(result['usage'])}
                process.stdin.close();process.wait(timeout=20)
                assert process.returncode==0,(root/'stderr.log').read_text()[-8000:]
                report['passed']=True
        finally:
            if process and process.poll() is None:process.kill();process.wait()
            provider.should_exit=True;thread.join(timeout=5);sock.close()
            output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--bundle',type=Path,required=True);parser.add_argument('--output',type=Path,default=ROOT/'server/reports/checks/desktop-bundle.json');args=parser.parse_args()
    run(args.bundle.resolve(),args.output.resolve())
