"""Opt-in exact deduplication preserves distinct content and complete trees."""
from copy import deepcopy

import pytest

from practiq_ai.contracts import (
    ArtifactReference,
    ContentBlock,
    DocumentQuality,
    ParsedGroup,
    ParsedOption,
    ParsedQuestion,
    QualityIssue,
    QuestionSource,
    VisualElement,
    validate_question_tree,
)
from practiq_ai.graphs.chunking import (
    find_duplicate_question_trees,
    remove_duplicate_question_trees,
)
from tests.support import run_config, setup_graph


def single(qid, *, answer="Printed", number=1, **changes):
    return ParsedQuestion(id=qid, stem="What label was printed?", answerMode="short_answer",
                          answerPayload={"text": answer}, sourceText=f"{number}. What label was printed? Answer: {answer}", **changes)


def bank(start):
    ids = [f"q{start+i}" for i in range(3)]
    return [ParsedQuestion(id=ids[0], stem="Choose words", answerMode="word_bank",
                           sourceText="Choose words: A. white B. green; Snow is [1]. Grass is [2].",
                           options=[ParsedOption(label="A", content="white"), ParsedOption(label="B", content="green")],
                           passage=[ContentBlock(partType="text", textValue="Snow is "), ContentBlock(partType="blank", questionId=ids[1]),
                                    ContentBlock(partType="text", textValue=". Grass is "), ContentBlock(partType="blank", questionId=ids[2])]),
            *[ParsedQuestion(id=ids[i], parentId=ids[0], optionSourceId=ids[0], stem=stem, answerMode="choice",
                             choiceVariant="single", answerPayload={"correct": [label]}, sourceText=f"{stem} [{i}]. Answer: {label}")
              for i, (stem, label) in enumerate([("Snow is", "A"), ("Grass is", "B")], 1)]]


def test_nonadjacent_duplicate_candidates_preserve_every_record_and_reference():
    questions = [single("q0", confidence=.9), single("q1", answer="Different"), single("q2", number=20, confidence=.6)]
    groups = [ParsedGroup(title="Questions", questionIndexes=[0]), ParsedGroup(title="Questions", questionIndexes=[2])]
    before = [q.model_dump() for q in questions]
    candidates = find_duplicate_question_trees(questions, groups, [])
    assert candidates == [[["q0"], ["q2"]]]
    assert [q.model_dump() for q in questions] == before
    assert [(g.title, g.questionIndexes) for g in groups] == [("Questions", [0]), ("Questions", [2])]


def test_composite_candidates_are_whole_trees_without_orphaning_any_children():
    questions = [*bank(0), single("q3"), *bank(4)]
    before = [q.model_dump() for q in questions]
    candidates = find_duplicate_question_trees(questions, [], [])
    assert candidates == [[["q0", "q1", "q2"], ["q4", "q5", "q6"]]]
    assert [q.model_dump() for q in questions] == before
    validate_question_tree(questions)


def test_explicit_opt_in_removes_whole_copies_and_retains_all_source_units():
    questions = [*bank(0), single("q3"), *bank(4)]
    candidates = find_duplicate_question_trees(questions, [], [])
    sources = [QuestionSource(questionIndex=i, stage="vision_parse", unitIndex=0 if i < 4 else 10) for i in range(7)]
    section = ParsedGroup(title="Instructions", instructions="Use the supplied words.", questionIndexes=[])
    groups = [section, ParsedGroup(title="First", questionIndexes=[0, 1, 2, 3]), ParsedGroup(title="Copy", questionIndexes=[4, 5, 6])]
    quality = DocumentQuality(issues=[QualityIssue(questionIndex=5, code="NEEDS_REVIEW")])
    retained, warnings = remove_duplicate_question_trees(questions, groups, [], sources, quality, candidates)
    assert [q.id for q in retained] == ["q0", "q1", "q2", "q3"]
    assert len(questions) == 7 and warnings[0].startswith("Removed 3 ")
    assert [(g.title, g.questionIndexes) for g in groups] == [("Instructions", []), ("First", [0, 1, 2, 3])]
    assert groups[0] == section
    assert {s.questionIndex for s in sources if s.unitIndex == 10} == {0, 1, 2}
    assert quality.issues[0].questionIndex == 1
    validate_question_tree(retained)


