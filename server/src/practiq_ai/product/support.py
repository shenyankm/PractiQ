"""Shared errors and limits for the existing Java generation boundary."""
import os

from practiq_ai.errors import DocumentProcessingError

__all__ = ["DocumentProcessingError", "get_upload_max_bytes", "positive_env"]


def positive_env[NumberT: (int, float)](
    name: str, default: NumberT, cast: type[NumberT] = int
) -> NumberT:
    try:
        value = cast(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default

def get_upload_max_bytes() -> int:
    return positive_env("AI_SOURCE_MAX_BYTES", 25 * 1024 * 1024)
