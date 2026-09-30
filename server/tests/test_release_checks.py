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
    def command(cmd, **kw):
        assert kw["encoding"] == "utf-8"
        return 'host: synthetic-target\n' if cmd[0]=='rustc' else json.dumps({'packages':packages,'resolve':{'nodes':[{'id':'local'}]}}, ensure_ascii=False)
    monkeypatch.setattr('subprocess.check_output', command)
    report = inventory(bundle)
    assert report['passed']
    assert [p['name'] for p in report['packages'] if p['ecosystem']=='cargo'] == ['local']
    notice = licenses/'notice.txt'
    notice.write_text('Links only', encoding='utf-8')
    (licenses/'supplemental.json').write_text(json.dumps({'cargo:local@1':[{'file':'notice.txt','sha256':hashlib.sha256(notice.read_bytes()).hexdigest(),'source':'synthetic','note':'Full terms missing'}]}), encoding='utf-8')
    assert not inventory(bundle)['passed']
    assert inventory(bundle)['unverifiedSources'] == ['cargo:local@1']
    evidence = licenses/'evidence.json'
    evidence.write_text('{"source":"verified upstream"}', encoding='utf-8')
    item = {'file':'notice.txt','sha256':hashlib.sha256(notice.read_bytes()).hexdigest(),
            'source':'synthetic','verification':'Verified artifact attribution',
            'evidence':{'file':'evidence.json','sha256':hashlib.sha256(evidence.read_bytes()).hexdigest()}}
    (licenses/'supplemental.json').write_text(json.dumps({'cargo:local@1':[item]}), encoding='utf-8')
    report = inventory(bundle)
    assert report['passed']
    destination = tmp_path/'THIRD-PARTY.txt'
    scope['write_notices'](report, destination)
    assert 'Verified artifact attribution' in destination.read_text()
    assert evidence.read_text() in destination.read_text()
    evidence.write_text('Changed evidence', encoding='utf-8')
    with pytest.raises(ValueError, match='Altered license evidence'):
        inventory(bundle)
    with pytest.raises(ValueError, match='evidence changed'):
        scope['write_notices'](report, destination)
    (bundle/'build-manifest.json').write_text('{"packages":[]}', encoding='utf-8')
    with pytest.raises(ValueError, match='empty'):
        inventory(bundle)


def test_supplemental_terms_and_artifact_provenance_match_locked_versions():
    import hashlib
    import json

    root = Path(__file__).parents[2]
    licenses = root/'app/licenses'
    supplements = json.loads((licenses/'supplemental.json').read_text())
    for items in supplements.values():
        for item in items:
            assert hashlib.sha256((licenses/item['file']).read_bytes()).hexdigest() == item['sha256']
    for key in ['cargo:block2@0.6.2', 'cargo:objc2@0.6.4', 'cargo:objc2-app-kit@0.3.2']:
        items = supplements[key]
        assert not any(item.get('note') for item in items)
        text = '\n'.join((licenses/item['file']).read_text() for item in items)
        assert 'Apple SDKs' in text
        assert 'Copyright 2026 Mads Marquart' in text
        assert 'Permission is hereby granted' in text
        assert 'THE SOFTWARE IS PROVIDED' in text
    item = supplements['npm:react-remove-scroll-bar@2.3.8'][0]
    evidence = item['evidence']
    raw = (licenses/evidence['file']).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == evidence['sha256']
    proof = json.loads(raw)
    lock = json.loads((root/'app/package-lock.json').read_text())
    package = lock['packages']['node_modules/react-remove-scroll-bar']
    release = next(release for release in proof['releases'] if release['version'] == package['version'])
    assert release['integrity'] == package['integrity']
    assert release['tarball'] == package['resolved']
    assert proof['licenseSource'] == item['source']
    assert len(proof['identicalPayloadSha256']) == 26
    assert set(proof['packageJsonDifferences']) == {'version', 'dependencies'}



def test_checksum_inputs_survive_windows_style_git_checkout(tmp_path):
    import subprocess

    root = Path(__file__).parents[2]
    names = ["app/licenses/texts/23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3.txt", "app/licenses/react-remove-scroll-bar-2.3.8.provenance.json", "app/fixtures/ai-import/formats/all-types.csv", "app/fixtures/ai-import/formats/all-types.txt"]
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".gitattributes").write_bytes((root / ".gitattributes").read_bytes())
    for name in names:
        destination = repo / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((root / name).read_bytes())
    def git(*args):
        subprocess.run(["git", "-c", "core.autocrlf=true", *args], cwd=repo, check=True, capture_output=True)
    git("init")
    git("add", ".")
    output = tmp_path / "checkout"
    output.mkdir()
    git("checkout-index", "--all", f"--prefix={output.as_posix()}/")
    for name in names:
        assert (output / name).read_bytes() == (root / name).read_bytes()
