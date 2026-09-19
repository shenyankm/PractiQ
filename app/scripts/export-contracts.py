"""Export AI wire schemas; --check verifies the checked-in contract has not drifted."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server/src'))
from practiq_ai.contracts import DocumentParseResult, DocumentProcessing  # noqa: E402

path = Path(__file__).resolve().parents[1] / 'src-tauri/contracts.json'
content = json.dumps({'result': DocumentParseResult.model_json_schema(), 'processing': DocumentProcessing.model_json_schema()}, ensure_ascii=False, indent=2) + '\n'
if '--check' in sys.argv:
    if path.read_text(encoding='utf-8') != content:
        raise SystemExit('AI contract changed: run app/scripts/export-contracts.py and review the desktop importer.')
else:
    path.write_text(content, encoding='utf-8')
