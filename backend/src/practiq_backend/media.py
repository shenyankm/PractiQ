import hashlib
import io
import zipfile
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, File, Request, Response, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError

from .core import DB, Error, Input, Positive, bank, invalid, ok, one, question

router = APIRouter(prefix="/api/v1")


def safe_path(root: Path, relative: str):
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        raise Error(422, "INVALID_PATH", "Invalid storage path")
    return target


def write_file(root: Path, data: bytes):
    digest = hashlib.sha256(data).hexdigest()
    path = safe_path(root, digest)
    root.mkdir(parents=True, exist_ok=True)
    # Content addressed files make upload retries safe; metadata commits separately.
    if not path.exists():
        import os
        import tempfile

        fd, temporary = tempfile.mkstemp(dir=root)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return digest


def image_type(data):
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > 40_000_000 or image.format not in {"PNG", "JPEG", "GIF", "WEBP"}:
                invalid("Unsupported or oversized image")
            kind = image.format
            image.verify()
        return {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp"}[kind]
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        invalid("Invalid image content")


def source_bytes(source_type, name, data):
    if not data or len(data) > 25 * 1024 * 1024:
        invalid("Import file must contain 1 byte to 25 MiB")
    extension = Path(name).suffix.lower()
    allowed = {
        "text": {".txt", ".md"},
        "csv": {".csv"},
        "pdf": {".pdf"},
        "docx": {".docx"},
        "xlsx": {".xlsx"},
        "image": {".png", ".jpg", ".jpeg", ".webp", ".gif"},
    }
    if extension not in allowed[source_type]:
        invalid("File extension does not match source type")
    if source_type in {"text", "csv"}:
        try:
            text = data.decode("utf-8-sig")
            if not text.strip() or "\0" in text:
                invalid("Text file is empty or contains binary content")
        except UnicodeError:
            invalid("Text files must be UTF-8")
    elif source_type == "pdf" and not data.startswith(b"%PDF-"):
        invalid("Invalid PDF signature")
    elif source_type in {"docx", "xlsx"}:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                files = archive.infolist()
                if len(files) > 10000 or sum(i.file_size for i in files) > 100 * 1024 * 1024:
                    invalid("Office archive is too large")
                if any(
                    i.flag_bits & 1 or i.filename.startswith("/") or ".." in Path(i.filename).parts
                    for i in files
                ):
                    invalid("Unsafe Office archive")
                required = "word/document.xml" if source_type == "docx" else "xl/workbook.xml"
                if required not in archive.namelist() or "[Content_Types].xml" not in archive.namelist():
                    invalid("Invalid Office document")
        except zipfile.BadZipFile:
            invalid("Invalid Office archive")
    elif source_type == "image":
        image_type(data)


@router.post("/media", status_code=201)
async def upload_media(request: Request, db: DB, file: Annotated[UploadFile, File()]):
    data = await file.read(10 * 1024 * 1024 + 1)
    if not data or len(data) > 10 * 1024 * 1024:
        invalid("Media file must contain 1 byte to 10 MiB")
    name = Path(file.filename or "media").name
    if len(name) > 255:
        invalid("File name is too long")
    if name.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
        mime, media_type = image_type(data), "image"
    elif data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        mime, media_type = "audio/wav", "audio"
    elif data.startswith(b"ID3") or (len(data) > 2 and data[0] == 255 and data[1] & 224 == 224):
        mime, media_type = "audio/mpeg", "audio"
    elif len(data) > 12 and data[4:8] == b"ftyp" and data[8:12] in {b"M4A ", b"M4B "}:
        mime, media_type = "audio/mp4", "audio"
    else:
        invalid("Unsupported media content")
    digest = write_file(request.app.state.settings.media_dir / "assets", data)
    asset = one(
        db,
        "insert into media_assets(storage_path,original_name,media_type,mime_type,size_bytes,checksum_sha256) values(%s,%s,%s,%s,%s,%s) on conflict(storage_path) do update set deleted_at=null returning id,original_name,media_type,mime_type,size_bytes",
        ("assets/" + digest, name, media_type, mime, len(data), digest),
    )
    return ok(asset)


@router.get("/media/{mid}")
def get_media(mid: Positive, db: DB):
    return ok(
        one(
            db,
            "select id,original_name,media_type,mime_type,size_bytes from media_assets where id=%s and deleted_at is null",
            (mid,),
        )
    )


@router.get("/media/{mid}/content")
def read_media(mid: Positive, request: Request, db: DB):
    asset = one(db, "select * from media_assets where id=%s and deleted_at is null", (mid,))
    path = safe_path(request.app.state.settings.media_dir, asset["storage_path"])
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != asset["checksum_sha256"]:
        raise Error(410, "MEDIA_UNAVAILABLE", "Media is missing or its checksum changed")
    return FileResponse(path, media_type=asset["mime_type"], headers={"Content-Disposition": "inline"})


@router.delete("/media/{mid}", status_code=204)
def delete_media(mid: Positive, db: DB):
    get_media(mid, db)
    if db.execute("select 1 from media_links where media_id=%s", (mid,)).fetchone():
        raise Error(409, "MEDIA_IN_USE", "Unlink this media before deleting it")
    db.execute("update media_assets set deleted_at=now() where id=%s", (mid,))
    return Response(status_code=204)


class MediaLink(Input):
    mediaId: Positive
    sortOrder: Positive = 1


def parent(db, kind, pid):
    if kind == "questions":
        question(db, pid)
        return "question_id"
    if kind == "groups":
        g = one(db, "select * from question_groups where id=%s", (pid,))
        bank(db, g["bank_id"])
        return "group_id"
    o = one(db, "select * from question_options where id=%s", (pid,))
    question(db, o["question_id"])
    return "option_id"


@router.post("/{kind}/{pid}/media-links", status_code=201)
def link(kind: Literal["questions", "groups", "options"], pid: Positive, body: MediaLink, db: DB):
    field = parent(db, kind, pid)
    get_media(body.mediaId, db)
    return ok(
        one(
            db,
            f"insert into media_links(media_id,{field},sort_order) values(%s,%s,%s) returning *",
            (body.mediaId, pid, body.sortOrder),
        )
    )


@router.delete("/{kind}/{pid}/media-links/{mid}", status_code=204)
def unlink(kind: Literal["questions", "groups", "options"], pid: Positive, mid: Positive, db: DB):
    field = parent(db, kind, pid)
    one(db, f"delete from media_links where {field}=%s and media_id=%s returning id", (pid, mid))
    return Response(status_code=204)
