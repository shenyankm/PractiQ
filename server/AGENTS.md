# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/practiq_ai/`. `product/` holds the preserved Java HTTP/generation contract and inline-to-OSS facade; do not add another parser. `webapp.py` exposes FastAPI routes, `auth.py` handles service authentication, and `config.py` loads environment settings. LangGraph workflows are under `src/practiq_ai/graphs/`; file-format readers belong in `src/practiq_ai/extractors/`. Shared request, result, and artifact models live in `contracts.py`. Add tests to `tests/`, normally mirroring the affected module with a `test_*.py` file. Graph registration and TTL settings live in `langgraph.json`.

## Build, Test, and Development Commands

- `cp .env.example .env` creates a local configuration template; replace placeholders locally and never commit `.env`.
- Local development uses `/home/sheny/miniconda3/envs/langgragh` (Python 3.14). Run `source /home/sheny/miniconda3/etc/profile.d/conda.sh` and `conda activate langgragh` before the commands below. Do not create a project `.venv`.
- `uv pip install --python "$CONDA_PREFIX/bin/python" -e ".[dev]"` installs project dependencies into the active Conda environment. CI continues to use `uv.lock`.
- `langgraph dev --no-browser --port 8090` starts the local Agent Server with four format-specific graphs and the compatible `document_parser` graph.
- `python -m pytest` runs the complete test suite.
- `python -m pytest tests/test_documents.py` runs one focused test module while iterating.
- `uv build` creates source and wheel distributions under `dist/`.

## Coding Style & Naming Conventions

Use four-space indentation, type annotations, and small modules with explicit responsibilities. Follow Python conventions: `snake_case` for functions and variables, `PascalCase` for classes and Pydantic models, and `UPPER_CASE` for constants. Keep public payload fields compatible with the existing camelCase API contracts. Prefer async APIs for I/O and reuse shared errors and models instead of duplicating validation. No formatter or linter is configured; match surrounding code and use Pyright settings from `pyrightconfig.json` when type-checking.

## Testing Guidelines

Tests use pytest with `pytest-asyncio` in automatic mode. Name tests `test_<behavior>` and keep fixtures or fakes close to the scenarios that use them. Cover success paths, validation failures, resumability, and storage/checksum boundaries when changing workflows. Tests must not call real LLM or OSS services; monkeypatch those integrations as existing tests do. No numeric coverage threshold is configured, but every behavior change should have a focused regression test.

## Commit & Pull Request Guidelines

Use Conventional Commits: `<type>(<scope>): <summary>`. Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, and `chore`. Use an optional module name for `scope`, an imperative summary of at most 72 characters, and no trailing period. Example: `fix(extractors): enforce PDF page limit`. Keep each commit scoped to one concern.

Each pull request must include a summary, linked issue when available, test commands and results, and any configuration or API-contract changes. Add request and response examples for API changes. Add screenshots only for visible UI or documentation changes. Run `python -m pytest` before requesting review.
