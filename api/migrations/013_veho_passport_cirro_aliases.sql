-- ShipBob carrier names that matched nothing: Cirro arrives as "CirroECommerce",
-- Veho and Passport were missing entirely.
UPDATE carriers
SET shipbob_aliases = shipbob_aliases || ARRAY['CirroECommerce', 'Cirro ECommerce', 'Cirro eCommerce']
WHERE code = 'cirro' AND NOT ('CirroECommerce' = ANY (shipbob_aliases));

UPDATE carriers
SET tracking_url_template = 'https://www.cirrotrack.com/parcelTracking?id={tracking_number}'
WHERE code = 'cirro' AND tracking_url_template IS NULL;

INSERT INTO carriers (code, display_name, shipbob_aliases, trackingmore_code, tracking_url_template)
VALUES
  ('veho', 'Veho', ARRAY['Veho', 'veho', 'ShipVeho'], NULL,
   'https://track.shipveho.com/#/trackingId/{tracking_number}'),
  ('passport', 'Passport', ARRAY['Passport', 'passport', 'PassportShipping', 'Passport Shipping'], NULL,
   'https://track.passportshipping.com/{tracking_number}')
ON CONFLICT (code) DO NOTHING;

UPDATE shipments SET carrier_code = 'cirro'
WHERE carrier_code IS NULL
  AND (carrier_tracking_url ILIKE '%cirrotrack.com%' OR last_mile_carrier->>'carrier' ILIKE 'cirro%');

UPDATE shipments SET carrier_code = 'veho'
WHERE carrier_code IS NULL
  AND (carrier_tracking_url ILIKE '%shipveho.com%' OR last_mile_carrier->>'carrier' ILIKE 'veho');

UPDATE shipments SET carrier_code = 'passport'
WHERE carrier_code IS NULL
  AND (carrier_tracking_url ILIKE '%passportshipping.com%' OR last_mile_carrier->>'carrier' ILIKE 'passport%');
