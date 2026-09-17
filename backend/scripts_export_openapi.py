"""Export the public input contract without connecting to PostgreSQL."""
import json
from pathlib import Path
from practiq_backend.app import app

if __name__ == "__main__":
    Path(__file__).resolve().parents[1].joinpath("docs/openapi.json").write_text(
        json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n"
    )
