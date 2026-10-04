"""Select checks from the complete change set and fail closed at the CI gate."""
import json
import os
import runpy
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts/ci_scope.py"


@pytest.fixture
def ci_scope():
    return SimpleNamespace(**runpy.run_path(str(SCRIPT)))


@pytest.mark.parametrize("paths,service,desktop", [
    (None, True, True),
    ([], False, False),
    (["README.md", "README.zh-CN.md", "docs/guide.md"], False, False),
    (["CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", "app/docs/guide.md", "server/docs/guide.md"], False, False),
    ([".agents/skills/example/SKILL.md"], False, False),
    ([".github/PULL_REQUEST_TEMPLATE.md"], True, True),
    ([".github/actions/check/action.yml"], True, True),
    (["server/src/practiq_ai/webapp.py"], True, True),
    (["web/src/App.tsx"], True, False),
    (["web/package-lock.json"], True, False),
    (["app/fixtures/english.json"], True, True),
    (["app/scripts/check-rich-recognition.py"], True, True),
    (["app/scripts/check_licenses.py"], False, True),
    (["app/licenses/texts/notice.txt"], False, True),
    (["app/licenses/texts/notice.md"], False, True),
    (["app/src-tauri/vendor/glib/LICENSE.md"], False, True),
    (["server/src/practiq_ai/prompts/import.md"], True, True),
    (["app/src/App.tsx", "README.md"], False, True),
    (["Makefile"], True, True),
    (["rust-toolchain.toml"], False, True),
    (["Dockerfile.server"], True, False),
    ([".dockerignore"], True, False),
    ([".gitignore"], True, True),
    ([".env.example"], True, False),
    ([".gitattributes"], False, True),
    (["LICENSE"], False, True),
    (["tools/local.py"], False, False),
])
def test_selectors_preserve_real_inputs_and_skip_documentation(ci_scope, paths, service, desktop):
    assert ci_scope.checks_required("service", paths) is service
    assert ci_scope.checks_required("desktop", paths) is desktop


def test_pr_paths_include_every_api_page_and_both_sides_of_a_rename(ci_scope, monkeypatch):
    pages = [[{"filename": "README.md"}],
             [{"filename": "docs/import.md", "previous_filename": "server/src/import.py", "status": "renamed"}]]

    def api(command, **kwargs):
        assert command[:4] == ["gh", "api", "--paginate", "--slurp"]
        assert command[4] == "repos/owner/repo/pulls/17/files?per_page=100"
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(pages))

    monkeypatch.setattr(ci_scope.subprocess, "run", api)
    paths = ci_scope.changed_paths("pull_request", {"number": 17}, "owner/repo")
    assert set(paths) == {"README.md", "docs/import.md", "server/src/import.py"}
    assert ci_scope.checks_required("service", paths)


@pytest.mark.parametrize("count", [2999, 3000])
def test_pr_file_cap_runs_all_checks_instead_of_trusting_truncated_paths(ci_scope, monkeypatch, count):
    files = [{"filename": f"docs/{index}.md"} for index in range(count)]
    monkeypatch.setattr(ci_scope.subprocess, "run", lambda command, **kwargs:
                        subprocess.CompletedProcess(command, 0, stdout=json.dumps([files[:1500], files[1500:]])))
    paths = ci_scope.changed_paths("pull_request", {"number": 17}, "owner/repo")
    assert (paths is None) is (count == 3000)
    assert ci_scope.checks_required("service", paths) is (count == 3000)


def test_push_paths_cover_all_commits_and_deleted_rename_source(ci_scope, tmp_path, monkeypatch):
    def git(*args):
        return subprocess.run(["git", "-c", "user.name=CI test", "-c", "user.email=ci@example.test",
                               "-c", f"core.hooksPath={tmp_path / 'no-hooks'}", *args], cwd=tmp_path,
                              check=True, capture_output=True, text=True).stdout.strip()

    git("init", "--quiet")
    source = tmp_path / "server/src/import.py"
    source.parent.mkdir(parents=True)
    source.write_text("old module\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-qm", "Before push")
    before = git("rev-parse", "HEAD")
    renamed = tmp_path / "docs/已移除 server module.md"
    renamed.parent.mkdir()
    source.rename(renamed)
    git("add", "-A")
    git("commit", "-qm", "Rename source into documentation")
    (tmp_path / "README.md").write_text("Latest commit only changes documentation\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-qm", "Update README")
    monkeypatch.chdir(tmp_path)
    paths = ci_scope.changed_paths("push", {"before": before}, "owner/repo")
    assert set(paths) == {"server/src/import.py", "docs/已移除 server module.md", "README.md"}
    assert ci_scope.checks_required("service", paths)


@pytest.mark.parametrize("payload", [{}, {"before": ""}, {"before": "0" * 40}, {"before": "f" * 40}])
def test_missing_or_unavailable_push_base_requires_all_checks(ci_scope, monkeypatch, payload):
    commands = []

    def unavailable(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 1)

    monkeypatch.setattr(ci_scope.subprocess, "run", unavailable)
    assert ci_scope.changed_paths("push", payload, "owner/repo") is None
    assert not any(command[:2] == ["git", "diff"] for command in commands)
    if payload.get("before") == "f" * 40:
        assert any(command[:2] == ["git", "fetch"] for command in commands)


