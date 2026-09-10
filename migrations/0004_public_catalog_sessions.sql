ALTER TABLE products ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1));
ALTER TABLE products ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER product_created_at AFTER INSERT ON products WHEN NEW.created_at=0
BEGIN UPDATE products SET created_at=CAST(strftime('%s','now') AS INTEGER) WHERE id=NEW.id; END;
CREATE INDEX products_public ON products(is_public,shop_id,archived,active);
-- SQLite expands SELECT * in views at query time; recreate explicitly for the new column.
DROP VIEW available_products;
CREATE VIEW available_products AS
SELECT ranked.* FROM (
  SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.shop_id ORDER BY p.rowid) AS slot
  FROM products p WHERE p.archived=0
) ranked JOIN shop_entitlements e ON e.shop_id=ranked.shop_id
JOIN shops s ON s.id=ranked.shop_id
WHERE ranked.slot<=e.product_limit AND ranked.active=1 AND s.status='APPROVED';
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  proof_hash TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX auth_sessions_customer ON auth_sessions(customer_id,created_at);
CREATE TRIGGER protect_last_admin BEFORE DELETE ON platform_admins
WHEN (SELECT count(*) FROM platform_admins)=1
BEGIN SELECT RAISE(ABORT,'LAST_ADMIN'); END;
