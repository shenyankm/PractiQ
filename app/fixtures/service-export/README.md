# Independent service export fixture

`partial-media-bank.zip` was produced by the real
`practiq_ai.bank_export.export_task_bank` and a temporary `ObjectStore`.
`generate.py` supplies a fixed parser result and calls that exporter. It does not
parse a document or invoke a model. `provenance.json` records the exporter,
source, result and archive hashes.

The completed task has a `PARTIAL` result with a listening parent and two choice
children. One supplied answer is `null`; warnings, failed-unit processing,
quality issues and question-source associations remain in the export. The PNG
is shared by `imageRef` and `sourceRef`; the WAV contains valid PCM audio. Both
resources belong to the original source SHA namespace.

The native `service_export_tests` regression consumes the exact archive. It
verifies appending to an existing bank, preservation of existing practice
snapshots, duplicate import and repair of missing image bytes, content-addressed
media, offline listening practice, an ungraded missing answer, and restoration
of history and media into an empty installation. Preview retains the processing
payload; native persistence retains warnings, question quality and remapped
source associations. Task processing remains in the independent service.

Ordinary Rust tests need no Python runtime or running service. To regenerate the
fixture explicitly, from the repository root with installed service dependencies:

```sh
PYTHONPATH=server/src "$AI_PYTHON" app/fixtures/service-export/generate.py /tmp/practiq-service-export
```

Compare the output archive hash and inspect any contract changes before replacing
the checked-in ZIP and provenance. This is synthetic supplied-result and native
storage acceptance; it does not establish model, WebView or installer acceptance.
