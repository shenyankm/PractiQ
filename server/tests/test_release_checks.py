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


def test_license_gate_checks_metadata_target_graph_and_unresolved_terms(tmp_path, monkeypatch):
    import hashlib
    import json

    import pytest

    scope = runpy.run_path(str(Path(__file__).parents[2] / 'app/scripts/check_licenses.py'))
    inventory = scope['inventory']
    monkeypatch.setitem(inventory.__globals__, 'ROOT', tmp_path)
    licenses = tmp_path/'app/licenses'
    licenses.mkdir(parents=True)
    (licenses/'supplemental.json').write_text('{}', encoding='utf-8')
    (tmp_path/'app/package-lock.json').write_text('{"packages":{}}', encoding='utf-8')
    bundle = tmp_path/'bundle'
    metadata = bundle/'python/_internal/sample.dist-info'
    metadata.mkdir(parents=True)
    (bundle/'build-manifest.json').write_text('{"packages":[{"name":"sample","version":"1"}]}', encoding='utf-8')
    with pytest.raises(ValueError, match='metadata'):
        inventory(bundle)
    (metadata/'METADATA').write_text('Name: sample\nVersion: 1\nLicense: MIT\n', encoding='utf-8')
    (metadata/'LICENSE').write_text('Synthetic full license terms', encoding='utf-8')
    office = bundle/'office'
    office.mkdir()
    (office/'manifest.json').write_text('{"version":"1","source":"synthetic"}', encoding='utf-8')
    (office/'LICENSE').write_text('Synthetic Office terms', encoding='utf-8')
    (bundle/'PYTHON-LICENSE.txt').write_text('Synthetic Python terms', encoding='utf-8')
    crate = tmp_path/'crate'
    crate.mkdir()
    (crate/'LICENSE').write_text('Synthetic Cargo terms', encoding='utf-8')
    packages = [{'id':name,'name':name,'version':'1','manifest_path':str(crate/'Cargo.toml')} for name in ['local','other-target']]
    monkeypatch.setattr('subprocess.check_output', lambda cmd, **kw: 'host: synthetic-target\n' if cmd[0]=='rustc' else json.dumps({'packages':packages,'resolve':{'nodes':[{'id':'local'}]}}))
    report = inventory(bundle)
    assert report['passed']
    assert [p['name'] for p in report['packages'] if p['ecosystem']=='cargo'] == ['local']
    notice = licenses/'notice.txt'
    notice.write_text('Links only', encoding='utf-8')
    (licenses/'supplemental.json').write_text(json.dumps({'cargo:local@1':[{'file':'notice.txt','sha256':hashlib.sha256(notice.read_bytes()).hexdigest(),'source':'synthetic','note':'Full terms missing'}]}), encoding='utf-8')
    assert not inventory(bundle)['passed']
    assert inventory(bundle)['unverifiedSources'] == ['cargo:local@1']
    (bundle/'build-manifest.json').write_text('{"packages":[]}', encoding='utf-8')
    with pytest.raises(ValueError, match='empty'):
        inventory(bundle)
