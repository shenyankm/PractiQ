import io
import uuid

from PIL import Image
from conftest import write
from practiq_backend.worker import claim, complete
from test_product import make_import, parsed


def test_empty_draft_fill_publish_clear_and_hidden_answers(client):
    bank = write(client, 'POST', '/banks', {'name': '草稿'}).json()['data']
    r = write(client, 'POST', f"/banks/{bank['id']}/questions", {})
    assert r.status_code == 201, r.text
    q = r.json()['data']; qid = q['id']
    assert q['stem'] is None and q['answer_mode'] is None and q['options'] == []
    assert q['missingFields'] == ['stem','questionTypeId','answerMode','answerPayload','analysis','sourceText']
    forged = write(client, 'PATCH', f'/questions/{qid}', {'missingFields': []})
    assert forged.status_code == 422
    blocked = write(client, 'POST', f'/questions/{qid}/publish')
    assert blocked.status_code == 409
    assert blocked.json()['error']['details']['missingFields'] == q['missingFields']
    filled = write(client, 'PATCH', f'/questions/{qid}', {'questionTypeId':'true_false','answerMode':'true_false','stem':'0 > 1','sourceText':'0 > 1，答案：错误','analysis':'零小于一','answerPayload':{'value':False}})
    assert filled.status_code == 200, filled.text
    q = filled.json()['data']
    assert q['missingFields'] == [] and q['status'] == 'draft'
    assert q['answer_keys'][-1]['answer_payload'] == {'answer':False}
    assert write(client, 'POST', f'/questions/{qid}/publish').json()['data']['status'] == 'active'
    public = client.get(f'/api/v1/questions/{qid}').json()['data']
    assert all(k not in public for k in ('sourceText','source_text','draftAnswerPayload','draft_answer_payload','answer_keys','analysis'))
    cleared = write(client,'PATCH',f'/questions/{qid}',{'analysis':'   '}).json()['data']
    assert cleared['analysis'] is None and cleared['missingFields'] == ['analysis'] and cleared['status']=='draft'
    listed = client.get(f"/api/v1/banks/{bank['id']}/items?incomplete=true").json()['data']
    assert [x['id'] for x in listed] == [qid]


def test_partial_options_answers_and_invalid_values(client, content):
    bid = content[0]['id']
    r = write(client,'POST',f'/banks/{bid}/questions',{'questionTypeId':'choice','answerMode':'choice','stem':'选择','choiceVariant':'single','options':[{'label':'A','content':None},{'content':'1'}], 'answerPayload':{'correctOption':'A'}})
    assert r.status_code == 201, r.text
    q = r.json()['data']; qid=q['id']
    assert q['draftAnswerPayload']=={'correctOption':'A'} and q['answer_keys']==[]
    assert 'options' in q['missingFields'] and 'answerPayload' in q['missingFields']
    fixed=write(client,'PATCH',f'/questions/{qid}',{'options':[{'label':'A','content':'0'},{'label':'B','content':'1'}],'analysis':'选择零','sourceText':'选择零，A.0 B.1'} )
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()['data']['missingFields']==[]
    assert write(client,'PATCH',f'/questions/{qid}',{'answerPayload':{'value':True}}).status_code==422
    assert write(client,'PATCH',f'/questions/{qid}',{'answerPayload':{'correct':['Z']}}).status_code==422
    assert write(client,'PATCH',f'/questions/{qid}',{'stem':23}).status_code==422


def test_import_partial_questions_dependencies_and_recompute(client,app,content):
    j=make_import(client,content[0]['id']); t=claim(app.state.pool,uuid.uuid4())
    result=parsed()
    result['questions']=[{'stem':None,'answerMode':None,'questionTypeId':None,'sourceText':'见图回答。','missingFields':['media','material']}, {'stem':'0 > 1','answerMode':'true_false','questionTypeId':'not-a-real-type','answerPayload':{'value':False},'analysis':'零小于一','sourceText':'0 > 1'}]
    assert complete(app.state.pool,t,result,[{'callId':'partial'}])
    outputs=client.get(f"/api/v1/import-jobs/{j['id']}/outputs").json()['data']
    assert len(outputs)==2
    qid=outputs[0]['question_id']
    q=client.get(f'/api/v1/questions/{qid}/management').json()['data']
    assert q['stem'] is None and 'media' in q['missingFields'] and 'material' in q['missingFields']
    other=client.get(f"/api/v1/questions/{outputs[1]['question_id']}/management").json()['data']
    assert other['question_type_id'] is None and 'questionTypeId' in other['missingFields']
    raw=io.BytesIO(); Image.new('RGB',(2,2)).save(raw,format='PNG')
    media=write(client,'POST','/media',files={'file':('image.png',raw.getvalue(),'image/png')}).json()['data']
    assert write(client,'POST',f'/questions/{qid}/media-links',{'mediaId':media['id']}).status_code==201
    group=write(client,'POST',f"/banks/{content[0]['id']}/groups",{'title':'材料','instructions':'原始阅读材料'}).json()['data']
    attached=write(client,'PATCH',f'/questions/{qid}',{'groupId':group['id']}).json()['data']
    assert 'media' not in attached['missingFields'] and 'material' not in attached['missingFields']
    write(client,'DELETE',f"/questions/{qid}/media-links/{media['id']}")
    write(client,'PATCH',f"/groups/{group['id']}",{'title':'材料','instructions':''})
    q=client.get(f'/api/v1/questions/{qid}/management').json()['data']
    assert 'media' in q['missingFields'] and 'material' in q['missingFields']


