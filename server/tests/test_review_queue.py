import json

from practiq_ai import telemetry
from scripts import review_queue


def candidate(index, source="text", status="SUCCEEDED", review=False):
    return {"event": "review_candidate", "threadId": f"thread-{index}", "runId": f"run-{index}",
            "sourceType": source, "status": status, "reviewRequired": review}


def test_local_review_sampling_deduplicates_and_preserves_all_failures(tmp_path):
    events = [candidate(i, source) for source in ("text", "pdf") for i in range(2000)]
    # Each run has one format; stable IDs still span distinct format strata.
    for i, event in enumerate(events):
        event.update(threadId=f"thread-{i}", runId=f"run-{i}")
    required = [candidate("bad", status="ERROR"), candidate("partial", status="PARTIAL"), candidate("review", review=True)]
    events.extend(required)
    events.extend(required)
    report = review_queue.select_reviews(events)
    assert all(any(item["threadId"] == event["threadId"] for item in report["items"]) for event in required)
    assert report == review_queue.select_reviews(list(reversed(events)))
    assert 50 < report["selectedByFormat"]["pdf"] < 150
    assert report["observedByFormat"] == {"text": 2003, "pdf": 2000}
    log = tmp_path / "events.jsonl"
    log.write_text("\n".join(json.dumps({**event, "messages": "PRIVATE", "objectKey": "PRIVATE"}) for event in required))
    output = tmp_path / "queue.json"
    assert review_queue.main([str(log), "--output", str(output)]) == 0
    assert "PRIVATE" not in output.read_text()
    assert output.with_suffix(".md").is_file()
    assert review_queue.main([str(log), "--output", str(output)]) == 2


def test_event_capture_is_scoped_and_excludes_content_fields(caplog):
    with caplog.at_level("INFO", logger="practiq.events"), telemetry.capture_events() as events:
        telemetry.event("stage", stage="prepare", outcome="success", messages="PRIVATE", image="PRIVATE", exception="PRIVATE", signedUrl="PRIVATE", apiKey="PRIVATE")
    telemetry.event("stage", stage="merge")
    assert len(events) == 1 and events[0]["stage"] == "prepare"
    assert "PRIVATE" not in json.dumps(events) + caplog.text
