import pytest
from pydantic import ValidationError

from practiq_ai.contracts import ParsedQuestion


@pytest.mark.parametrize('value', [None, '', '   '])
def test_missing_scalars_are_null_and_list_is_derived(value):
    q=ParsedQuestion.model_validate({'stem':value,'sourceText':'原文中仅有图片占位','options':None,'missingFields':[]})
    result=q.model_dump(mode='json')
    assert result['stem'] is None and result['options']==[] and result['answerPayload'] is None
    assert result['missingFields']==['stem','questionTypeId','answerMode','answerPayload','analysis']
    assert result['needsReview'] is True


def test_false_zero_optional_fields_and_dependencies():
    base={'stem':'0 > 1','questionTypeId':'true_false','answerMode':'true_false','answerPayload':{'value':False},'analysis':'零小于一','sourceText':'0 > 1，错误'}
    q=ParsedQuestion.model_validate(base)
    assert q.missingFields==[] and q.model_dump()['answerPayload']=={'value':False}
    q=ParsedQuestion.model_validate({**base,'missingFields':['media','media','stem','material']})
    assert q.missingFields==['media','material']
    short=ParsedQuestion.model_validate({**base,'answerMode':'short_answer','answerPayload':{'text':'0'}})
    assert short.missingFields==[]
    with pytest.raises(ValidationError):
        ParsedQuestion.model_validate({**base,'answerPayload':{'value':'false'}})


def test_partial_nested_answer_and_unknown_type_are_retained():
    q=ParsedQuestion.model_validate({'stem':'填两个空','answerMode':'fill_blank','answerPayload':{'answers':['0',None]}})
    assert q.model_dump()['answerPayload']=={'answers':['0',None]}
    assert 'answerPayload' in q.missingFields
    with pytest.raises(ValidationError):
        ParsedQuestion.model_validate({'stem':'填两个空','answerMode':'fill_blank','answerPayload':{'answers':[9,None]}})
    with pytest.raises(ValidationError):
        ParsedQuestion.model_validate({})


def test_ordering_matching_and_multiple_choice_fields():
    base={'stem':'排列','questionTypeId':'ordering','answerMode':'ordering','sourceText':'排列这些项','analysis':'按顺序','items':[{'content':'甲'},{'content':'乙'}]}
    q=ParsedQuestion.model_validate({**base,'answerPayload':{'order':[0]}})
    assert q.missingFields==['answerPayload']
    q=ParsedQuestion.model_validate({**base,'answerPayload':{'order':[0,1]}})
    assert q.missingFields==[]
    with pytest.raises(ValidationError):
        ParsedQuestion.model_validate({**base,'answerPayload':{'order':[1,1]}})
    q=ParsedQuestion.model_validate({'stem':'选择多个','answerMode':'choice','choiceVariant':'multiple','options':[{'label':'A','content':'0'},{'label':'B','content':'1'}],'answerPayload':{'correct':['A','B']}})
    assert 'answerPayload' not in q.missingFields


def test_whitespace_modes_and_partial_answers_normalize_to_null():
    q=ParsedQuestion.model_validate({'stem':'原题','answerMode':'  ','questionTypeId':'','choiceVariant':'  ','answerPayload':{'answers':['0','  ']}})
    assert q.answerMode is None and q.questionTypeId is None and q.choiceVariant is None
    assert q.model_dump()['answerPayload']=={'answers':['0',None]}


def test_partial_answer_does_not_hide_invalid_references():
    with pytest.raises(ValidationError):
        ParsedQuestion.model_validate({'stem':'排序','answerMode':'ordering','items':[{'content':'甲'},{'content':'乙'}],'answerPayload':{'order':[0,0,None]}})


@pytest.mark.parametrize('value', [True, '0', 0.0])
def test_group_indexes_reject_coercion(value):
    from practiq_ai.contracts import ParsedGroup

    with pytest.raises(ValidationError):
        ParsedGroup.model_validate({'title': 'Section', 'questionIndexes': [value]})
    assert ParsedGroup(title='Section', questionIndexes=[0]).questionIndexes == [0]


@pytest.mark.parametrize('value', [0, 1, 'false', 'true'])
def test_extraction_flags_reject_coercion(value):
    from practiq_ai.contracts import ParsedOption

    with pytest.raises(ValidationError):
        ParsedOption.model_validate({'isCorrect': value})
    with pytest.raises(ValidationError):
        ParsedQuestion.model_validate({'stem': 'Question', 'needsReview': value})
    assert ParsedQuestion(stem='Question', needsReview=False).needsReview  # Missing fields force review.
