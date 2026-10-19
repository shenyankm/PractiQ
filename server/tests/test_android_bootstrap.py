"""Keep Android project discovery independent of frontend/APK packaging."""

import json
import runpy
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]


@pytest.mark.parametrize("target", ["aarch64-linux-android", "x86_64-linux-android"])
def test_bootstrap_generates_native_projects_without_building_an_apk(tmp_path, monkeypatch, target):
    scope = runpy.run_path(str(ROOT / "app/scripts/bootstrap-android.py"))
    bootstrap = scope["bootstrap"]
    monkeypatch.setitem(bootstrap.__globals__, "ROOT", tmp_path)
    native = tmp_path / "app/src-tauri"
    native.mkdir(parents=True)
    (native / "Cargo.toml").write_text('[lib]\nname = "practiq_desktop"\n')
    (native / "tauri.android.conf.json").write_text(json.dumps({
        "identifier": "com.practiq.android", "bundle": {"android": {"minSdkVersion": 26}},
    }))
    project = native / "gen/android"
    source = project / "app/src/main/java/com/practiq/android"
    source.mkdir(parents=True)
    activity = source / "MainActivity.kt"
    activity.write_text("retained host customization")
    ndk = tmp_path / "ndk"
    tools = ndk / "toolchains/llvm/prebuilt/test-host/bin"
    tools.mkdir(parents=True)
    for name in (f"{target}26-clang", f"{target}26-clang++", "llvm-ar"):
        (tools / name).touch()
    monkeypatch.setenv("NDK_HOME", str(ndk))
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda args, **kwargs: calls.append((args, kwargs)))

    bootstrap(target)

    command, options = calls[0]
    assert len(calls) == 1
    assert command == ["cargo", "build", "--locked", "--lib", "--target", target, "--features", "tauri/custom-protocol"]
    assert options["check"] is True and options["cwd"] == native
    env = options["env"]
    assert env["TAURI_ANDROID_PROJECT_PATH"] == str(project)
    assert env["WRY_ANDROID_KOTLIN_FILES_OUT_DIR"] == str(source / "generated")
    assert env["WRY_ANDROID_PACKAGE"] == env["TAURI_ANDROID_PACKAGE_UNESCAPED"] == "com.practiq.android"
    assert env["WRY_ANDROID_LIBRARY"] == "practiq_desktop"
    assert json.loads(env["TAURI_CONFIG"]) == {"bundle": {"resources": []}}
    assert env[f"CARGO_TARGET_{target.upper().replace('-', '_')}_LINKER"] == str(tools / f"{target}26-clang")
    assert activity.read_text() == "retained host customization"
    assert not list(project.rglob("*.apk"))

    (tools / f"{target}26-clang").unlink()
    with pytest.raises(ValueError, match="NDK"):
        bootstrap(target)
    assert len(calls) == 1
