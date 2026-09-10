-- Additive migration: legacy orders remain available to the legacy bot flow.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  telegram_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  CHECK(length(phone) BETWEEN 9 AND 16)
);
CREATE TABLE shops (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_number TEXT NOT NULL,
  payment_holder TEXT NOT NULL,
  payment_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX shops_owner ON shops(owner_id);
CREATE TRIGGER shops_owner_limit BEFORE INSERT ON shops
WHEN (SELECT count(*) FROM shops WHERE owner_id=NEW.owner_id)>=10
BEGIN SELECT RAISE(ABORT,'SHOP_LIMIT'); END;
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  source_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL CHECK(price_minor >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  source_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shop_id, source_id),
  UNIQUE(shop_id, id)
);
CREATE INDEX products_catalog ON products(shop_id, active, id);
CREATE TABLE marketplace_orders (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 20),
  unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
  currency TEXT NOT NULL,
  payment_number TEXT NOT NULL,
  payment_holder TEXT NOT NULL,
  customer_note TEXT NOT NULL DEFAULT '',
  delivery_link TEXT,
  status TEXT NOT NULL DEFAULT 'WAITING_REVIEW' CHECK(status IN ('WAITING_REVIEW','ACCEPTED','REJECTED')),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(shop_id,product_id) REFERENCES products(shop_id,id),
  UNIQUE(customer_id, request_key)
);
CREATE INDEX marketplace_orders_shop ON marketplace_orders(shop_id, created_at);
CREATE INDEX marketplace_orders_customer ON marketplace_orders(customer_id, created_at);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES marketplace_orders(id),
  mime TEXT NOT NULL,
  content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 1048576)
);
CREATE INDEX attachments_order ON attachments(order_id);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES marketplace_orders(id),
  attachment_id TEXT REFERENCES attachments(id),
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENDING','SENT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  telegram_message_id INTEGER,
  error_code TEXT
);
CREATE INDEX notifications_due ON notifications(state, next_attempt, lease_until);
CREATE TABLE shop_integrations (
  shop_id TEXT PRIMARY KEY REFERENCES shops(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES marketplace_orders(id),
  actor_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