@pytest.mark.parametrize("enabled", [False, True])
async def test_import_retains_duplicates_unless_user_explicitly_opts_in(monkeypatch, enabled):
    questions = [single(f"fragment:1:{number}", number=number) for number in (1, 20)]
    for question in questions:
        question.sourceText = (question.sourceText or "").replace(". What", ". Short answer: What")
    source = "\n".join(q.sourceText or "" for q in questions)
    section = {"title": "Instructions", "instructions": "Keep the printed answer.", "questionIndexes": []}
    graph, _, _, reference, model = setup_graph(monkeypatch, [{"questions": [q.model_dump(mode="json") for q in questions],
                                                            "groups": [section]}], parts=[source])
    output = await graph.ainvoke({"document": reference, "deduplicateQuestions": enabled}, run_config())
    assert output["status"] == "SUCCEEDED" and len(model.calls) == 1
    assert len(output["result"]["questions"]) == (1 if enabled else 2)
    assert output["result"]["groups"] == [{"title": section["title"], "instructions": section["instructions"], "questionIds": []}]
    assert any(("after explicit opt-in" if enabled else "All copies were retained") in warning for warning in output["result"]["warnings"])
    issues = [(item['questionId'], item['code']) for item in output['processing']['quality']['issues'] if item['code'] == 'NEEDS_REVIEW']
    assert issues == ([] if enabled else [('q0', 'NEEDS_REVIEW'), ('q1', 'NEEDS_REVIEW')])


@pytest.mark.parametrize("field,value", [
    ("sourceScore", 3.0), ("scoringRubric", "Keep both"), ("scoreSourceText", "Each is worth 3 points"),
    ("instructions", "Use a different rule"), ("analysis", "A different explanation"),
    ("sourceText", "What label was printed? Answer: Printed. The source also says keep this separately."),
    ("contentBlocks", [{"partType": "text", "textValue": "Additional source material"}]),
])
def test_same_stem_with_different_business_content_or_evidence_is_preserved(field, value):
    first = single("q0")
    changed = ParsedQuestion.model_validate({**first.model_dump(), "id": "q1", field: value})
    assert find_duplicate_question_trees([first, changed], [], []) == []


def test_same_stem_and_answer_with_different_options_is_preserved():
    first = ParsedQuestion(id="q0", stem="Choose", answerMode="choice", choiceVariant="single",
                           options=[ParsedOption(label="A", content="First"), ParsedOption(label="B", content="Second")],
                           answerPayload={"correct": ["A"]}, sourceText="Choose A or B. Answer: A")
    second = first.model_copy(deep=True)
    second.id = "q1"
    second.options[1].content = "Third"
    assert find_duplicate_question_trees([first, second], [], []) == []


def test_different_group_instructions_and_media_are_not_merged():
    questions = [single("q0"), single("q1")]
    groups = [ParsedGroup(title="A", instructions="Rule A", questionIndexes=[0]), ParsedGroup(title="B", instructions="Rule B", questionIndexes=[1])]
    assert find_duplicate_question_trees(deepcopy(questions), groups, []) == []
    figures = [VisualElement(kind="image", description="Source photograph", bbox=[0, 0, 1, 1], page=i,
                            sourceRef=ArtifactReference(objectKey=f"page-{i}", sha256=str(i+1)*64, mediaType="image/png", sizeBytes=1), questionIndexes=[i]) for i in range(2)]
    assert find_duplicate_question_trees(questions, [], figures) == []


