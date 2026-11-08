"""Schema eight: immutable purchased grants and per-call page allocations."""
BILLING_DDL = """
UPDATE auth_settings SET value=jsonb_set(value,'{activeTasks}','1') WHERE value->>'activeTasks'='2';
ALTER TABLE payment_orders ADD COLUMN product jsonb;
ALTER TABLE payment_orders ADD COLUMN provider_closed boolean NOT NULL DEFAULT false;
CREATE TABLE page_grants (
 order_id text PRIMARY KEY REFERENCES payment_orders(id),
 owner_id text NOT NULL REFERENCES auth_users(id), product jsonb NOT NULL,
 starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','refund_pending','refunded'))
);
CREATE INDEX page_grants_owner ON page_grants(owner_id,expires_at);
CREATE TABLE page_allocations (
 call_key text NOT NULL REFERENCES auth_calls(call_key) ON DELETE CASCADE,
 order_id text NOT NULL REFERENCES page_grants(order_id), pages integer NOT NULL CHECK(pages>0),
 PRIMARY KEY(call_key,order_id)
);
"""
BILLING_TABLES = {'page_grants', 'page_allocations'}
