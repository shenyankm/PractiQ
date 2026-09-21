---
name: cost-aware-llm-pipeline
description: Cost optimization patterns for LLM API usage — model routing by task complexity, budget tracking, retry logic, and prompt caching. Use when LLM spend needs to come down, or when routing tasks across model tiers and budgets.
metadata:
  origin: ECC
---

# Model cost controls in PractiQ

Reuse `server/src/practiq_ai/llm.py` and `execution.py`; do not introduce a second provider client, model router, or accounting pipeline. The desktop explicitly selects one model for text and images.

- Reserve each model attempt through `reserve_model_call` before the provider request. Retries consume the same bounded call allowance.
- Persist or expose per-call usage before interpreting model output. A successful provider response followed by output-validation failure remains billable; never lose its record through a returned immutable tracker that an exception bypasses.
- Call-count limits are not monetary ceilings. If a hard monetary budget is explicitly required, atomically reserve a conservative input-plus-max-output cost before each attempt, reject insufficient balances (including equality at the limit), and settle against actual usage. Unknown usage retains the reservation. Do not advertise post-call spending checks as hard budgets.
- Keep trusted instructions in `SystemMessage` and source/user input in `HumanMessage`. If a provider supports prompt caching, apply its cache metadata to the system content through the existing adapter; never move system instructions into a user message.
- Preserve bounded retries, failure usage, cancellation, and explicit user authorization for model calls. Verify with the existing fake-model tests, then `make verify AI_PYTHON=/path/to/python3.14`.

Do not copy static model prices or speculative model names into code. Verify provider pricing before estimating monetary spend.
