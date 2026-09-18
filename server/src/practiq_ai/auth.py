"""Service-token authentication for Agent Server and custom routes."""

import re
import secrets

from langgraph_sdk import Auth

from practiq_ai.capacity import admit_run
from practiq_ai.config import load, service_token
from practiq_ai.errors import DocumentProcessingError

auth = Auth()


@auth.authenticate
async def authenticate(
    authorization: str | None, path: str = "", method: str = ""
) -> Auth.types.MinimalUserDict:
    # Preserve the existing Java deployment's public liveness probe only.
    if method == "GET" and path == "/api/health/live":
        return {"identity": "health-probe"}
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(
        token, service_token()
    ):
        raise Auth.exceptions.HTTPException(status_code=401, detail="Invalid service token")
    if method == "POST" and re.fullmatch(r"/(?:threads/[^/]+/)?runs(?:/(?:stream|wait|batch))?/?", path):
        if path.rstrip("/").endswith("/batch"):
            raise Auth.exceptions.HTTPException(status_code=422, detail="Submit runs individually for capacity admission")
        try:
            await admit_run()
        except DocumentProcessingError as exc:
            raise Auth.exceptions.HTTPException(status_code=exc.status_code, detail=exc.code) from exc
    if method == "POST" and "/crons" in path:
        raise Auth.exceptions.HTTPException(status_code=422, detail="Scheduled runs bypass document admission")
    if (load().maintenance and not path.startswith("/api/") and method in {"POST", "PUT", "PATCH", "DELETE"}
            and not (method == "POST" and path.rstrip("/").endswith(("/search", "/count", "/history", "/cancel")))):
        raise Auth.exceptions.HTTPException(status_code=503, detail="MAINTENANCE")
    return {"identity": "practiq-java"}
