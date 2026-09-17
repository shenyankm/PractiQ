"""Product inline/envelope compatibility over the sole local-storage document graph.

No extraction or question parsing lives here. Native references and graph output
remain unchanged; only the product boundary uses Java's answer-key spelling.
"""

import asyncio
import base64
import hashlib
from io import BytesIO

from PIL import Image

from practiq_ai.config import load
from practiq_ai.contracts import (
    DOCUMENT_MEDIA_TYPES,
    ArtifactReference,
    DocumentUploadRequest,
)
from practiq_ai.errors import DocumentProcessingError
from practiq_ai.storage import get_object_store

from .ai_schemas import DocumentParseRequest, DocumentParseResult


def _source(request: DocumentParseRequest) -> tuple[bytes, str]:
    limit = load().source_max_bytes
    try:
        if request.sourceType == "text":
            payload = (request.text or "").encode("utf-8")
        else:
            encoded = request.fileBase64 or ""
            if len(encoded) > ((limit + 2) // 3) * 4:
                raise DocumentProcessingError(413, "Uploaded file is too large", "DOCUMENT_TOO_LARGE")
            payload = base64.b64decode(encoded, validate=True)
    except (ValueError, UnicodeError) as exc:
        raise DocumentProcessingError(400, "Invalid source encoding", "INVALID_FILE_CONTENT") from exc
    if len(payload) > limit:
        raise DocumentProcessingError(413, "Uploaded file is too large", "DOCUMENT_TOO_LARGE")
    if not payload:
        raise DocumentProcessingError(422, "Document is empty", "INVALID_FILE_CONTENT")
    if request.sourceType == "image":
        try:
            with Image.open(BytesIO(payload)) as image:
                media_type = Image.MIME.get(image.format or "", "image/jpeg")
        except (OSError, ValueError) as exc:
            raise DocumentProcessingError(400, "Invalid image", "INVALID_FILE_CONTENT") from exc
    else:
        media_type = next(iter(DOCUMENT_MEDIA_TYPES[request.sourceType]))
    return payload, media_type


async def parse_document(request: DocumentParseRequest) -> DocumentParseResult:
    # Lazy import avoids building graphs before environment validation at startup.
    from practiq_ai.graphs.document import graph
    from practiq_ai.graphs.vision import crop_figure

    payload, media_type = await asyncio.to_thread(_source, request)
    store = get_object_store()
    reference = await store.put_document(
        payload,
        DocumentUploadRequest(
            sourceType=request.sourceType,
            fileName=request.fileName or f"source.{request.sourceType}",
            mediaType=media_type,
            sizeBytes=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        ),
    )
    output = await graph.ainvoke({"document": reference.model_dump(mode="json")})
    result = dict(output["result"])
    result["qualityScore"] = result.pop("confidenceScore")
    result["status"] = output["status"]
    result["processing"] = output["processing"]
    for question in result["questions"]:
        if output["status"] == "PARTIAL":
            question["needsReview"] = True
    for visual in result["visualElements"]:
        if visual.get("imageRef"):
            image = await store.get_verified(ArtifactReference.model_validate(visual["imageRef"]))
            # Keep the local reference and a bounded preview; never expose disk paths.
            if len(image) > 300_000:
                image = await asyncio.to_thread(crop_figure, image, [0, 0, 1, 1])
            if image is None:
                raise DocumentProcessingError(502, "Could not create image preview", "CROP_FAILED")
            visual["imageBase64"] = base64.b64encode(image).decode("ascii")
    return DocumentParseResult.model_validate(result)
