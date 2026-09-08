import re

from ..contracts import ParsedGroup, ParsedQuestion

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
    if not boundaries:
        return [
            text[index : index + target_chars]
            for index in range(0, len(text), target_chars)
        ]
    if boundaries[0] != 0:
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
    chunk_results: list[tuple[int, list[ParsedQuestion], list[ParsedGroup]]],
) -> tuple[list[ParsedQuestion], list[ParsedGroup], list[str], bool]:
    """合并各块结果，仅删除相邻块边界处的重叠题。"""
    warnings: list[str] = []
    questions: list[ParsedQuestion] = []
    groups: list[ParsedGroup] = []
    previous_chunk_index: int | None = None
    previous_last_key: str | None = None
    previous_last_index: int | None = None

    for chunk_index, chunk_questions, chunk_groups in chunk_results:
        index_map: dict[int, int] = {}
        for local_index, question in enumerate(chunk_questions):
            key = _normalize_stem(question.stem)
            if (
                local_index == 0
                and previous_chunk_index is not None
                and chunk_index == previous_chunk_index + 1
                and previous_last_key == key
                and previous_last_index is not None
            ):
                index_map[local_index] = previous_last_index
                continue
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

        previous_chunk_index = chunk_index
        previous_last_key = (
            _normalize_stem(chunk_questions[-1].stem) if chunk_questions else None
        )
        previous_last_index = (
            index_map[len(chunk_questions) - 1] if chunk_questions else None
        )

    truncated = len(questions) > 1_000
    if truncated:
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
    if len(groups) > 1_000:
        warnings.append(
            f"Merged {len(groups)} groups; only the first 1000 were kept."
        )
        groups = groups[:1_000]
        truncated = True
    return questions, groups, warnings, truncated


def _normalize_stem(stem: str) -> str:
    # 去掉行首题号与空白后取前 200 字符作为去重键
    stripped = QUESTION_BOUNDARY_PATTERN.sub('', stem.strip(), count=1)
    return re.sub(r'\s+', '', stripped)[:200].casefold()
