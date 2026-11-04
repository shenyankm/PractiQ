# Native Rust direct-provider acceptance

The user explicitly requested verification of desktop direct grading against a real model. This run invoked the desktop's existing `ai::grade → model_grading::grade → reqwest` code on macOS against the configured `deepseek-v4.1-flash` gateway at `amr-link.open-design.ai`, using Chat Completions. It did not call the Python service or replace Rust networking with a Python implementation.

Four cases were selected unchanged from the existing AI-authored synthetic corpus. The first three used submitted current answers in unfinished ordinary-practice sessions; the conflicting-rubric case used a submitted self-test with a five-point maximum.

| Case | Expected | Observed |
| --- | --- | --- |
| `science_full` | 5/5 | 5/5, grounded criteria retained |
| `science_partial` | 3/5 | 3/5, grounded criteria retained |
| `science_instruction` | 0/5 | 0/5, instruction in the answer did not grant marks |
| `conflicting_rubric` | Abstention | Ungraded, explanation and review reason retained |

There were **four native grading dispatches**, one per case, with no application retries or explicit regrading. All four returned provider request IDs and known usage: **2,629 input tokens and 3,140 output tokens**. Each request used the production 4,096-output-token bound. Gateway monetary rates were not configured, so cost is unknown.

## Credential, cache and persistence evidence

- Configuration and credentials were sent through process stdin to the temporary native test. The Rust code wrote/read the real key using the existing macOS credential helper in a random, isolated service/account under the `ai-model-key-v1-` namespace. No key was written to source, SQLite, evidence, command arguments or frontend state. [Cleanup](report.cleanup.json) confirms its deletion.
- Each real outcome was recorded through the existing local receipt/store path. Repeating the same request with a client forced through a disconnected loopback proxy returned the identical cached attempt for all four cases, making another provider call impossible during that check.
- The [original report](report.json), [execution log](execution.log) and [metadata](metadata.json) are retained unchanged. The original combined probe exited **FAILED** because its reopen/backup checks compared compact `session_data` attempts with expanded test-only `session` attempts. Scoring and disconnected-client cache checks passed for all four cases.
- The [offline persistence report](offline-persistence.json) reproduces that mismatch: `snapshot` is the only differing expanded-view field for every case. Replaying the identical retained real responses through the store in fresh isolated databases and comparing compact views passed reopen and backup/restore checks for all four cases. Raw response equality was verified after restoration. This follow-up made **zero additional provider requests** and did not revisit the original temporary databases, which had already been removed.
- The standard user's practice database checksum was unchanged. Temporary acceptance databases and backup archives were removed with their temporary directories. The original real run also verified that backup entries contained no API key.

## Reproducibility and limits

The [native probe](probe.txt) and [driver](driver.txt) record the original one-time orchestration. [Offline probe](offline-probe.txt) and [offline driver](offline-driver.txt) record the follow-up. These were run from `app/.build/grading-direct-live/`; copying them elsewhere requires adjusting their relative paths. The live driver requires the temporary candidate source and would incur paid work if explicitly reconstructed and run again. No live test was added to the default suite.

Both temporary native test insertions were removed and the original `ai.rs` bytes restored; production grading code was not changed during this validation. Source/corpus/executable fingerprints are in the metadata, with final checks in [checks.json](checks.json).

This is real native backend/HTTP/Keychain/SQLite evidence. This run did not click the GUI or exercise Tauri IPC against the real provider; the earlier GUI acceptance used a substitute. No release build or clean-machine test was repeated. Four synthetic cases do not establish teacher agreement, cross-subject quality or repeated-run consistency; independent calibration remains unestablished.
