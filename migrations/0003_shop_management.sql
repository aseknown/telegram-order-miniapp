CREATE TABLE platform_admins (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  product_limit INTEGER NOT NULL CHECK(product_limit BETWEEN 1 AND 100000),
  monthly_price_minor INTEGER CHECK(monthly_price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0,
  CHECK(id <> 'free' OR (product_limit=10 AND monthly_price_minor=0 AND published=1))
);
INSERT INTO plans (id,name,product_limit,monthly_price_minor,currency,published) VALUES
  ('free','Free',10,0,'USD',1), ('pro','Pro',100,NULL,'USD',0);
ALTER TABLE shops ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','SUSPENDED'));
ALTER TABLE shops ADD COLUMN approval_note TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
-- SQLite cannot add a non-null REFERENCES default to a populated table.
ALTER TABLE shops ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free';
ALTER TABLE shops ADD COLUMN plan_expires_at INTEGER;
CREATE TRIGGER shops_plan_insert BEFORE INSERT ON shops
WHEN NOT EXISTS (SELECT 1 FROM plans WHERE id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'INVALID_PLAN'); END;
CREATE TRIGGER shops_plan_update BEFORE UPDATE OF plan_id ON shops
WHEN NOT EXISTS (SELECT 1 FROM plans WHERE id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'INVALID_PLAN'); END;
CREATE TRIGGER plans_in_use BEFORE DELETE ON plans
WHEN OLD.id='free' OR EXISTS (SELECT 1 FROM shops WHERE plan_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'PLAN_IN_USE'); END;
CREATE INDEX shops_review ON shops(status,created_at);
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  UNIQUE(shop_id,name),
  UNIQUE(shop_id,id)
);
ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES categories(id);
ALTER TABLE products ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
CREATE INDEX products_category ON products(shop_id,category_id,archived);
CREATE VIEW shop_entitlements AS
SELECT s.id AS shop_id,
  CASE WHEN s.plan_id<>'free' AND s.plan_expires_at>CAST(strftime('%s','now') AS INTEGER) THEN s.plan_id ELSE 'free' END AS effective_plan_id,
  CASE WHEN s.plan_id<>'free' AND s.plan_expires_at>CAST(strftime('%s','now') AS INTEGER) THEN p.product_limit ELSE 10 END AS product_limit
FROM shops s JOIN plans p ON p.id=s.plan_id;
-- Include hidden products in the quota; archiving releases a slot without erasing history.
CREATE TRIGGER products_plan_insert BEFORE INSERT ON products
WHEN NEW.archived=0 AND NOT EXISTS (
  SELECT 1 FROM products WHERE id=NEW.id OR (shop_id=NEW.shop_id AND source_id=NEW.source_id)
) AND (SELECT count(*) FROM products WHERE shop_id=NEW.shop_id AND archived=0) >=
  (SELECT product_limit FROM shop_entitlements WHERE shop_id=NEW.shop_id)
BEGIN SELECT RAISE(ABORT,'PRODUCT_LIMIT'); END;
CREATE TRIGGER products_plan_restore BEFORE UPDATE OF archived,shop_id ON products
WHEN NEW.archived=0 AND (OLD.archived=1 OR NEW.shop_id<>OLD.shop_id)
AND (SELECT count(*) FROM products WHERE shop_id=NEW.shop_id AND archived=0 AND id<>OLD.id) >=
  (SELECT product_limit FROM shop_entitlements WHERE shop_id=NEW.shop_id)
BEGIN SELECT RAISE(ABORT,'PRODUCT_LIMIT'); END;
CREATE TRIGGER products_category_insert BEFORE INSERT ON products
WHEN NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id=NEW.category_id AND shop_id=NEW.shop_id)
BEGIN SELECT RAISE(ABORT,'CATEGORY_SCOPE'); END;
CREATE TRIGGER products_category_update BEFORE UPDATE OF category_id,shop_id ON products
WHEN NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id=NEW.category_id AND shop_id=NEW.shop_id)
BEGIN SELECT RAISE(ABORT,'CATEGORY_SCOPE'); END;
-- A downgrade keeps data but limits the catalog to the oldest retained product slots.
CREATE VIEW available_products AS
SELECT ranked.* FROM (
  SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.shop_id ORDER BY p.rowid) AS slot
  FROM products p WHERE p.archived=0
) ranked JOIN shop_entitlements e ON e.shop_id=ranked.shop_id
JOIN shops s ON s.id=ranked.shop_id
WHERE ranked.slot<=e.product_limit AND ranked.active=1 AND s.status='APPROVED';
CREATE TRIGGER orders_shop_gate BEFORE INSERT ON marketplace_orders
WHEN NOT EXISTS (SELECT 1 FROM available_products WHERE id=NEW.product_id AND shop_id=NEW.shop_id)
BEGIN SELECT RAISE(ABORT,'SHOP_UNAVAILABLE'); END;
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES customers(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_entity ON audit_events(entity_type,entity_id,created_at);
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES customers(id),
  shop_id TEXT REFERENCES shops(id),
  order_id TEXT REFERENCES marketplace_orders(id),
  audience TEXT NOT NULL CHECK(audience IN ('SHOP','PLATFORM')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','WAITING','RESOLVED')),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX support_requester ON support_tickets(requester_id,updated_at);
CREATE INDEX support_shop ON support_tickets(shop_id,updated_at);
CREATE INDEX support_queue ON support_tickets(status,updated_at);
CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT NOT NULL REFERENCES customers(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL
);
CREATE INDEX support_messages_ticket ON support_messages(ticket_id,created_at);
