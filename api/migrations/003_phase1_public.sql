-- Phase 1 public tracking: postcode for lookup + sealed token for CS/email links.
-- Raw token is never stored plaintext; public_token_sealed is AES-GCM ciphertext.
-- Lookup by /t/:token still uses sha256(token) → public_token_hash.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS destination_postcode text;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS public_token_sealed text;

CREATE INDEX IF NOT EXISTS orders_postcode_idx
  ON orders (destination_postcode)
  WHERE destination_postcode IS NOT NULL;
