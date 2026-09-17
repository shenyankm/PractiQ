"""Repair punctuation only: never invent values or complete cut-off strings."""

import json


def repair_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    elif text.startswith("```\n") and text.endswith("```"):
        text = text[4:-3].strip()
    stack: list[str] = []
    output: list[str] = []
    quoted = escaped = False
    for char in text:
        if quoted:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
        elif char in "{[":
            stack.append("}" if char == "{" else "]")
        elif char in "}]":
            if not stack or stack.pop() != char:
                raise ValueError("JSON contains mismatched closing brackets")
            while output and output[-1].isspace():
                output.pop()
            if output and output[-1] == ",":
                output.pop()
        output.append(char)
    if quoted:
        raise ValueError("JSON contains an unfinished string")
    # A trailing comma at EOF is ambiguous: another field/item may have been lost.
    repaired = "".join(output) + "".join(reversed(stack))
    json.loads(repaired)  # Missing values, broken literals and other syntax still fail.
    return repaired
