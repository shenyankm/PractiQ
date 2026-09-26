from pathlib import Path
from PyInstaller.utils.hooks import collect_all, copy_metadata

root = Path(SPECPATH).parents[1]
source = root / 'server/src'
datas = [(str(p), str(p.parent.relative_to(source))) for p in (source/'practiq_ai').rglob('*.py')]
datas.append((str(root/'server/uv.lock'), 'practiq_ai'))
binaries = []
hiddenimports = []
for package in ('langgraph', 'langchain_core', 'langchain_openai', 'practiq_ai', 'pypdfium2', 'pypdfium2_raw', 'sqlite_vec', 'uvicorn'):
    data, libs, hidden = collect_all(package)
    datas += data
    binaries += libs
    hiddenimports += hidden
for distribution in ('practiq-ai-service','langgraph','langgraph-checkpoint-sqlite','aiosqlite','langchain-core','langchain-openai','pydantic','pypdfium2','pillow'):
    datas += copy_metadata(distribution, recursive=True)
# Namespace discovery can see optional backends installed in the build interpreter.
datas = [(source, target) for source, target in datas if not any(name in source.lower() for name in ('langgraph_checkpoint_postgres', '/langgraph/checkpoint/postgres/', '/langgraph/store/postgres/', 'psycopg', 'openpyxl', 'et_xmlfile'))]
a = Analysis([str(root/'app/scripts/sidecar-entry.py')], pathex=[str(root/'server/src')], binaries=binaries, datas=datas, hiddenimports=hiddenimports, excludes=['langgraph_api','langgraph_runtime_inmem','langgraph_grpc_common','langgraph.store.postgres','langgraph.checkpoint.postgres','psycopg','psycopg_pool','openpyxl','docx','pytest','IPython','tkinter','matplotlib'])
# Check the analyzed modules as well as metadata: optional imports need not carry metadata.
assert not any(name.startswith(('langgraph_api', 'langgraph_runtime_inmem', 'langgraph_grpc_common')) for name, *_ in a.pure), 'Retired Agent Server modules were bundled'
pyz = PYZ(a.pure)
exe = EXE(pyz,a.scripts,[],exclude_binaries=True,name='practiq-ai',console=True,target_arch='arm64',codesign_identity=None)
coll = COLLECT(exe,a.binaries,a.datas,strip=False,upx=False,name='python')
