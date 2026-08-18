"""Content routes for banks, questions, and groups."""

from typing import Annotated, Any, Self

from fastapi import APIRouter, Query, Request
from pydantic import Field, StringConstraints, model_validator

from .. import envelope
from ..services import banks as banks_svc
from ..services import groups as groups_svc
from ..services import questions as questions_svc
from . import deps

router = APIRouter()

NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
PositiveInt = Annotated[int, Field(gt=0)]
SortOrder = Annotated[int, Field(gt=0, le=2_147_483_647)]


class CreateBankBody(deps.RequestBody):
    name: Name
    description: Description | None = None
    subject: NonBlank
    is_public: bool = False


class UpdateBankBody(deps.RequestBody):
    name: Name | None = None
    description: Description | None = None
    is_public: bool | None = None


class ReorderBankItemBody(deps.RequestBody):
    question_id: PositiveInt | None = None
    group_id: PositiveInt | None = None
    sort_order: SortOrder

    @model_validator(mode='after')
    def require_one_item_id(self) -> Self:
        if (self.question_id is None) == (self.group_id is None):
            raise ValueError('exactly one of questionId or groupId is required')
        return self


class ReorderBankItemsBody(deps.RequestBody):
    items: list[ReorderBankItemBody] = Field(min_length=1)

    @model_validator(mode='after')
    def require_unique_items(self) -> Self:
        ids = [
            ('q', item.question_id) if item.question_id is not None else ('g', item.group_id)
            for item in self.items
        ]
        sorts = [item.sort_order for item in self.items]
        if len(ids) != len(set(ids)) or len(sorts) != len(set(sorts)):
            raise ValueError('item IDs and sortOrder values must be unique')
        return self


class QuestionOptionBody(deps.RequestBody):
    label: str = ''
    content: str = ''
    is_correct: bool = False


class CreateQuestionBody(deps.RequestBody):
    question_type_id: str = ''
    answer_mode: str = ''
    stem: str = ''
    analysis: str | None = None
    choice_variant: str | None = None
    status: str = ''
    options: list[QuestionOptionBody] = Field(default_factory=list)
    answer_payload: dict[str, Any] = Field(default_factory=dict)


class CreateGroupBody(deps.RequestBody):
    title: NonBlank
    instructions: str | None = None
    group_type_id: str = ''
    content_mode: str | None = None
    status: str = ''


class UpdateQuestionBody(deps.RequestBody):
    stem: str | None = None
    analysis: str | None = None


class CreateOptionBody(deps.RequestBody):
    label: NonBlank
    content: NonBlank
    is_correct: bool = False
    sort_order: int | None = None


class UpdateOptionBody(deps.RequestBody):
    label: str | None = None
    content: str | None = None
    is_correct: bool | None = None
    sort_order: int | None = None


class AnswerKeyBody(deps.RequestBody):
    answer_mode: NonBlank
    answer_payload: dict[str, Any] = Field(default_factory=dict)
    explanation_payload: dict[str, Any] = Field(default_factory=dict)
    score_payload: dict[str, Any] = Field(default_factory=dict)


class ContentBlockBody(deps.RequestBody):
    part_type: NonBlank
    owner_kind: str | None = None
    role: str | None = None
    sequence: int | None = None
    content_mode: str | None = None
    text_format: str | None = None
    text_value: str | None = None
    latex_value: str | None = None
    mathml_value: str | None = None
    html_value: str | None = None
    markdown_value: str | None = None
    json_value: Any = None
    media_id: int | None = None


class ContentBlocksBody(deps.RequestBody):
    blocks: list[ContentBlockBody]


class UpdateGroupBody(deps.RequestBody):
    title: str | None = None
    instructions: str | None = None
    content_mode: str | None = None


class AddGroupQuestionBody(deps.RequestBody):
    question_id: PositiveInt
    sort_order: int | None = None


class ReorderGroupQuestionBody(deps.RequestBody):
    question_id: PositiveInt
    sort_order: SortOrder


