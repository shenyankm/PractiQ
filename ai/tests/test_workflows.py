from openwook_ai.schemas import (
    AnswerGenerationResult,
    DocumentParseRequest,
    DocumentParseResult,
    LearningReportResult,
)
from openwook_ai import main
from openwook_ai.fallbacks import fallback_generate_answer, fallback_learning_report, fallback_parse_document


def test_ai_workflow_runs_all_operations_through_langgraph() -> None:
    from openwook_ai.workflows import ai_graph, invoke_workflow

    assert type(ai_graph).__module__.startswith('langgraph.')
    assert {'parse_document', 'generate_answer', 'learning_report'} <= set(ai_graph.nodes)

    parsed = invoke_workflow(
        'parse_document',
        DocumentParseRequest(sourceType='text', text='1. What is 2+2?'),
    )
    answer = invoke_workflow(
        'generate_answer',
        {'options': [{'label': 'A', 'content': '4'}]},
    )
    report = invoke_workflow('learning_report', {'userId': 7})

    assert isinstance(parsed, DocumentParseResult)
    assert isinstance(answer, AnswerGenerationResult)
    assert isinstance(report, LearningReportResult)


def test_ai_routes_delegate_to_the_workflow(monkeypatch) -> None:
    operations = []

    def invoke(operation, payload):
        operations.append(operation)
        return {
            'parse_document': fallback_parse_document,
            'generate_answer': fallback_generate_answer,
            'learning_report': fallback_learning_report,
        }[operation](payload)

    monkeypatch.setattr(main, 'invoke_workflow', invoke)
    main.parse_document(DocumentParseRequest(sourceType='text', text='Question'))
    main.generate_answer({})
    main.learning_report({})

    assert operations == ['parse_document', 'generate_answer', 'learning_report']
