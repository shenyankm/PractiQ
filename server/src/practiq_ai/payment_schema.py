"""Schema seven: independent payment evidence, without changing page allowances."""
PAYMENT_DDL = """
CREATE TABLE payment_orders (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES auth_users(id),
 request_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 app_id text NOT NULL, seller_id text NOT NULL, amount bigint NOT NULL CHECK(amount>0),
 paid_amount bigint CHECK(paid_amount>=0 AND paid_amount<=amount),
 subject text NOT NULL, return_url text NOT NULL,
 state text NOT NULL DEFAULT 'UNKNOWN' CHECK(state IN ('UNKNOWN','PENDING_PAYMENT','PAID','CLOSED')),
 trade_no text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 next_check timestamptz NOT NULL DEFAULT now(), checks integer NOT NULL DEFAULT 0,
 UNIQUE(owner_id,request_id)
);
CREATE INDEX payment_orders_due ON payment_orders(next_check) WHERE state IN ('UNKNOWN','PENDING_PAYMENT');
CREATE TABLE payment_refunds (
 id text PRIMARY KEY, order_id text NOT NULL REFERENCES payment_orders(id),
 amount bigint NOT NULL CHECK(amount>0), reason text NOT NULL,
 state text NOT NULL DEFAULT 'UNKNOWN' CHECK(state IN ('UNKNOWN','SUCCESS')),
 created_at timestamptz NOT NULL DEFAULT now(), next_check timestamptz NOT NULL DEFAULT now()+interval '10 seconds'
);
CREATE TABLE payment_notifications (
 app_id text NOT NULL, notify_id text NOT NULL, order_id text NOT NULL REFERENCES payment_orders(id),
 trade_no text NOT NULL, event_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(app_id,notify_id)
);
"""
PAYMENT_TABLES = {'payment_orders', 'payment_refunds', 'payment_notifications'}
