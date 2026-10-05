"""Durable Office preparation before the existing source extractors run."""

import asyncio
from typing import Any, Literal, Self

from langgraph.runtime import Runtime
from pydantic import Field, model_validator

from .config import Config, load
from .contracts import (
    OFFICE_SOURCE_TYPES,
    ArtifactReference,
    DocumentReference,
    OfficeMode,
    StrictModel,
)
from .errors import DocumentProcessingError
from .execution import namespace, run_remaining, store_put
from .storage import ObjectStore, get_object_store


class NormalizedSource(StrictModel):
    index: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=255)
    sourceType: Literal["pdf", "text", "csv"]
    hasContent: bool
    reference: ArtifactReference

    @model_validator(mode="after")
    def safe_name_and_type(self) -> Self:
        if self.name in {".", ".."} or any(char in self.name for char in "/\\:\x00"):
            raise ValueError("Normalized source name must be a basename")
        expected = {"pdf": "application/pdf", "text": "text/plain", "csv": "text/csv"}[self.sourceType]
        if self.reference.mediaType != expected or self.reference.sizeBytes > 25 * 1024 * 1024:
            raise ValueError("Normalized source type or size is invalid")
        return self


class OfficeNormalization(StrictModel):
    sourceSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    mode: OfficeMode
    engine: dict[str, str]
    sources: list[NormalizedSource] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def ordered_sources(self) -> Self:
        if [source.index for source in self.sources] != list(range(len(self.sources))):
            raise ValueError("Normalized sources must retain their ordered indices")
        if len({source.name for source in self.sources}) != len(self.sources):
            raise ValueError("Normalized source names must be unique")
        if sum(source.reference.sizeBytes for source in self.sources) > 100 * 1024 * 1024:
            raise ValueError("Normalized sources exceed their total byte limit")
        return self


async def verified_normalization(reference: DocumentReference, value: Any, *, mode: OfficeMode,
                                 store: ObjectStore, config: Config) -> OfficeNormalization:
    from .office_service import engine_identity
    try:
        manifest = OfficeNormalization.model_validate(value)
    except ValueError as exc:
        raise DocumentProcessingError(409, "Office normalization record is invalid", "OFFICE_MANIFEST_INVALID") from exc
    expected_type = "pdf" if mode == "pdf" else "text" if reference.sourceType in {"doc", "docx"} else "csv"
    if (manifest.sourceSha256 != reference.sha256 or manifest.mode != mode
            or any(source.sourceType != expected_type for source in manifest.sources)
            or expected_type != "csv" and len(manifest.sources) != 1):
        raise DocumentProcessingError(409, "Office normalization does not match its original source", "OFFICE_MANIFEST_INVALID")
    if manifest.engine != await asyncio.to_thread(engine_identity, config):
        raise DocumentProcessingError(409, "Office deployment changed; reparse the original source", "EXECUTION_VERSION_MISMATCH")
    prefix = f"practiq-agent/artifacts/{reference.sha256}/office/"
    for source in manifest.sources:
        if not source.reference.objectKey.startswith(prefix):
            raise DocumentProcessingError(422, "Normalized artifact belongs to another source", "INVALID_OBJECT_REFERENCE")
        await store.get_verified(source.reference)
    return manifest


async def normalize_source(state: dict[str, Any], runtime: Runtime[Any]) -> dict[str, Any]:
    from .office_service import convert_office, engine_identity
    reference = DocumentReference.model_validate(state["document"])
    if reference.sourceType not in OFFICE_SOURCE_TYPES:
        return {}
    mode = state.get("officeMode") or "pdf"
    config = load()
    if config.office_executable is None:
        raise DocumentProcessingError(503, "Office conversion is not configured", "OFFICE_NOT_CONFIGURED")
    store = await asyncio.to_thread(get_object_store)
    payload = await store.get_verified(reference)
    info = runtime.execution_info
    if runtime.store is None or info is None or info.thread_id is None:
        raise DocumentProcessingError(503, "Office preparation requires a durable Store", "EXECUTION_STORE_REQUIRED")
    try:
        previous = await runtime.store.aget(namespace(info.thread_id, "normalization"), "source", refresh_ttl=False)
    except Exception as exc:
        raise DocumentProcessingError(503, "Office preparation storage is unavailable", "EXECUTION_STORE_UNAVAILABLE") from exc
    if previous:
        del payload
        manifest = await verified_normalization(reference, previous.value, mode=mode, store=store, config=config)
    else:
        identity = await asyncio.to_thread(engine_identity, config)
        converted = await convert_office(reference, payload, mode=mode, config=config,
                                        timeout=min(180, await run_remaining(runtime)))
        sources = []
        for index, output in enumerate(converted):
            artifact = await store.put_artifact(output.payload, source_sha256=reference.sha256,
                                                kind="office", index=index, media_type=output.media_type)
            sources.append(NormalizedSource(index=index, name=output.name, sourceType=output.source_type,
                                            hasContent=output.has_content, reference=artifact))
        manifest = await verified_normalization(reference, OfficeNormalization(sourceSha256=reference.sha256,
            mode=mode, engine=identity, sources=sources), mode=mode, store=store, config=config)
        await store_put(runtime, "normalization", "source", manifest.model_dump(mode="json"))
    # Sync graph durability checkpoints this manifest before prepare can call a model.
    return {"normalization": manifest.model_dump(mode="json")}
