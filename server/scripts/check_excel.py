"""Explicit live-model acceptance with synthetic worksheet images (incurs model usage)."""

import argparse
import asyncio
import hashlib
import json
import os
from io import BytesIO
from pathlib import Path
from uuid import uuid4

os.environ['LANGSMITH_TRACING'] = os.environ['LANGCHAIN_TRACING_V2'] = 'false'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path('reports/evaluations/excel-acceptance'))
root = parser.parse_args().output.resolve()
root.mkdir(parents=True, exist_ok=True)
os.environ['AI_STORAGE_BACKEND'] = 'local'
os.environ['AI_STORAGE_DIR'] = str(root / 'storage')
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from openpyxl import Workbook
from openpyxl.drawing.image import Image as ExcelImage
from PIL import Image, ImageDraw, ImageFont

from practiq_ai.config import load
from practiq_ai.contracts import DocumentUploadRequest
from practiq_ai.graphs.document import build_document_graph
from practiq_ai.storage import get_object_store

font = ImageFont.load_default(size=26)
book = Workbook()
sheet = book.worksheets[0]
sheet.title = 'Associated'
sheet['A1'] = 'Short answer: According to Figure A, what color is the rectangle?'
sheet['A2'] = 'Answer: red'
picture = Image.new('RGB', (750, 230), 'white')
draw = ImageDraw.Draw(picture)
draw.text((20, 15), 'Figure A', fill='black', font=font)
draw.rectangle((30, 70, 500, 190), fill='red')
image = BytesIO(); picture.save(image, format='PNG')
sheet.add_image(ExcelImage(BytesIO(image.getvalue())), 'A4')
sheet = book.create_sheet('ImageQuestion')
picture = Image.new('RGB', (850, 220), 'white')
ImageDraw.Draw(picture).multiline_text((20, 20), 'Short answer: What word is printed below?\nORCHID\nAnswer: ORCHID', fill='black', font=font, spacing=15)
image = BytesIO(); picture.save(image, format='PNG')
sheet.add_image(ExcelImage(BytesIO(image.getvalue())), 'B2')
source = root / 'synthetic.xlsx'; book.save(source)

async def main():
    payload = source.read_bytes()
    store = get_object_store()
    reference = await store.put_document(payload, DocumentUploadRequest(sourceType='xlsx', fileName=source.name, mediaType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
    graph = build_document_graph(InMemorySaver(), store=InMemoryStore())
    try:
        output = await graph.ainvoke({'document': reference.model_dump(mode='json')}, {'configurable': {'thread_id': str(uuid4())}, 'run_id': uuid4()})
        (root / 'result.json').write_text(json.dumps(output, ensure_ascii=False, indent=2))
        questions = output['result']['questions']
        sources = output['processing']['questionSources']
        visuals = output['result']['visualElements']
        associated = [s['questionIndex'] for s in sources if s['excelSource']['sheetName'] == 'Associated']
        image_questions = [s['questionIndex'] for s in sources if s['excelSource']['sheetName'] == 'ImageQuestion']
        checks = {
            'status_succeeded': output['status'] == 'SUCCEEDED',
            'two_questions': len(questions) == 2,
            'associated_image_linked': any(set(v['questionIndexes']) & set(associated) for v in visuals if v['excelSource']['sheetName'] == 'Associated'),
            'image_question_extracted': any('ORCHID' in json.dumps(questions[i]['answerPayload']) for i in image_questions),
            'original_answer_preserved': any('red' in json.dumps(questions[i]['answerPayload']).lower() for i in associated),
        }
        report = {'checks': checks, 'passed': all(checks.values()), 'modelCalls': len(output['usage']), 'structuredOutputMethod': load().structured_output_method, 'models': sorted({call['modelId'] for call in output['usage']}), 'artifacts': str(root)}
    except Exception as exc:  # noqa: BLE001 - write a credential-free failure summary
        report = {'passed': False, 'errorType': type(exc).__name__, 'code': getattr(exc, 'code', None)}
    (root / 'summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    if not report['passed']:
        raise SystemExit(1)
asyncio.run(main())
