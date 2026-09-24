"""Validate the shared desktop corpus against the actual AI contract."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'server/src'))
from practiq_ai.contracts import DocumentParseResult  # noqa: E402

cases = json.loads((root / 'app/fixtures/contracts.json').read_text(encoding='utf-8'))
for case in cases:
    try:
        result = DocumentParseResult.model_validate(case['input'])
    except ValueError:
        assert not case['valid'], case['name']
    else:
        assert case['valid'], case['name']
        assert result.questions[0].missingFields == case['missingFields'], case['name']
        for key, expected in case.get('expectedQuestion', {}).items():
            assert result.questions[0].model_dump()[key] == expected, (case['name'], key)
DocumentParseResult.model_validate_json((root / 'app/fixtures/sample.json').read_text(encoding='utf-8'))
print(f'{len(cases)} shared contract cases and the sample validated by Python')

DocumentParseResult.model_validate_json((root / "app/fixtures/rich-content/expected.json").read_text(encoding="utf-8"))

DocumentParseResult.model_validate_json((root / "app/fixtures/composite.json").read_text(encoding="utf-8"))

DocumentParseResult.model_validate_json((root / "app/fixtures/english.json").read_text(encoding="utf-8"))