def test_group_title_is_business_evidence_without_instructions():
    questions = [single('q0'), single('q1')]
    groups = [ParsedGroup(title='Use London time', questionIndexes=[0]),
              ParsedGroup(title='Use Beijing time', questionIndexes=[1])]
    before = deepcopy(questions)
    assert find_duplicate_question_trees(questions, groups, []) == []
    assert questions == before


@pytest.mark.parametrize('difference', ['label', 'uncropped_region', 'source_behind_same_crop'])
def test_visual_business_evidence_differences_preserve_both_trees(difference):
    questions = [single('q0'), single('q1')]
    page = ArtifactReference(objectKey='page', sha256='a' * 64, mediaType='image/png', sizeBytes=1)
    figures = [VisualElement(kind='chart', label='Amount', description='Printed chart',
                             sourceRef=page, bbox=[0, 0, .5, .5], questionIndexes=[index]) for index in range(2)]
    if difference == 'label':
        figures[1].label = 'Amount in thousands'
    elif difference == 'uncropped_region':
        figures[1].bbox = [.5, .5, 1, 1]
    else:
        crop = ArtifactReference(objectKey='crop', sha256='b' * 64, mediaType='image/png', sizeBytes=1)
        figures[0].imageRef = figures[1].imageRef = crop
        figures[1].sourceRef = page.model_copy(update={'sha256': 'c' * 64})
    before = [figure.model_dump() for figure in figures]
    assert find_duplicate_question_trees(questions, [], figures) == []
    assert [figure.model_dump() for figure in figures] == before


@pytest.mark.parametrize('with_crop', [False, True])
def test_equal_group_and_visual_content_remains_a_passive_candidate(with_crop):
    questions = [single('q0'), single('q1', number=20)]
    groups = [ParsedGroup(title='Use supplied units', instructions='Read the chart', questionIndexes=[index]) for index in range(2)]
    page = ArtifactReference(objectKey='first-page', sha256='a' * 64, mediaType='image/png', sizeBytes=1)
    crop = ArtifactReference(objectKey='first-crop', sha256='b' * 64, mediaType='image/png', sizeBytes=1)
    figures = [VisualElement(kind='chart', label='Amount', description='Printed chart',
                             sourceRef=page.model_copy(update={'objectKey': f'page-{index}'}), bbox=[0, 0, .5, .5],
                             imageRef=crop.model_copy(update={'objectKey': f'crop-{index}'}) if with_crop else None,
                             questionIndexes=[index]) for index in range(2)]
    before = [q.model_dump() for q in questions]
    assert find_duplicate_question_trees(questions, groups, figures) == [[['q0'], ['q1']]]
    assert [q.model_dump() for q in questions] == before and len(questions) == 2


def test_duplicate_detection_indexes_associations_once_without_changing_candidates():
    class ObservedList(list):
        visits = 0

        def __iter__(self):
            for item in super().__iter__():
                self.visits += 1
                yield item

    questions = [single(f'q{i}', answer=str(i // 2), number=i + 1) for i in range(60)]
    groups = ObservedList(ParsedGroup(title='Printed group', questionIndexes=[i]) for i in range(60))
    visuals = ObservedList(VisualElement(kind='chart', description='Printed chart', questionIndexes=[i]) for i in range(60))
    expected = [[[f'q{i}'], [f'q{i + 1}']] for i in range(0, 60, 2)]
    assert find_duplicate_question_trees(questions, groups, visuals) == expected
    assert groups.visits <= len(groups)
    assert visuals.visits <= len(visuals)


@pytest.mark.parametrize('indexes', [[0, 1], [0, 999], [0, 0, 1]])
def test_cross_tree_or_invalid_group_members_preserve_unrelated_candidates(indexes):
    questions = [single(f'q{i}') for i in range(4)]
    groups = [ParsedGroup(title='Shared section', questionIndexes=indexes)]
    expected = [[['q1'], ['q2'], ['q3']]] if 999 in indexes else [[['q2'], ['q3']]]
    assert find_duplicate_question_trees(questions, groups, []) == expected