def test_answer_versions_and_existing_session_guard(client,content):
    bank,q=content; qid=q['id']
    s=write(client,'POST','/practice-sessions',{'bankId':bank['id'],'mode':'all'}).json()['data']
    key=write(client,'POST',f'/questions/{qid}/answer-keys',{'answerMode':'choice','answerPayload':{'correct':['B']}})
    assert key.status_code==201
    assert client.get(f'/api/v1/questions/{qid}/management').json()['data']['status']=='active'
    write(client,'PATCH',f'/questions/{qid}',{'sourceText':None})
    response=client.get(f"/api/v1/practice-sessions/{s['id']}/questions")
    assert response.status_code==409 and response.json()['error']['code']=='QUESTION_INCOMPLETE'
    assert len(client.get(f'/api/v1/questions/{qid}/management').json()['data']['answer_keys'])==2


def test_unknown_items_partial_order_and_nested_blank_survive(client, content):
    bid = content[0]['id']
    response = write(client, 'POST', f'/banks/{bid}/questions', {'stem':'排列','items':[{'content':'甲'},{'content':'乙'}],'answerPayload':{'order':[0]}})
    assert response.status_code == 201, response.text
    q = response.json()['data']
    assert len(q['items']) == 2 and q['draftAnswerPayload'] == {'order':[0]}
    updated = write(client, 'PATCH', f"/questions/{q['id']}", {'questionTypeId':'ordering','answerMode':'ordering'})
    assert updated.status_code == 200, updated.text
    q = updated.json()['data']
    assert len(q['items']) == 2 and q['draftAnswerPayload'] == {'order':[0]} and q['answer_keys'] == []
    fixed = write(client, 'PATCH', f"/questions/{q['id']}", {'answerPayload':{'order':[i['id'] for i in q['items']]},'sourceText':'排列甲乙','analysis':'甲在乙前'})
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()['data']['missingFields'] == []
    partial = write(client, 'PATCH', f"/questions/{q['id']}", {'answerPayload':{'order':[q['items'][0]['id'],None]}})
    assert partial.status_code == 200, partial.text
    assert partial.json()['data']['draftAnswerPayload'] == {'order':[0,None]}
    blank = write(client,'POST',f'/banks/{bid}/questions',{'answerMode':'fill_blank','answerPayload':{'answers':['0','  ']}})
    assert blank.status_code == 201, blank.text
    assert blank.json()['data']['draftAnswerPayload'] == {'answers':['0',None]}


def test_answer_task_incomplete_success_retains_dependency_and_usage(client,app,content):
    qid=content[1]['id']
    r=write(client,'POST',f'/questions/{qid}/ai-answer-tasks')
    assert r.status_code==201, r.text
    task=claim(app.state.pool,uuid.uuid4())
    assert complete(app.state.pool,task,{'answerPayload':None,'missingFields':['media']},[{'callId':'missing-image','totalTokens':7}])
    result=client.get(f"/api/v1/ai-tasks/{task['id']}")
    assert result.status_code==200, result.text
    assert result.json()['data']['status']=='succeeded'
    q=client.get(f'/api/v1/questions/{qid}/management').json()['data']
    assert 'media' in q['missingFields'] and q['status']=='draft'
    with app.state.pool.connection() as db:
        assert db.execute('select count(*) as n from ai_task_calls where task_id=%s',(task['id'],)).fetchone()['n']==1


def test_partial_answers_still_reject_conflicts(client, content):
    bid=content[0]['id']
    invalid=write(client,'POST',f'/banks/{bid}/questions',{'answerMode':'ordering','items':[{'content':'甲'},{'content':'乙'}],'answerPayload':{'order':[0,0,None]}})
    assert invalid.status_code==422, invalid.text
    invalid=write(client,'POST',f'/banks/{bid}/questions',{'answerMode':'true_false','answerPayload':{'value':False,'answer':True}})
    assert invalid.status_code==422, invalid.text


def test_answer_without_items_is_retained_as_draft(client, content):
    bid=content[0]['id']
    r=write(client,'POST',f'/banks/{bid}/questions',{'answerMode':'ordering','answerPayload':{'order':[0,1]}})
    assert r.status_code==201, r.text
    q=r.json()['data']
    assert q['draftAnswerPayload']=={'order':[0,1]} and q['answer_keys']==[] and 'items' in q['missingFields']
