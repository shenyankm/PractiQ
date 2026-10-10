"""The checked-in desktop fixture is produced through the shared merge pipeline."""
from pathlib import Path

import pytest

from practiq_ai.contracts import (
    ContentBlock,
    DocumentParseResult,
    DocumentQuality,
    ParsedOption,
    ParsedQuestion,
    QuestionSource,
    scorable_count,
)
from practiq_ai.graphs.chunking import finalize_question_ids
from tests.support import run_config, setup_graph

FIXTURE = Path(__file__).resolve().parents[2] / "app/fixtures/composite.json"


async def test_composite_pipeline_matches_desktop_fixture(monkeypatch):
    expected = DocumentParseResult.model_validate_json(FIXTURE.read_text()).model_dump()
    # The model fixture contains only source-provided answers, including the rubric.
    source = "\n".join(q["sourceText"] for q in expected["questions"])
    graph, _, _, reference, _ = setup_graph(monkeypatch, [{
        "questions": expected["questions"],
        "groups": [{"title": "Composite section", "questionIndexes": list(range(len(expected["questions"])))}],
    }], parts=[source])
    state = await graph.ainvoke({"document": reference}, run_config())
    actual = DocumentParseResult.model_validate(state["result"])
    ids = {q["id"]: f"q{i}" for i, q in enumerate(expected["questions"])}
    for q in expected["questions"]:
        for key in ("id", "parentId", "optionSourceId"):
            if q[key]:
                q[key] = ids[q[key]]
        for block in q["passage"]:
            if block["questionId"]:
                block["questionId"] = ids[block["questionId"]]
    assert actual.model_dump()["questions"] == expected["questions"]
    assert scorable_count(actual.questions) == 10
    assert actual.groups[0].questionIds == list(ids.values())


def test_explicit_continuation_merges_material_and_references_once():
    def parent(text):
        return ParsedQuestion(id="page:0:article", stem="Article", answerMode="reading", passage=[ContentBlock(partType="text",textValue=text)])
    qs = [parent("First page"), parent("Second page"), ParsedQuestion(id="page:1:1", parentId="page:0:article", stem="Child", answerMode="short_answer")]
    sources = [QuestionSource(questionIndex=i, stage="vision_parse", unitIndex=min(i, 1)) for i in range(3)]
    merged = finalize_question_ids(qs, [], [], sources, DocumentQuality())
    assert len(merged) == 2
    assert [b.textValue for b in merged[0].passage] == ["First page", "Second page"]
    assert merged[1].parentId == "q0"
    assert [s.questionIndex for s in sources] == [0, 0, 1]
    with pytest.raises(ValueError, match="Duplicate"):
        finalize_question_ids([ParsedQuestion(id="same", stem="One"), ParsedQuestion(id="same", stem="Two")], [], [], [], DocumentQuality())


def test_composite_limit_does_not_split_group():
    from practiq_ai.graphs.chunking import merge_chunk_results

    ordinary = [ParsedQuestion(stem=f"Question {i}") for i in range(998)]
    parent = ParsedQuestion(id="article", stem="Article", answerMode="reading")
    children = [ParsedQuestion(id=f"child{i}", parentId="article", stem=f"Child {i}") for i in range(3)]
    merged, _, warnings, truncated, sources, _ = merge_chunk_results([(0, [*ordinary, parent, *children], [])])
    assert truncated and len(merged) == len(sources) == 998
    assert "without splitting" in warnings[-1]


def test_nonadjacent_same_anchor_does_not_silently_join_articles():
    qs = [ParsedQuestion(id="page:0:a", stem="Article", answerMode="reading") for _ in range(2)]
    sources = [QuestionSource(questionIndex=i, stage="vision_parse", unitIndex=i * 2) for i in range(2)]
    with pytest.raises(ValueError, match="adjacent source evidence"):
        finalize_question_ids(qs, [], [], sources, DocumentQuality())


def test_noncomposite_parent_is_rejected_before_final_export():
    from practiq_ai.graphs.chunking import SourceQuestionConflict
    from practiq_ai.graphs.document import ChunkParseResult

    rows = [{"id": "ordinary", "stem": "A standalone question", "answerMode": "short_answer"},
            {"id": "child", "parentId": "ordinary", "stem": "Another question", "answerMode": "short_answer"}]
    with pytest.raises(ValueError, match="composite"):
        ChunkParseResult.model_validate({"questions": rows})
    with pytest.raises(SourceQuestionConflict, match="composite"):
        finalize_question_ids([ParsedQuestion.model_validate(row) for row in rows], [], [], [], DocumentQuality())


@pytest.mark.parametrize("pages", [2, 3])
def test_continuation_retains_tables_options_children_and_quality(pages):
    table = ContentBlock(partType="table", markdownValue="| First |\n| --- |\n| row |")
    parents = [ParsedQuestion(
        id="page:0:bank", stem="Word bank", answerMode="word_bank", questionTypeId="word_bank",
        analysis="Supplied explanation", sourceText=f"Source page {i}",
        contentBlocks=[table, ContentBlock(partType="table", markdownValue=f"| Page {i} |\n| --- |\n| row |")],
        options=[ParsedOption(label="a", content="First"), ParsedOption(label=chr(66 + i), content=f"Choice {i}")],
    ) for i in range(pages)]
    parents[-1].needsReview = True
    parents[-1].missingFields = ["material"]
    parents[0].passage = [ContentBlock(partType="text", textValue="Choose a word:"), ContentBlock(partType="blank", questionId="child")]
    child = ParsedQuestion(id="child", parentId="page:0:bank", optionSourceId="page:0:bank",
                           stem="Choose", answerMode="choice", choiceVariant="single", questionTypeId="SINGLE_CHOICE",
                           answerPayload={"correct": [chr(65 + pages)]}, analysis="Supplied explanation", sourceText="Choose")
    expected_blocks = [table, *[parent.contentBlocks[-1] for parent in parents]]
    sources = [QuestionSource(questionIndex=i, stage="vision_parse", unitIndex=min(i, pages - 1)) for i in range(pages + 1)]
    quality = DocumentQuality()
    merged = finalize_question_ids([*parents, child], [], [], sources, quality)
    assert merged[0].contentBlocks == expected_blocks
    assert [option.label for option in merged[0].options] == ["a", *[chr(66 + i) for i in range(pages)]]
    assert merged[0].needsReview and merged[0].missingFields == ["material"]
    assert merged[1].parentId == merged[1].optionSourceId == "q0"
    assert merged[1].answerPayload.correct == [chr(65 + pages)]
    assert [source.questionIndex for source in sources] == [*[0] * pages, 1]
    assert quality.issues[0].questionIndex == 0


@pytest.mark.parametrize("content", ["First", "Conflicting"])
def test_continuation_normalizes_shared_option_labels(content):
    from practiq_ai.graphs.chunking import SourceQuestionConflict

    parents = [ParsedQuestion(id="page:0:bank", stem="Word bank", answerMode="word_bank",
                              options=[ParsedOption(label=label, content=value)])
               for label, value in [("A", "First"), (" a ", content)]]
    sources = [QuestionSource(questionIndex=i, stage="vision_parse", unitIndex=i) for i in range(2)]
    if content == "Conflicting":
        with pytest.raises(SourceQuestionConflict, match="shared option") as caught:
            finalize_question_ids(parents, [], [], sources, DocumentQuality())
        assert caught.value.question_index == 1
    else:
        merged = finalize_question_ids(parents, [], [], sources, DocumentQuality())
        assert merged[0].options == [ParsedOption(label="A", content="First")]
