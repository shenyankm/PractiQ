"""Countable offline OpenAI-compatible provider for isolated recovery drills.

Run on loopback: python scripts/recovery_provider.py --log /persistent-test/calls.jsonl
It returns synthetic questions, not recognition results. Never use for real imports.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, Request

from practiq_ai.contracts import ParsedQuestion


def app_for(log: Path, invalid_responses: int = 0) -> FastAPI:
    if invalid_responses < 0:
        raise ValueError("invalid_responses must be nonnegative")
    app = FastAPI()
    lock = asyncio.Lock()
    call_count = len(log.read_text().splitlines()) if log.exists() else 0

    def record(value: dict[str, Any]) -> None:
        with log.open("a") as handle:
            handle.write(json.dumps(value) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    @app.post("/v1/chat/completions")
    async def completion(request: Request):
        nonlocal call_count
        body = await request.json()
        schema = body["tools"][0]["function"]["name"]
        result: dict[str, Any] = {"questions": [ParsedQuestion.model_validate({"stem": "Synthetic recovery question", "sourceText": "Synthetic recovery question"}).model_dump(mode="json")], "groups": []}
        if schema == "PageParseResult":
            result["figures"] = [{"description": "Synthetic figure", "bbox": [0.1, 0.1, 0.8, 0.8], "kind": "image"}]
        elif schema == "ImageDescription":
            result = {"description": "Synthetic figure", "extractedText": None}
        request_id = str(uuid4())
        async with lock:
            if call_count < invalid_responses:
                result = {"invalid": True}
            await asyncio.to_thread(record, {"id": request_id, "schema": schema, "inputTokens": 10, "outputTokens": 5})
            call_count += 1
        return {"id": request_id, "object": "chat.completion", "created": 1, "model": body["model"],
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
                    "tool_calls": [{"id": "call_" + request_id, "type": "function", "function": {"name": schema, "arguments": json.dumps(result)}}]}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}

    @app.get("/calls")
    async def calls():
        content = await asyncio.to_thread(log.read_text) if await asyncio.to_thread(log.exists) else ""
        return [json.loads(line) for line in content.splitlines()]

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--invalid-responses", type=int, default=0)
    args = parser.parse_args()
    uvicorn.run(app_for(args.log, args.invalid_responses), host="127.0.0.1", port=args.port)
