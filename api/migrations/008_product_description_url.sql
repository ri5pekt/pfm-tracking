-- Product copy + PDP URLs for Klaviyo / email item payloads
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS product_url text;
