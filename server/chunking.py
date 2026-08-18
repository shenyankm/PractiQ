import re

from .ai_schemas import ParsedGroup, ParsedQuestion

CHUNK_TARGET_CHARS = 30_000
# 题号/大题起始行模式：阿拉伯数字编号、中文大题编号
QUESTION_BOUNDARY_PATTERN = re.compile(
    r'^\s*(?:\d{1,4}\s*[.、)．]|[一二三四五六七八九十]{1,3}\s*[、.．])',
    re.MULTILINE,
)


def split_into_chunks(text: str, target_chars: int = CHUNK_TARGET_CHARS) -> list[str]:
    """按题目边界切分长文本；相邻块重叠一段（上一块最后一题）用于跨界去重。"""
    if len(text) <= target_chars:
        return [text]

    boundaries = [match.start() for match in QUESTION_BOUNDARY_PATTERN.finditer(text)]
    if not boundaries or boundaries[0] != 0:
        boundaries.insert(0, 0)
    boundaries.append(len(text))

    chunks: list[str] = []
    start = 0
    previous_boundary = 0
    index = 1
    while index < len(boundaries):
        if boundaries[index] - start >= target_chars:
            # 在不超过目标大小的最后一个题目边界处切开
            cut = previous_boundary if previous_boundary > start else boundaries[index]
            chunks.append(text[start:boundaries[index]])
            start = cut
        previous_boundary = boundaries[index]
        index += 1
    if start < len(text):
        chunks.append(text[start:])
    return [chunk for chunk in chunks if chunk.strip()]


def merge_chunk_results(
    chunk_results: list[tuple[list[ParsedQuestion], list[ParsedGroup]]],
) -> tuple[list[ParsedQuestion], list[ParsedGroup], list[str]]:
    """合并各块结果：重排 group 索引偏移，按归一化题干去重（处理重叠区）。"""
    warnings: list[str] = []
    questions: list[ParsedQuestion] = []
    groups: list[ParsedGroup] = []
    seen_stems: dict[str, int] = {}

    for chunk_questions, chunk_groups in chunk_results:
        index_map: dict[int, int] = {}
        for local_index, question in enumerate(chunk_questions):
            key = _normalize_stem(question.stem)
            existing = seen_stems.get(key)
            if existing is not None:
                index_map[local_index] = existing
                continue
            seen_stems[key] = len(questions)
            index_map[local_index] = len(questions)
            questions.append(question)
        for group in chunk_groups:
            remapped = sorted(
                {
                    index_map[index]
                    for index in group.questionIndexes
                    if index in index_map
                }
            )
            if remapped:
                groups.append(group.model_copy(update={'questionIndexes': remapped}))

    if len(questions) > 1_000:
        warnings.append(
            f'Parsed {len(questions)} questions; only the first 1000 were kept.'
        )
        kept = set(range(1_000))
        questions = questions[:1_000]
        groups = [
            group.model_copy(
                update={
                    'questionIndexes': [i for i in group.questionIndexes if i in kept]
                }
            )
            for group in groups
        ]
        groups = [group for group in groups if group.questionIndexes]
    return questions, groups, warnings


def _normalize_stem(stem: str) -> str:
    # 去掉行首题号与空白后取前 200 字符作为去重键
    stripped = QUESTION_BOUNDARY_PATTERN.sub('', stem.strip(), count=1)
    return re.sub(r'\s+', '', stripped)[:200].casefold()
