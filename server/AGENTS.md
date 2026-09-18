# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/practiq_ai/`. `webapp.py` exposes authenticated upload and artifact routes, `auth.py` handles Agent Server authentication, and `config.py` loads environment settings. Workflows live in `graphs/`, format readers in `extractors/`, and shared models in `contracts.py`. Do not add another parser or restore product APIs. Tests live in `tests/`; graph registration and TTL settings live in `langgraph.json`.

## Build, Test, and Development Commands

- `cp .env.example .env` creates a local configuration template; replace placeholders locally and never commit `.env`.
- Use an existing Python 3.14+ environment. Do not create a project `.venv`.
- `uv pip install --python "$(command -v python)" -e ".[dev]"` installs project dependencies into the active Python environment. CI continues to use `uv.lock`.
- `langgraph dev --no-browser --host 127.0.0.1 --port 8090` starts the local Agent Server with four format-specific graphs and the compatible `document_parser` graph.
- `python -m pytest` runs the complete test suite.
- `python -m pytest tests/test_documents.py` runs one focused test module while iterating.
- `uv build` creates source and wheel distributions under `dist/`.

## Coding Style & Naming Conventions

Use four-space indentation, type annotations, and small modules with explicit responsibilities. Follow Python conventions: `snake_case` for functions and variables, `PascalCase` for classes and Pydantic models, and `UPPER_CASE` for constants. Keep public payload fields compatible with the existing camelCase API contracts. Prefer async APIs for I/O and reuse shared errors and models instead of duplicating validation. Run the configured Ruff checks and use `pyrightconfig.json` for type-checking.

## Testing Guidelines

Tests use pytest with `pytest-asyncio` in automatic mode. Name tests `test_<behavior>` and keep fixtures or fakes close to the scenarios that use them. Cover success paths, validation failures, resumability, and storage/checksum boundaries when changing workflows. Tests must not call real LLM services; monkeypatch those integrations as existing tests do. The configured coverage threshold is 90%; every behavior change should have a focused regression test.

## Commit & Pull Request Guidelines

Use Conventional Commits: `<type>(<scope>): <summary>`. Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, and `chore`. Use an optional module name for `scope`, an imperative summary of at most 72 characters, and no trailing period. Example: `fix(extractors): enforce PDF page limit`. Keep each commit scoped to one concern.

Each pull request must include a summary, linked issue when available, test commands and results, and any configuration or API-contract changes. Add request and response examples for API changes. Add screenshots only for visible UI or documentation changes. Run `python -m pytest` before requesting review.
