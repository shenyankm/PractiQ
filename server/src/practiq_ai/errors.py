"""Errors shared by graph nodes and the upload boundary."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .contracts import ModelCallUsage


class DocumentProcessingError(RuntimeError):
    def __init__(
        self,
        status_code: int,
        detail: str,
        code: str = "DOCUMENT_PROCESSING_FAILED",
        usage: list[ModelCallUsage] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code
        self.usage = list(usage or [])
