# Pyright cannot model LangGraph's partial TypedDict state transitions.
# pyright: reportTypedDictNotRequiredAccess=false

import json
from dataclasses import dataclass
from typing import Any, TypedDict

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from pydantic import BaseModel

from ..ai_schemas import AnswerGenerationResult, LearningReportResult
from ..support import DocumentProcessingError
from .model import TRANSPORT_RETRY_POLICY, graph_config, structured_attempt

VALIDATION_RETRIES = 1

ANSWER_PROMPT = (
    "You are a subject-matter tutor. Solve the supplied assessment question "
    "and produce the canonical answer, a clear explanation, and the solution "
    "steps. For choice questions, answerPayload must contain the correct "
    'option label under the key "correctOption".'
)
REPORT_PROMPT = (
    "You are a learning analyst. Produce a learning report for the supplied "
    "request context. Be honest about the limited context: base the mastery "
    "scores and weak points only on the information provided."
)


@dataclass(frozen=True)
class GenerationContext:
    model: BaseChatModel
    prompt: str
    schema: type[BaseModel]
    call_kind: str


class GenerationState(TypedDict, total=False):
    payload: dict[str, Any]
    messages: list[BaseMessage]
    attempts: int
    result: BaseModel | None


async def _call(
    state: GenerationState, runtime: Runtime[GenerationContext]
) -> dict[str, Any]:
    messages = state.get("messages") or [
        SystemMessage(content=runtime.context.prompt),
        HumanMessage(content=json.dumps(state["payload"], ensure_ascii=False)),
    ]
    result, messages = await structured_attempt(
        runtime.context.model,
        messages,
        runtime.context.schema,
        runtime.context.call_kind,
    )
    return {
        "result": result,
        "messages": messages,
        "attempts": state.get("attempts", 0) + 1,
    }


def _route(state: GenerationState) -> str:
    if state.get("result") is not None:
        return "done"
    return "invalid" if state["attempts"] > VALIDATION_RETRIES else "call"


def _done(state: GenerationState) -> GenerationState:
    return state


_builder = StateGraph(GenerationState, context_schema=GenerationContext)
_builder.add_node("call", _call, retry_policy=TRANSPORT_RETRY_POLICY)
_builder.add_node("done", _done)
_builder.add_node("invalid", _done)
_builder.add_edge(START, "call")
_builder.add_conditional_edges("call", _route)
_builder.add_edge("done", END)
_builder.add_edge("invalid", END)
_graph = _builder.compile(name="structured_generator")


async def generate_answer(
    model: BaseChatModel, payload: dict[str, Any]
) -> AnswerGenerationResult:
    return await _generate(
        model, ANSWER_PROMPT, payload, AnswerGenerationResult, "answer_generation"
    )


async def learning_report(
    model: BaseChatModel, payload: dict[str, Any]
) -> LearningReportResult:
    return await _generate(
        model, REPORT_PROMPT, payload, LearningReportResult, "learning_report"
    )


async def _generate[ResultT: BaseModel](
    model: BaseChatModel,
    prompt: str,
    payload: dict[str, Any],
    schema: type[ResultT],
    call_kind: str,
) -> ResultT:
    try:
        output = await _graph.ainvoke(
            {"payload": payload},
            graph_config(),
            context=GenerationContext(model, prompt, schema, call_kind),
        )
    except DocumentProcessingError:
        raise
    except Exception as exc:
        raise DocumentProcessingError(502, "AI agent request failed") from exc
    result = output.get("result")
    if result is None:
        raise DocumentProcessingError(502, "AI agent returned invalid JSON")
    return result
