"""Offline smoke check inside the hardened image; mount fixtures at /fixtures."""

import asyncio
import os
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference

from practiq_ai.extractors.isolated import extract
from practiq_ai.storage import get_object_store


async def main():
    assert os.getuid() == 10001
    assert not os.access('/app/server', os.W_OK)
    before = set(Path('/tmp').iterdir())
    document = await extract('docx', Path('/fixtures/docx/formula-image.docx').read_bytes())
    assert document.page_images and not document.truncated
    workbook = Workbook()
    sheet = workbook.worksheets[0]
    sheet.append(['Question', 'Value'])
    sheet.append(['First', 1])
    chart = BarChart()
    chart.add_data(data=Reference(worksheet=sheet, min_col=2, min_row=1, max_row=2), titles_from_data=True)
    sheet.add_chart(chart, anchor='D1')
    payload = BytesIO()
    workbook.save(payload)
    result = await extract('xlsx', payload.getvalue())
    assert result.worksheets and result.worksheets[0]['assets'] and not result.worksheets[0]['failureCode']
    assert not (set(Path('/tmp').iterdir()) - before)
    store = get_object_store()
    reference = await store.put_artifact(b'container-check', source_sha256='a' * 64, kind='text', index=0, media_type='text/plain')
    assert await store.get_verified(reference) == b'container-check'
    print('UID 10001: Writer, Calc, isolated extraction, temporary cleanup and mounted storage passed')


if __name__ == '__main__':
    asyncio.run(main())
