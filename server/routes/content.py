"""Content routes: banks, questions, groups.

Mirrors content.go / content_banks.go / content_questions.go / content_groups.go.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import envelope
from ..services import banks as banks_svc
from ..services import groups as groups_svc
from ..services import questions as questions_svc
from . import deps

router = APIRouter()


# ---------------------------------------------------------------- banks


@router.get('/api/v1/banks')
async def list_banks(request: Request):
    user = await deps.current_user(request)
    limit = deps.query_page_limit(request, 100)
    data = await banks_svc.list_banks(
        deps.pool(request), user,
        banks_svc.ListBanksParams(
            scope=request.query_params.get('scope', ''),
            subject=request.query_params.get('subject', ''),
            query=request.query_params.get('q', ''),
            limit=limit,
            cursor=request.query_params.get('cursor', ''),
        ),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/banks')
async def create_bank(request: Request):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'name', 'description', 'subject', 'isPublic'})
    details: list[envelope.ValidationDetail] = []
    name = body.get('name') if isinstance(body.get('name'), str) else ''
    name = name.strip()
    if not name or len(name) > 100:
        details.append(envelope.ValidationDetail('name', 'must be 1-100 characters'))
    description = body.get('description') if isinstance(body.get('description'), str) else None
    if description is not None:
        description = description.strip()
        if len(description) > 500:
            details.append(envelope.ValidationDetail('description', 'must be no more than 500 characters'))
    subject = body.get('subject') if isinstance(body.get('subject'), str) else ''
    if not subject.strip():
        details.append(envelope.ValidationDetail('subject', 'is required'))
    if details:
        raise envelope.validation_error(details)
    data = await banks_svc.create_bank(
        deps.pool(request), user, name, description, subject, bool(body.get('isPublic'))
    )
    return envelope.created(request, data)


@router.get('/api/v1/banks/{bank_id}')
async def get_bank(request: Request, bank_id: str):
    user = await deps.current_user(request)
    data = await banks_svc.get_bank(deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'))
    return envelope.ok(request, data)


@router.patch('/api/v1/banks/{bank_id}')
async def update_bank(request: Request, bank_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'name', 'description', 'isPublic'})
    details: list[envelope.ValidationDetail] = []
    name = body.get('name') if isinstance(body.get('name'), str) else None
    if name is not None:
        name = name.strip()
        if not name or len(name) > 100:
            details.append(envelope.ValidationDetail('name', 'must be 1-100 characters'))
    description_set = 'description' in body
    description = body.get('description') if isinstance(body.get('description'), str) else None
    if description is not None:
        description = description.strip()
        if len(description) > 500:
            details.append(envelope.ValidationDetail('description', 'must be no more than 500 characters'))
    if details:
        raise envelope.validation_error(details)
    is_public = body.get('isPublic') if isinstance(body.get('isPublic'), bool) else None
    data = await banks_svc.update_bank(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'),
        name, description, description_set, is_public,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/banks/{bank_id}')
async def delete_bank(request: Request, bank_id: str):
    user = await deps.current_user(request)
    await banks_svc.delete_bank(deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'))
    return envelope.no_content(request)


@router.get('/api/v1/banks/{bank_id}/items')
async def bank_items(request: Request, bank_id: str):
    user = await deps.current_user(request)
    limit = deps.query_page_limit(request, 100)
    data = await banks_svc.list_bank_items(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'),
        banks_svc.ListBankItemsParams(
            status=request.query_params.get('status', ''),
            type=request.query_params.get('type', ''),
            limit=limit,
            include_answers=request.query_params.get('includeAnswers') == 'true',
            cursor=request.query_params.get('cursor', ''),
        ),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.patch('/api/v1/banks/{bank_id}/items/reorder')
async def bank_items_reorder(request: Request, bank_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'items'})
    raw_items = body.get('items')
    if not isinstance(raw_items, list) or not raw_items:
        raise envelope.validation_error([envelope.ValidationDetail('items', 'must not be empty')])
    items: list[banks_svc.ReorderBankItem] = []
    ids: set[str] = set()
    sorts: set[int] = set()
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            raise envelope.invalid_json()
        sort_order = item.get('sortOrder') if isinstance(item.get('sortOrder'), int) else 0
        if sort_order <= 0 or sort_order > 2_147_483_647:
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'items.{index}.sortOrder', 'must be positive')]
            )
        question_id = item.get('questionId') if isinstance(item.get('questionId'), int) else None
        group_id = item.get('groupId') if isinstance(item.get('groupId'), int) else None
        if (question_id is None) == (group_id is None):
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'items.{index}', 'exactly one of questionId or groupId is required')]
            )
        key = f'q:{question_id}' if question_id is not None else f'g:{group_id}'
        if key in ids or sort_order in sorts:
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'items.{index}', 'item IDs and sortOrder values must be unique')]
            )
        ids.add(key)
        sorts.add(sort_order)
        items.append(banks_svc.ReorderBankItem(question_id=question_id, group_id=group_id, sort_order=sort_order))
    await banks_svc.reorder_bank_items(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'), items
    )
    return envelope.no_content(request)


@router.post('/api/v1/banks/{bank_id}/favorite')
async def bank_favorite_create(request: Request, bank_id: str):
    user = await deps.current_user(request)
    await banks_svc.set_favorite(deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'), True)
    return envelope.no_content(request)


@router.delete('/api/v1/banks/{bank_id}/favorite')
async def bank_favorite_delete(request: Request, bank_id: str):
    user = await deps.current_user(request)
    await banks_svc.set_favorite(deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'), False)
    return envelope.no_content(request)


@router.post('/api/v1/banks/{bank_id}/questions')
async def bank_question_create(request: Request, bank_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(
        request,
        {'questionTypeId', 'answerMode', 'stem', 'analysis', 'choiceVariant', 'status', 'options', 'answerPayload'},
    )
    options = []
    for option in body.get('options') or []:
        if not isinstance(option, dict):
            raise envelope.invalid_json()
        options.append(questions_svc.QuestionOptionInput(
            label=str(option.get('label', '')),
            content=str(option.get('content', '')),
            is_correct=bool(option.get('isCorrect')),
        ))
    data = await questions_svc.create_question(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'),
        questions_svc.CreateQuestionInput(
            question_type_id=str(body.get('questionTypeId', '')),
            answer_mode=str(body.get('answerMode', '')),
            stem=str(body.get('stem', '')),
            analysis=body.get('analysis') if isinstance(body.get('analysis'), str) else None,
            choice_variant=body.get('choiceVariant') if isinstance(body.get('choiceVariant'), str) else None,
            status=str(body.get('status', '')),
            options=options,
            answer_payload=body.get('answerPayload') if isinstance(body.get('answerPayload'), dict) else {},
        ),
    )
    return envelope.created(request, data)


@router.get('/api/v1/banks/{bank_id}/groups')
async def bank_groups(request: Request, bank_id: str):
    user = await deps.current_user(request)
    limit = deps.query_page_limit(request, 100)
    data = await groups_svc.list_bank_groups(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'),
        limit, request.query_params.get('cursor', ''),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/banks/{bank_id}/groups')
async def bank_group_create(request: Request, bank_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'title', 'instructions', 'groupTypeId', 'contentMode', 'status'})
    title = body.get('title') if isinstance(body.get('title'), str) else ''
    if not title.strip():
        raise envelope.validation_error([envelope.ValidationDetail('title', 'is required')])
    data = await groups_svc.create_group(
        deps.pool(request), user, deps.parse_path_id(bank_id, 'bankId'),
        groups_svc.CreateGroupInput(
            title=title,
            instructions=body.get('instructions') if isinstance(body.get('instructions'), str) else None,
            group_type_id=(body.get('groupTypeId') or '').strip() if isinstance(body.get('groupTypeId'), str) else '',
            content_mode=body.get('contentMode') if isinstance(body.get('contentMode'), str) else None,
            status=str(body.get('status', '')),
        ),
    )
    return envelope.created(request, data)


# ------------------------------------------------------------- questions


@router.get('/api/v1/questions/{question_id}')
async def question_get(request: Request, question_id: str):
    user = await deps.current_user(request)
    data = await questions_svc.get_question(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId')
    )
    return envelope.ok(request, data)


@router.patch('/api/v1/questions/{question_id}')
async def question_update(request: Request, question_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'stem', 'analysis'})
    data = await questions_svc.update_question(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId'),
        stem=body.get('stem') if isinstance(body.get('stem'), str) else None,
        analysis=body.get('analysis') if isinstance(body.get('analysis'), str) else None,
        analysis_set='analysis' in body,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/questions/{question_id}')
async def question_delete(request: Request, question_id: str):
    user = await deps.current_user(request)
    await questions_svc.delete_question(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId')
    )
    return envelope.no_content(request)


@router.post('/api/v1/questions/{question_id}/publish')
async def question_publish(request: Request, question_id: str):
    user = await deps.current_user(request)
    data = await questions_svc.set_question_status(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId'), 'active'
    )
    return envelope.ok(request, data)


@router.post('/api/v1/questions/{question_id}/archive')
async def question_archive(request: Request, question_id: str):
    user = await deps.current_user(request)
    data = await questions_svc.set_question_status(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId'), 'archived'
    )
    return envelope.ok(request, data)


@router.post('/api/v1/questions/{question_id}/options')
async def question_option_create(request: Request, question_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'label', 'content', 'isCorrect', 'sortOrder'})
    label = body.get('label') if isinstance(body.get('label'), str) else ''
    content = body.get('content') if isinstance(body.get('content'), str) else ''
    if not label.strip() or not content.strip():
        raise envelope.validation_error(
            [envelope.ValidationDetail('label', 'label and content are required')]
        )
    sort_order = body.get('sortOrder') if isinstance(body.get('sortOrder'), int) else None
    data = await questions_svc.create_option(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId'),
        label, content, bool(body.get('isCorrect')), sort_order,
    )
    return envelope.created(request, data)


@router.patch('/api/v1/questions/{question_id}/options/{option_id}')
async def question_option_update(request: Request, question_id: str, option_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'label', 'content', 'isCorrect', 'sortOrder'})
    data = await questions_svc.update_option(
        deps.pool(request), user,
        deps.parse_path_id(question_id, 'questionId'), deps.parse_path_id(option_id, 'optionId'),
        label=body.get('label') if isinstance(body.get('label'), str) else None,
        content=body.get('content') if isinstance(body.get('content'), str) else None,
        is_correct=body.get('isCorrect') if isinstance(body.get('isCorrect'), bool) else None,
        sort_order=body.get('sortOrder') if isinstance(body.get('sortOrder'), int) else None,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/questions/{question_id}/options/{option_id}')
async def question_option_delete(request: Request, question_id: str, option_id: str):
    user = await deps.current_user(request)
    await questions_svc.delete_option(
        deps.pool(request), user,
        deps.parse_path_id(question_id, 'questionId'), deps.parse_path_id(option_id, 'optionId'),
    )
    return envelope.no_content(request)


@router.put('/api/v1/questions/{question_id}/answer-key')
async def question_answer_key_put(request: Request, question_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(
        request, {'answerMode', 'answerPayload', 'explanationPayload', 'scorePayload'}
    )
    answer_mode = body.get('answerMode') if isinstance(body.get('answerMode'), str) else ''
    if not answer_mode.strip():
        raise envelope.validation_error([envelope.ValidationDetail('answerMode', 'is required')])
    data = await questions_svc.upsert_answer_key(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId'),
        answer_mode,
        body.get('answerPayload') if isinstance(body.get('answerPayload'), dict) else {},
        body.get('explanationPayload') if isinstance(body.get('explanationPayload'), dict) else {},
        body.get('scorePayload') if isinstance(body.get('scorePayload'), dict) else {},
    )
    return envelope.ok(request, data)


@router.put('/api/v1/questions/{question_id}/content-blocks')
async def question_content_blocks_put(request: Request, question_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'blocks'})
    raw_blocks = body.get('blocks')
    if not isinstance(raw_blocks, list):
        raise envelope.invalid_json()
    blocks = []
    for index, block in enumerate(raw_blocks):
        if not isinstance(block, dict):
            raise envelope.invalid_json()
        part_type = block.get('partType') if isinstance(block.get('partType'), str) else ''
        if not part_type.strip():
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'blocks.{index}.partType', 'is required')]
            )
        blocks.append(questions_svc.QuestionContentBlockInput(
            part_type=part_type,
            owner_kind=block.get('ownerKind') if isinstance(block.get('ownerKind'), str) else None,
            role=block.get('role') if isinstance(block.get('role'), str) else None,
            sequence=block.get('sequence') if isinstance(block.get('sequence'), int) else None,
            content_mode=block.get('contentMode') if isinstance(block.get('contentMode'), str) else None,
            text_format=block.get('textFormat') if isinstance(block.get('textFormat'), str) else None,
            text_value=block.get('textValue') if isinstance(block.get('textValue'), str) else None,
            latex_value=block.get('latexValue') if isinstance(block.get('latexValue'), str) else None,
            mathml_value=block.get('mathmlValue') if isinstance(block.get('mathmlValue'), str) else None,
            html_value=block.get('htmlValue') if isinstance(block.get('htmlValue'), str) else None,
            markdown_value=block.get('markdownValue') if isinstance(block.get('markdownValue'), str) else None,
            json_value=block.get('jsonValue'),
            media_id=block.get('mediaId') if isinstance(block.get('mediaId'), int) else None,
        ))
    await questions_svc.replace_question_content_blocks(
        deps.pool(request), user, deps.parse_path_id(question_id, 'questionId'), blocks
    )
    return envelope.no_content(request)


# ---------------------------------------------------------------- groups


@router.get('/api/v1/groups/{group_id}')
async def group_get(request: Request, group_id: str):
    user = await deps.current_user(request)
    data = await groups_svc.get_group(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId')
    )
    return envelope.ok(request, data)


@router.patch('/api/v1/groups/{group_id}')
async def group_update(request: Request, group_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'title', 'instructions', 'contentMode'})
    data = await groups_svc.update_group(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId'),
        title=body.get('title') if isinstance(body.get('title'), str) else None,
        instructions=body.get('instructions') if isinstance(body.get('instructions'), str) else None,
        instructions_set='instructions' in body,
        content_mode=body.get('contentMode') if isinstance(body.get('contentMode'), str) else None,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/groups/{group_id}')
async def group_delete(request: Request, group_id: str):
    user = await deps.current_user(request)
    await groups_svc.delete_group(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId')
    )
    return envelope.no_content(request)


@router.post('/api/v1/groups/{group_id}/publish')
async def group_publish(request: Request, group_id: str):
    user = await deps.current_user(request)
    data = await groups_svc.set_group_status(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId'), 'active'
    )
    return envelope.ok(request, data)


@router.post('/api/v1/groups/{group_id}/archive')
async def group_archive(request: Request, group_id: str):
    user = await deps.current_user(request)
    data = await groups_svc.set_group_status(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId'), 'archived'
    )
    return envelope.ok(request, data)


@router.post('/api/v1/groups/{group_id}/questions')
async def group_question_create(request: Request, group_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'questionId', 'sortOrder'})
    question_id = body.get('questionId') if isinstance(body.get('questionId'), int) else 0
    if question_id <= 0:
        raise envelope.validation_error([envelope.ValidationDetail('questionId', 'must be positive')])
    sort_order = body.get('sortOrder') if isinstance(body.get('sortOrder'), int) else None
    data = await groups_svc.add_question_to_group(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId'), question_id, sort_order
    )
    return envelope.created(request, data)


@router.patch('/api/v1/groups/{group_id}/questions/reorder')
async def group_questions_reorder(request: Request, group_id: str):
    user = await deps.current_user(request)
    body = await deps.decode_json_body(request, {'items'})
    raw_items = body.get('items')
    if not isinstance(raw_items, list) or not raw_items:
        raise envelope.validation_error([envelope.ValidationDetail('items', 'must not be empty')])
    items: list[groups_svc.ReorderGroupQuestionItem] = []
    questions_seen: set[int] = set()
    sorts: set[int] = set()
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            raise envelope.invalid_json()
        question_id = item.get('questionId') if isinstance(item.get('questionId'), int) else 0
        sort_order = item.get('sortOrder') if isinstance(item.get('sortOrder'), int) else 0
        if question_id <= 0 or sort_order <= 0 or sort_order > 2_147_483_647:
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'items.{index}', 'questionId and sortOrder must be positive')]
            )
        if question_id in questions_seen or sort_order in sorts:
            raise envelope.validation_error(
                [envelope.ValidationDetail(f'items.{index}', 'questionId and sortOrder values must be unique')]
            )
        questions_seen.add(question_id)
        sorts.add(sort_order)
        items.append(groups_svc.ReorderGroupQuestionItem(question_id=question_id, sort_order=sort_order))
    await groups_svc.reorder_group_questions(
        deps.pool(request), user, deps.parse_path_id(group_id, 'groupId'), items
    )
    return envelope.no_content(request)


@router.delete('/api/v1/groups/{group_id}/questions/{question_id}')
async def group_question_delete(request: Request, group_id: str, question_id: str):
    user = await deps.current_user(request)
    await groups_svc.remove_question_from_group(
        deps.pool(request), user,
        deps.parse_path_id(group_id, 'groupId'), deps.parse_path_id(question_id, 'questionId'),
    )
    return envelope.no_content(request)
