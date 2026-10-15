"""Compare local CPU hot paths with a Git baseline; no database or model calls."""
import argparse
import ast
import asyncio
import hashlib
import json
import platform
import subprocess
from pathlib import Path
from statistics import median
from time import perf_counter
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from practiq_ai import task_api, webapp
from practiq_ai.contracts import (
    ArtifactReference,
    ParsedGroup,
    ParsedQuestion,
    VisualElement,
)
from practiq_ai.graphs import chunking

ROOT = Path(__file__).resolve().parents[2]


def baseline_function(ref, module, name):
    path = Path(module.__file__).relative_to(ROOT).as_posix()
    source = subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=ROOT, text=True)
    node = next(node for node in ast.parse(source).body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)
    node.decorator_list = []
    namespace = dict(vars(module))
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, 'exec'), namespace)  # noqa: S102 - explicitly selected local Git baseline
    return namespace[name]


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def duplicate_profile(ref, count, repeats, shape):
    questions = [ParsedQuestion(id=f'q{i}', stem='Printed question', answerMode='short_answer',
                               answerPayload={'text': str(i // 2)}, sourceText=f'{i + 1}. Printed question. Answer: {i // 2}')
                 for i in range(count)]
    groups = [ParsedGroup(title='Printed group', questionIndexes=[i]) for i in range(count)]
    visuals = [VisualElement(kind='chart', description='Printed chart', questionIndexes=[i]) for i in range(count)]
    expected = [[[f'q{i}'], [f'q{i + 1}']] for i in range(0, count - 1, 2)]
    if shape == 'unassociated':
        groups, visuals = [], []
    elif shape == 'cross-tree-sections':
        groups = [ParsedGroup(title='Shared section', questionIndexes=list(range(count))) for _ in range(count)]
        visuals = []
        expected = []
    report = {'questions': count, 'groups': len(groups), 'visuals': len(visuals), 'associationShape': shape}
    for label, function in [('before', baseline_function(ref, chunking, 'find_duplicate_question_trees')),
                            ('after', chunking.find_duplicate_question_trees)]:
        samples = []
        result = function(questions, groups, visuals)
        assert result == expected
        for _ in range(repeats):
            started = perf_counter()
            result = function(questions, groups, visuals)
            samples.append((perf_counter() - started) * 1000)
            assert result == expected
        report[label] = {'samplesMs': samples, 'medianMs': median(samples), 'outputSha256': digest(result)}
    report['speedup'] = report['before']['medianMs'] / report['after']['medianMs']
    return report


async def artifact_profile(ref, count, repeats):
    reference = ArtifactReference(objectKey=f"practiq-agent/artifacts/{'a' * 64}/visual/0-{'b' * 64}.png",
                                  sha256='b' * 64, sizeBytes=3, mediaType='image/png')
    review = {'questions': [{'id': f'q{i}', 'options': [{'label': 'A', 'content': 'Saved option'} for _ in range(20)]}
                            for i in range(count)], 'visuals': [reference.model_dump()]}
    report = {'questions': count, 'optionsPerQuestion': 20, 'referenceAtEnd': True}
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(task_api, 'client', lambda: None)
        patch.setattr(task_api, '_read_task_record', AsyncMock(return_value={'document': {'sha256': 'a' * 64, 'objectKey': 'source'}}))
        patch.setattr(task_api, 'review_task', AsyncMock(return_value=review))
        patch.setattr(task_api, 'get_task', AsyncMock(return_value={}))
        patch.setattr(webapp, 'get_object_store', lambda: SimpleNamespace(get_verified=AsyncMock(return_value=b'png')))
        original = ArtifactReference.model_dump
        calls = 0

        def dump(self, *args, **kwargs):
            nonlocal calls
            calls += 1
            return original(self, *args, **kwargs)

        for label, function in [('before', baseline_function(ref, webapp, 'read_artifact')), ('after', webapp.read_artifact)]:
            samples = []
            response = await function(reference, UUID(int=1))
            for _ in range(repeats):
                started = perf_counter()
                response = await function(reference, UUID(int=1))
                samples.append((perf_counter() - started) * 1000)
                assert response.body == b'png' and response.headers['Cache-Control'] == 'no-store'
            with pytest.MonkeyPatch.context() as observed:
                observed.setattr(ArtifactReference, 'model_dump', dump)
                calls = 0
                await function(reference, UUID(int=1))
            report[label] = {'samplesMs': samples, 'medianMs': median(samples), 'referenceSerializations': calls,
                             'outputSha256': hashlib.sha256(response.body).hexdigest()}
    report['speedup'] = report['before']['medianMs'] / report['after']['medianMs']
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(['git', 'rev-parse', args.baseline], cwd=ROOT, text=True).strip()
    report = {'baseline': baseline, 'python': platform.python_version(), 'platform': platform.platform(),
              'scope': 'Synthetic local CPU paths, fake task reads/storage; no DB, HTTP, model or production latency claim',
              'duplicateDetection': [duplicate_profile(baseline, count, 5, shape) for count in (100, 1000)
                                     for shape in ('unassociated', 'per-question', 'cross-tree-sections')],
              'artifactMembership': [asyncio.run(artifact_profile(baseline, count, 5)) for count in (100, 1000)]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
