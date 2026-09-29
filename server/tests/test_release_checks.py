import runpy
from pathlib import Path


def test_license_inventory_requires_real_texts_and_finds_nested_notices(tmp_path):
    script = Path(__file__).parents[2]/'app/scripts/check_licenses.py'
    find = runpy.run_path(str(script))['license_files']
    (tmp_path/'package.json').write_text('{"license":"MIT"}')
    assert find(tmp_path) == []
    nested = tmp_path/'licenses'/'pdfium.txt'
    nested.parent.mkdir()
    nested.write_text('Upstream notice')
    assert find(tmp_path) == [nested]
