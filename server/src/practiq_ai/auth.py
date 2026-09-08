"""Service-token authentication for Agent Server and custom routes."""

import secrets

from langgraph_sdk import Auth

from practiq_ai.config import service_token

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
    return {"identity": "practiq-java"}
