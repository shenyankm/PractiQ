"""Static migration boundary check; relational validation runs in backend-test."""
from pathlib import Path
import re
schema = Path(__file__).with_name("00_schema.sql").read_text()
for obsolete in ("users", "auth_sessions", "payment_orders", "credit_accounts", "study_groups"):
    assert not re.search(rf"CREATE TABLE\s+{obsolete}\b", schema, re.I), obsolete
assert "request_idempotency" in schema and "worker_lease_until" in schema
assert "owner_user_id" not in schema and "user_id" not in schema
assert "DROP TABLE" not in schema.upper()
print("Single-user fresh-schema boundary: OK")
