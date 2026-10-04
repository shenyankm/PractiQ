"""Generate native acceptance bytes using the real service exporter and local storage."""

import asyncio
import hashlib
import io
import json
import sys
import wave
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
from practiq_ai.bank_export import export_task_bank
from practiq_ai.config import Config
from practiq_ai.contracts import DocumentTaskDetail, DocumentUploadRequest
from practiq_ai.storage import ObjectStore


async def main():
    destination = Path(sys.argv[1])
    destination.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="practiq-service-export-fixture-") as temporary:
        config = Config(provider="openai", api_key="not-used", model_id="not-used", storage_dir=Path(temporary),
                        source_max_bytes=25*1024*1024, vision_max_bytes=50*1024*1024, max_document_pages=100,
                        max_vision_page_pixels=25_000_000, max_total_input_chars=2_000_000,
                        graph_max_concurrency=2, storage_concurrency=4, storage_timeout_seconds=30,
                        model_timeout_seconds=180, model_max_tokens=16_384)
        store = ObjectStore(config)
        raw = b"Listening material. Q-known: choose A. Supplied answer: A. Q-null: choose A or B. No supplied answer."
        source = await store.put_document(raw, DocumentUploadRequest(sourceType="text", fileName="partial-media.txt",
            mediaType="text/plain", sizeBytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
        png = io.BytesIO()
        Image.new("RGB", (16, 12), "white").save(png, "PNG")
        image = await store.put_artifact(png.getvalue(), source_sha256=source.sha256, kind="visual", index=0, media_type="image/png")
        wav = io.BytesIO()
        with wave.open(wav, "wb") as sound:
            sound.setnchannels(1); sound.setsampwidth(2); sound.setframerate(8000); sound.writeframes(b"\0\0" * 800)
        audio = await store.put_artifact(wav.getvalue(), source_sha256=source.sha256, kind="audio", index=0, media_type="audio/wav")
        questions = [
            {"id":"listening", "answerMode":"listening", "questionKind":"listening", "questionTypeId":"listening",
             "stem":"Listening material", "audioRef":audio.model_dump(mode="json"),
             "passage":[{"partType":"text", "textValue":"Shared listening material"}],
             "transcript":[{"partType":"text", "role":"transcript", "textValue":"A supplied source transcript."}],
             "answerPayload":None, "sourceText":"Listening material.", "confidence":1, "needsReview":False},
            {"id":"q-known", "parentId":"listening", "stem":"Choose A", "answerMode":"choice", "questionTypeId":"choice",
             "choiceVariant":"single", "options":[{"label":"A","content":"Known"},{"label":"B","content":"Other"}],
             "answerPayload":{"correct":["A"]}, "sourceScore":100.0, "sourceText":"Q-known: choose A. Supplied answer: A.",
             "confidence":1, "needsReview":False},
            {"id":"q-null", "parentId":"listening", "stem":"Choose A or B", "answerMode":"choice", "questionTypeId":"choice",
             "choiceVariant":"single", "options":[{"label":"A","content":"One"},{"label":"B","content":"Two"}],
             "answerPayload":None, "sourceScore":None, "sourceText":"Q-null: choose A or B. No supplied answer.",
             "confidence":0.5, "needsReview":True, "missingFields":["answerPayload"]},
        ]
        result = {"schemaVersion":3, "questions":questions, "groups":[{"title":"Listening section", "instructions":None,
                   "questionIds":["listening","q-known","q-null"]}], "visualElements":[{"kind":"image",
                   "description":"Shared original visual", "questionIds":["listening","q-known","q-null"],
                   "imageRef":image.model_dump(mode="json"), "sourceRef":image.model_dump(mode="json")}],
                  "warnings":["One source unit could not be parsed; supplied answers remain incomplete."], "confidenceScore":80,
                  "missingFields":[]}
        processing = {"chunks":{"total":2,"succeeded":1,"skipped":0}, "visuals":{"total":1,"succeeded":1,"skipped":0},
                      "truncated":True, "failures":[{"stage":"document_parse","index":1,"code":"MODEL_UNAVAILABLE",
                      "retryable":True,"retriesRemaining":1}], "questionSources":[{"questionId":qid,"stage":"document_parse",
                      "unitIndex":0} for qid in ("listening","q-known","q-null")], "quality":{"reviewRequired":True,
                      "reviewQuestionCount":1,"issues":[{"questionId":"q-null","code":"NEEDS_REVIEW"}]}}
        task = DocumentTaskDetail.model_validate({"threadId":"11111111-1111-4111-8111-111111111111", "runId":None,
            "parentThreadId":None,"modelConfigured":False,"resumeCompatible":False,"fileName":"partial-media.txt",
            "state":"COMPLETED","phase":"completed","checkpointId":"current-fixture-result","updatedAt":"2026-10-04",
            "expiresAt":"2026-10-05","allowedActions":[],"failures":[],"blocking":[],
            "progress":{"visuals":{"total":1,"succeeded":1,"failed":0,"remaining":0},
                        "chunks":{"total":2,"succeeded":1,"failed":1,"remaining":0}},
            "status":"PARTIAL","result":result,"modelBudget":{"limit":1,"reserved":0},"processing":processing,
            "usage":[],"unknownUsageCalls":[]})
        payload = await export_task_bank(task, store, source=source, title="Service partial media", description="Real exporter acceptance fixture")
        archive = destination / "partial-media-bank.zip"
        archive.write_bytes(payload)
        assert task.result is not None
        dumped = json.dumps(task.result.model_dump(mode="json"), sort_keys=True, ensure_ascii=False).encode()
        manifest = {"archive":archive.name, "archiveSha256":hashlib.sha256(payload).hexdigest(), "archiveBytes":len(payload),
                    "source":source.model_dump(mode="json"), "image":image.model_dump(mode="json"),
                    "audio":audio.model_dump(mode="json"), "resultDumpSha256":hashlib.sha256(dumped).hexdigest(),
                    "exporterSha256":hashlib.sha256(Path(export_task_bank.__code__.co_filename).read_bytes()).hexdigest(),
                    "boundary":"Real exporter/ObjectStore bytes; fake supplied parse result; no models or native acceptance yet."}
        (destination / "provenance.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False)+"\n")
        print(json.dumps(manifest, indent=2, ensure_ascii=False))


asyncio.run(main())