class ReorderGroupQuestionsBody(deps.RequestBody):
    items: list[ReorderGroupQuestionBody] = Field(min_length=1)

    @model_validator(mode='after')
    def require_unique_items(self) -> Self:
        questions = [item.question_id for item in self.items]
        sorts = [item.sort_order for item in self.items]
        if len(questions) != len(set(questions)) or len(sorts) != len(set(sorts)):
            raise ValueError('questionId and sortOrder values must be unique')
        return self


@router.get('/api/v1/banks')
async def list_banks(
    request: Request,
    scope: str = '',
    subject: str = '',
    q: str = '',
    limit: deps.PageLimit100 = None,
    cursor: str = '',
    updated_since: deps.UpdatedSince = None,
):
    user = await deps.current_user(request)
    data = await banks_svc.list_banks(
        deps.pool(request),
        user,
        banks_svc.ListBanksParams(
            scope=scope,
            subject=subject,
            query=q,
            limit=limit or 0,
            cursor=cursor,
            updated_since=updated_since.isoformat() if updated_since else '',
        ),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/banks')
async def create_bank(request: Request, body: CreateBankBody):
    user = await deps.current_user(request)
    data = await banks_svc.create_bank(
        deps.pool(request), user, body.name, body.description, body.subject, body.is_public
    )
    return envelope.created(request, data)


@router.get('/api/v1/banks/{bank_id}')
async def get_bank(request: Request, bank_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(request, await banks_svc.get_bank(deps.pool(request), user, bank_id))


@router.patch('/api/v1/banks/{bank_id}')
async def update_bank(request: Request, bank_id: deps.PositiveId, body: UpdateBankBody):
    user = await deps.current_user(request)
    data = await banks_svc.update_bank(
        deps.pool(request),
        user,
        bank_id,
        body.name,
        body.description,
        'description' in body.model_fields_set,
        body.is_public,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/banks/{bank_id}')
async def delete_bank(request: Request, bank_id: deps.PositiveId):
    user = await deps.current_user(request)
    await banks_svc.delete_bank(deps.pool(request), user, bank_id)
    return envelope.no_content(request)


@router.get('/api/v1/banks/{bank_id}/items')
async def bank_items(
    request: Request,
    bank_id: deps.PositiveId,
    status: str = '',
    type: str = '',
    limit: deps.PageLimit100 = None,
    include_answers: Annotated[bool, Query(alias='includeAnswers')] = False,
    cursor: str = '',
):
    user = await deps.current_user(request)
    data = await banks_svc.list_bank_items(
        deps.pool(request),
        user,
        bank_id,
        banks_svc.ListBankItemsParams(
            status=status,
            type=type,
            limit=limit or 0,
            include_answers=include_answers,
            cursor=cursor,
        ),
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.patch('/api/v1/banks/{bank_id}/items/reorder')
async def bank_items_reorder(
    request: Request, bank_id: deps.PositiveId, body: ReorderBankItemsBody
):
    user = await deps.current_user(request)
    items = [
        banks_svc.ReorderBankItem(
            question_id=item.question_id,
            group_id=item.group_id,
            sort_order=item.sort_order,
        )
        for item in body.items
    ]
    await banks_svc.reorder_bank_items(deps.pool(request), user, bank_id, items)
    return envelope.no_content(request)


@router.post('/api/v1/banks/{bank_id}/favorite')
async def bank_favorite_create(request: Request, bank_id: deps.PositiveId):
    user = await deps.current_user(request)
    await banks_svc.set_favorite(deps.pool(request), user, bank_id, True)
    return envelope.no_content(request)


@router.delete('/api/v1/banks/{bank_id}/favorite')
async def bank_favorite_delete(request: Request, bank_id: deps.PositiveId):
    user = await deps.current_user(request)
    await banks_svc.set_favorite(deps.pool(request), user, bank_id, False)
    return envelope.no_content(request)


@router.post('/api/v1/banks/{bank_id}/clone')
async def bank_clone(request: Request, bank_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await banks_svc.clone_public_bank(deps.pool(request), user, bank_id)
    )


@router.post('/api/v1/banks/{bank_id}/questions')
async def bank_question_create(
    request: Request, bank_id: deps.PositiveId, body: CreateQuestionBody
):
    user = await deps.current_user(request)
    options = [
        questions_svc.QuestionOptionInput(
            label=option.label,
            content=option.content,
            is_correct=option.is_correct,
        )
        for option in body.options
    ]
    data = await questions_svc.create_question(
        deps.pool(request),
        user,
        bank_id,
        questions_svc.CreateQuestionInput(
            question_type_id=body.question_type_id,
            answer_mode=body.answer_mode,
            stem=body.stem,
            analysis=body.analysis,
            choice_variant=body.choice_variant,
            status=body.status,
            options=options,
            answer_payload=body.answer_payload,
        ),
    )
    return envelope.created(request, data)


@router.get('/api/v1/banks/{bank_id}/groups')
async def bank_groups(
    request: Request,
    bank_id: deps.PositiveId,
    limit: deps.PageLimit100 = None,
    cursor: str = '',
):
    user = await deps.current_user(request)
    data = await groups_svc.list_bank_groups(
        deps.pool(request), user, bank_id, limit or 0, cursor
    )
    return envelope.ok(request, data.items, data.page_info.as_meta())


@router.post('/api/v1/banks/{bank_id}/groups')
async def bank_group_create(request: Request, bank_id: deps.PositiveId, body: CreateGroupBody):
    user = await deps.current_user(request)
    data = await groups_svc.create_group(
        deps.pool(request),
        user,
        bank_id,
        groups_svc.CreateGroupInput(
            title=body.title,
            instructions=body.instructions,
            group_type_id=body.group_type_id.strip(),
            content_mode=body.content_mode,
            status=body.status,
        ),
    )
    return envelope.created(request, data)


@router.get('/api/v1/questions/{question_id}')
async def question_get(request: Request, question_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await questions_svc.get_question(deps.pool(request), user, question_id)
    )


@router.patch('/api/v1/questions/{question_id}')
async def question_update(
    request: Request, question_id: deps.PositiveId, body: UpdateQuestionBody
):
    user = await deps.current_user(request)
    data = await questions_svc.update_question(
        deps.pool(request),
        user,
        question_id,
        stem=body.stem,
        analysis=body.analysis,
        analysis_set='analysis' in body.model_fields_set,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/questions/{question_id}')
async def question_delete(request: Request, question_id: deps.PositiveId):
    user = await deps.current_user(request)
    await questions_svc.delete_question(deps.pool(request), user, question_id)
    return envelope.no_content(request)


@router.post('/api/v1/questions/{question_id}/publish')
async def question_publish(request: Request, question_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await questions_svc.set_question_status(
            deps.pool(request), user, question_id, 'active'
        ),
    )


@router.post('/api/v1/questions/{question_id}/archive')
async def question_archive(request: Request, question_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await questions_svc.set_question_status(
            deps.pool(request), user, question_id, 'archived'
        ),
    )


@router.post('/api/v1/questions/{question_id}/options')
async def question_option_create(
    request: Request, question_id: deps.PositiveId, body: CreateOptionBody
):
    user = await deps.current_user(request)
    data = await questions_svc.create_option(
        deps.pool(request),
        user,
        question_id,
        body.label,
        body.content,
        body.is_correct,
        body.sort_order,
    )
    return envelope.created(request, data)


@router.patch(
    '/api/v1/questions/{question_id}/options/{option_id}',
)
async def question_option_update(
    request: Request,
    question_id: deps.PositiveId,
    option_id: deps.PositiveId,
    body: UpdateOptionBody,
):
    user = await deps.current_user(request)
    data = await questions_svc.update_option(
        deps.pool(request),
        user,
        question_id,
        option_id,
        label=body.label,
        content=body.content,
        is_correct=body.is_correct,
        sort_order=body.sort_order,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/questions/{question_id}/options/{option_id}')
async def question_option_delete(
    request: Request, question_id: deps.PositiveId, option_id: deps.PositiveId
):
    user = await deps.current_user(request)
    await questions_svc.delete_option(
        deps.pool(request), user, question_id, option_id
    )
    return envelope.no_content(request)


@router.put('/api/v1/questions/{question_id}/answer-key')
async def question_answer_key_put(
    request: Request, question_id: deps.PositiveId, body: AnswerKeyBody
):
    user = await deps.current_user(request)
    data = await questions_svc.upsert_answer_key(
        deps.pool(request),
        user,
        question_id,
        body.answer_mode,
        body.answer_payload,
        body.explanation_payload,
        body.score_payload,
    )
    return envelope.ok(request, data)


@router.put('/api/v1/questions/{question_id}/content-blocks')
async def question_content_blocks_put(
    request: Request, question_id: deps.PositiveId, body: ContentBlocksBody
):
    user = await deps.current_user(request)
    blocks = [
        questions_svc.QuestionContentBlockInput(**block.model_dump())
        for block in body.blocks
    ]
    await questions_svc.replace_question_content_blocks(
        deps.pool(request), user, question_id, blocks
    )
    return envelope.no_content(request)


@router.get('/api/v1/groups/{group_id}')
async def group_get(request: Request, group_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request, await groups_svc.get_group(deps.pool(request), user, group_id)
    )


@router.patch('/api/v1/groups/{group_id}')
async def group_update(request: Request, group_id: deps.PositiveId, body: UpdateGroupBody):
    user = await deps.current_user(request)
    data = await groups_svc.update_group(
        deps.pool(request),
        user,
        group_id,
        title=body.title,
        instructions=body.instructions,
        instructions_set='instructions' in body.model_fields_set,
        content_mode=body.content_mode,
    )
    return envelope.ok(request, data)


@router.delete('/api/v1/groups/{group_id}')
async def group_delete(request: Request, group_id: deps.PositiveId):
    user = await deps.current_user(request)
    await groups_svc.delete_group(deps.pool(request), user, group_id)
    return envelope.no_content(request)


@router.post('/api/v1/groups/{group_id}/publish')
async def group_publish(request: Request, group_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await groups_svc.set_group_status(deps.pool(request), user, group_id, 'active'),
    )


@router.post('/api/v1/groups/{group_id}/archive')
async def group_archive(request: Request, group_id: deps.PositiveId):
    user = await deps.current_user(request)
    return envelope.ok(
        request,
        await groups_svc.set_group_status(deps.pool(request), user, group_id, 'archived'),
    )


@router.post('/api/v1/groups/{group_id}/questions')
async def group_question_create(
    request: Request, group_id: deps.PositiveId, body: AddGroupQuestionBody
):
    user = await deps.current_user(request)
    data = await groups_svc.add_question_to_group(
        deps.pool(request), user, group_id, body.question_id, body.sort_order
    )
    return envelope.created(request, data)


@router.patch(
    '/api/v1/groups/{group_id}/questions/reorder',
)
async def group_questions_reorder(
    request: Request, group_id: deps.PositiveId, body: ReorderGroupQuestionsBody
):
    user = await deps.current_user(request)
    items = [
        groups_svc.ReorderGroupQuestionItem(
            question_id=item.question_id, sort_order=item.sort_order
        )
        for item in body.items
    ]
    await groups_svc.reorder_group_questions(deps.pool(request), user, group_id, items)
    return envelope.no_content(request)


@router.delete('/api/v1/groups/{group_id}/questions/{question_id}')
async def group_question_delete(
    request: Request, group_id: deps.PositiveId, question_id: deps.PositiveId
):
    user = await deps.current_user(request)
    await groups_svc.remove_question_from_group(
        deps.pool(request), user, group_id, question_id
    )
    return envelope.no_content(request)
