from typing import Any, Literal, NotRequired, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from .fallbacks import fallback_generate_answer, fallback_learning_report, fallback_parse_document
from .schemas import AnswerGenerationResult, DocumentParseRequest, DocumentParseResult, LearningReportResult


Operation = Literal['parse_document', 'generate_answer', 'learning_report']
Result = DocumentParseResult | AnswerGenerationResult | LearningReportResult


class WorkflowState(TypedDict):
    operation: Operation
    payload: DocumentParseRequest | dict[str, Any]
    result: NotRequired[Result]


def _parse_document(state: WorkflowState) -> dict[str, Result]:
    return {'result': fallback_parse_document(cast(DocumentParseRequest, state['payload']))}


def _generate_answer(state: WorkflowState) -> dict[str, Result]:
    return {'result': fallback_generate_answer(cast(dict[str, Any], state['payload']))}


def _learning_report(state: WorkflowState) -> dict[str, Result]:
    return {'result': fallback_learning_report(cast(dict[str, Any], state['payload']))}


builder = StateGraph(WorkflowState)
builder.add_node('parse_document', _parse_document)
builder.add_node('generate_answer', _generate_answer)
builder.add_node('learning_report', _learning_report)
builder.add_conditional_edges(START, lambda state: state['operation'])
for node in ('parse_document', 'generate_answer', 'learning_report'):
    builder.add_edge(node, END)
ai_graph = builder.compile()


def invoke_workflow(operation: Operation, payload: DocumentParseRequest | dict[str, Any]) -> Result:
    return ai_graph.invoke({'operation': operation, 'payload': payload})['result']