def needs_for(scope, required=True):
    result = "success" if required else "skipped"
    needs = {"changes": {"result": "success", "outputs": {"required": str(required).lower()}},
             "quality": {"result": result}}
    if scope == "desktop":
        needs["package"] = {"result": result}
    return needs


@pytest.mark.parametrize("scope", ["service", "desktop"])
@pytest.mark.parametrize("required", [True, False])
def test_gate_accepts_completed_checks_or_deliberate_documentation_skip(ci_scope, scope, required):
    ci_scope.check_gate(scope, needs_for(scope, required))


@pytest.mark.parametrize("scope,job", [("service", "quality"), ("desktop", "quality"), ("desktop", "package")])
@pytest.mark.parametrize("required,result", [
    (True, "failure"), (True, "cancelled"), (True, "skipped"),
    (False, "failure"), (False, "cancelled"),
])
def test_gate_rejects_unsuccessful_required_checks(ci_scope, scope, job, required, result):
    needs = needs_for(scope, required)
    needs[job]["result"] = result
    with pytest.raises(ValueError):
        ci_scope.check_gate(scope, needs)


@pytest.mark.parametrize("changes", [
    {"result": "failure", "outputs": {"required": "false"}},
    {"result": "cancelled", "outputs": {"required": "true"}},
    {"result": "skipped", "outputs": {"required": "false"}},
    {"result": "success"},
    {"result": "success", "outputs": {}},
    {"result": "success", "outputs": {"required": "unknown"}},
])
def test_gate_rejects_failed_or_missing_scope_detection(ci_scope, changes):
    needs = needs_for("service")
    needs["changes"] = changes
    with pytest.raises(ValueError):
        ci_scope.check_gate("service", needs)


@pytest.mark.parametrize("scope", ["service", "desktop"])
@pytest.mark.parametrize("mutation", ["missing", "extra", "unexpected_run"])
def test_gate_rejects_incomplete_dependencies_and_inconsistent_skip(ci_scope, scope, mutation):
    needs = needs_for(scope, required=mutation != "unexpected_run")
    if mutation == "missing":
        needs.pop("quality")
    elif mutation == "extra":
        needs["unexpected"] = {"result": "success"}
    else:
        needs["quality"]["result"] = "success"
    with pytest.raises(ValueError):
        ci_scope.check_gate(scope, needs)


@pytest.mark.parametrize("scope,job,result", [
    ("service", "quality", "failure"),
    ("service", "quality", "cancelled"),
    ("service", "quality", "skipped"),
    ("desktop", "package", "failure"),
    ("desktop", "package", "cancelled"),
    ("service", "changes", None),
])
def test_gate_cli_propagates_decision_and_dependency_failures(scope, job, result):
    needs = needs_for(scope)
    if job == "changes":
        needs[job].pop("outputs")
    else:
        needs[job]["result"] = result
    process = subprocess.run([sys.executable, str(SCRIPT), "gate", scope],
                             env={**os.environ, "NEEDS": json.dumps(needs)},
                             capture_output=True, text=True, timeout=10, check=False)
    assert process.returncode == 1, process.stdout + process.stderr


def test_gate_cli_accepts_deliberate_documentation_skip():
    process = subprocess.run([sys.executable, str(SCRIPT), "gate", "desktop"],
                             env={**os.environ, "NEEDS": json.dumps(needs_for("desktop", required=False))},
                             capture_output=True, text=True, timeout=10, check=False)
    assert process.returncode == 0, process.stdout + process.stderr


@pytest.mark.parametrize("scope", ["service", "desktop"])
def test_manual_scope_cli_requires_checks_and_writes_action_output(tmp_path, scope):
    event, output = tmp_path / "event.json", tmp_path / "output"
    event.write_text("{}", encoding="utf-8")
    process = subprocess.run([sys.executable, str(SCRIPT), "scope", scope],
                             env={**os.environ, "GITHUB_EVENT_NAME": "workflow_dispatch",
                                  "GITHUB_EVENT_PATH": str(event), "GITHUB_REPOSITORY": "owner/repo",
                                  "GITHUB_OUTPUT": str(output)},
                             capture_output=True, text=True, timeout=10, check=False)
    assert process.returncode == 0, process.stdout + process.stderr
    assert "required=true" in output.read_text(encoding="utf-8").splitlines()


def test_release_ref_forces_full_checks_without_querying_changed_paths(tmp_path):
    event, output = tmp_path / "event.json", tmp_path / "output"
    # No PR number: accidental change detection would fail instead of querying GitHub.
    event.write_text("{}", encoding="utf-8")
    process = subprocess.run([sys.executable, str(SCRIPT), "scope", "desktop"],
                             env={**os.environ, "GITHUB_EVENT_NAME": "pull_request",
                                  "GITHUB_EVENT_PATH": str(event), "GITHUB_REPOSITORY": "owner/repo",
                                  "CI_FULL_CHECKS": "true", "GITHUB_OUTPUT": str(output)},
                             capture_output=True, text=True, timeout=10, check=False)
    assert process.returncode == 0, process.stdout + process.stderr
    assert output.read_text(encoding="utf-8") == "required=true\n"
