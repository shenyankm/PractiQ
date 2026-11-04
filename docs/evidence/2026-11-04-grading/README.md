# Subjective grading: local engineering acceptance, 2026-11-04

This change adds grounded scoring-point breakdowns to direct and service grading, and explicit grading after submitting an ordinary practice answer. It keeps schema 11, frozen questions/answers, previous scores, request receipts, manual overrides and existing credential namespaces. The initial engineering checks used model substitutes. After the user authorized real calls, a separate service-mode run exercised the configured provider; see the [live follow-up](live-service-8360d179d29f/README.md). Independent human-labelled samples are not currently available.

## Results and boundaries

| Check | Result | Evidence |
| --- | --- | --- |
| Shared scoring contract | Python is authoritative; generated JSON Schema/TypeScript and a shared 14-case corpus check both native and service validators | `server/evals/badcases/grading-evidence-v2.json`, `app/scripts/export-contracts.py` |
| Scoring validation | Missing/duplicated criteria, invented quotations, inconsistent scores/maxima and unsupported abstention are rejected; prior scores remain intact | Python and Rust regression tests |
| Ordinary practice | Submitted current short answer can be graded without finishing the session or sending later questions; source maximum or a documented 100-point fallback; partial credit has its own answer-card state | Native GUI, frontend and Rust tests |
| Local automated checks | Final outcomes and initial failures are recorded separately | [checks.json](checks.json) |
| Real macOS credential store | Isolated random accounts passed set/read/delete for both `ai-service-token-` and `ai-model-key-v1-` | Explicit `settings::tests::native_keychain_roundtrip` |
| macOS GUI, Rust HTTP and SQLite | Three explicit loopback calls: valid 60/100, invented reference rejected, connection dropped. Restart and checking retained the score/unknown receipt without another call | [native.json](native.json) |
| Native backup/restore | Native picker export and full restore retained all three receipts; archive excluded the dummy key. Deleting the key and testing after restore failed locally with the missing-key message | [native.json](native.json) |
| Original user data | The standard application's database checksum remained unchanged; the GUI used `com.practiq.acceptance.grading20261104` and only synthetic data | [native.json](native.json) |
| Standard development installer | Current `.app`/DMG built with `tauri build --ci`; package/version/runtime checks passed | [installer-raw.json](installer-raw.json) |
| Locally sealed acceptance installer | A separate copy received an ad-hoc signature and was repackaged. Package inspection and strict signature verification of the application inside that exact DMG passed | [installer.json](installer.json), [signature.json](signature.json) |
| Publisher signature / notarization / clean machine | **Not run.** The locally sealed copy has no verified publisher identity. The original development bundle's incomplete linker signature failed strict verification and is retained as a separate result | [signature-raw.json](signature-raw.json) |
| Real-provider synthetic samples | 26/26 outcomes matched after correcting a scorer false negative, using retained responses and no extra calls; 26 provider requests included one schema correction | [Live follow-up](live-service-8360d179d29f/README.md) |
| Native Rust direct real provider | Four explicit Chat Completions requests matched full/partial/instruction/abstention expectations; disconnected-client cache checks passed. Retained real responses passed offline reopen/backup checks after correcting a test view mismatch | [Native live follow-up](live-native-bebccd54e699/README.md) |
| Independent grading accuracy | **Not established.** No teacher labels or formal examination calibration is claimed | `server/evals/grading-practice-v2.json` |

The GUI candidate differs from the standard installer by its explicitly recorded application name/identifier; it is not proof that the standard final installer passed a clean-machine installation trial. The GUI was inspected at 1280×850 in the existing dark theme. The ordinary-practice partial-credit marker was corrected after its first inspection and rechecked in the rebuilt native application. The substitute returned deliberately synthetic explanations, not model judgements. Dummy credentials were cleared and the substitute/application were stopped after acceptance.

The standard development bundle is kept unchanged. The locally sealed DMG is at `app/.build/grading-local-20261104/PractiQ-grading-local.dmg`; its hash is in the linked reports. It is a local acceptance artifact, not a Developer ID signed/notarized release. No release was published.

## Quality evaluation preparation

`server/evals/grading-practice-v2.json` contains 26 AI-authored engineering examples across six subjects and safety/abstention. Preflight verifies payloads without loading model credentials or opening a database. Expected abstention is distinct from a failed/unknown request. External reviewed samples can declare subject, score tolerance and reviewer/source-consent provenance; `--require-independent-review` rejects unreviewed calibration input before paid work. Passing these synthetic examples would not establish independent grading quality.

Quotation checks establish that supplied text is present and score arithmetic is consistent. They do not prove rubric coverage, correct interpretation, fairness or teacher agreement. Those remain the next acceptance gate when independently reviewed samples are available. Historical results without a breakdown remain readable; new direct prompt version 2 or a changed target requires explicit regrading, and older service deployments need the updated response contract for new scores.

## Reproduction

From the repository root, with an existing Python 3.14+ interpreter:

```sh
make app-check AI_PYTHON=/path/to/python3.14
make verify AI_PYTHON=/path/to/python3.14
cargo test --manifest-path app/src-tauri/Cargo.toml native_keychain_roundtrip -- --ignored
```

From `server/`, validate the new engineering corpus without paid work:

```sh
python scripts/evaluate_grading.py --validate-only \
  --anchors evals/grading-practice-v2.json --repeats 3
```

Local detailed logs, the loopback substitute driver and disposable backup are retained under `app/.build/grading-*`. The versioned evidence contains no credentials, databases or private study backups. Source and executable hashes identify the uncommitted local candidate; no remote CI or release identity is implied.
