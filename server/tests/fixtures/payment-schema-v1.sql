
CREATE TABLE payment_schema (
 version integer PRIMARY KEY CHECK(version=1), identity text NOT NULL
);
CREATE TABLE payment_products (
 product_id text PRIMARY KEY REFERENCES import_products(product_id),
 price_cents bigint NOT NULL CHECK(price_cents BETWEEN 1 AND 10000000000),
 enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE payment_orders (
 order_id text PRIMARY KEY, access_digest text UNIQUE NOT NULL,
 product_id text NOT NULL REFERENCES import_products(product_id), name text NOT NULL,
 price_cents bigint NOT NULL CHECK(price_cents BETWEEN 1 AND 10000000000),
 points bigint NOT NULL CHECK(points>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','fulfilled','closed')),
 trade_no text UNIQUE, card_digest text UNIQUE REFERENCES import_cards(digest),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 paid_at timestamptz, fulfilled_at timestamptz, next_query_at timestamptz,
 CHECK((status IN ('paid','fulfilled'))=(paid_at IS NOT NULL)),
 CHECK((status='fulfilled')=(card_digest IS NOT NULL AND fulfilled_at IS NOT NULL))
);
CREATE INDEX payment_order_time ON payment_orders(created_at);
CREATE INDEX payment_unfulfilled ON payment_orders(created_at) WHERE status='paid';
