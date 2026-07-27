-- Warehouse / alternate SKUs → catalog products.sku
CREATE TABLE product_sku_aliases (
  alias_sku text PRIMARY KEY,
  product_sku text NOT NULL REFERENCES products (sku) ON DELETE CASCADE
);

CREATE INDEX product_sku_aliases_product_idx ON product_sku_aliases (product_sku);
