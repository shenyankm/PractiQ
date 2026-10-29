"""Bounded page links from printed references, never model-invented associations."""

import re
from collections import Counter
from typing import Any

from practiq_ai.tencent_bundle import evidence_text

MAX_CONTEXT_PAGES = 8
NUMBER = re.compile(r"(?mi)^\s*(?:q(?:uestion)?\s*)?(\d{1,4})\s*[.、)．:：](?!\d)")
ANSWER_HEADING = re.compile(r"(?mi)^\s*(?:参考答案|标准答案|答案(?:与解析)?|answer\s*key|answers|solutions)\s*[:：]?\s*$")
PAGE_REFERENCE = re.compile(r"(?i)(?:see|refer\s+to)\s+pages?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?|(?:参见|参考|见)第\s*(\d{1,3})(?:\s*[-–至到]\s*(\d{1,3}))?\s*页")


def source_context(pages: list[dict[str, Any]], *, page_references: bool = True) -> tuple[list[list[int]], list[int]]:
    texts = [evidence_text(page.get("elements", [])) if not page.get("failed") else "" for page in pages]
    numbers = [set(NUMBER.findall(text)) for text in texts]
    answers = {index for index, text in enumerate(texts) if ANSWER_HEADING.search(text)}
    owners = Counter(number for index, ids in enumerate(numbers) if index not in answers for number in ids)
    failed = {index for index, page in enumerate(pages) if page.get("failed")}
    plans, incomplete = [], []
    for index, text in enumerate(texts):
        adjacent = list(range(max(0, index - 2), min(len(pages), index + 2)))
        linked = set()
        invalid = False
        for match in PAGE_REFERENCE.finditer(text):
            if not page_references:
                invalid = True
                continue
            start, end = (match[1], match[2]) if match[1] else (match[3], match[4])
            first, last = int(start) - 1, int(end or start) - 1
            if not 0 <= first <= last < len(pages):
                invalid = True
                continue
            linked.update(range(first, last + 1))
        if index not in answers:
            unique = {number for number in numbers[index] if owners[number] == 1}
            linked.update(other for other in answers if unique & numbers[other])
        # Keep local context first; distant pages need a printed association and
        # a complete intervening source range. Ambiguity remains human-reviewable.
        selected = []
        for other in [*adjacent, *sorted(linked)]:
            if other in selected:
                continue
            if any(min(index, other) <= gap <= max(index, other) for gap in failed):
                invalid = invalid or other in linked
                continue
            if len(selected) >= MAX_CONTEXT_PAGES:
                invalid = True
                continue
            selected.append(other)
        plans.append(sorted(selected))
        if invalid:
            incomplete.append(index)
    return plans, incomplete
