-- GOFO (formerly Cirro) — ShipBob sends tracking.carrier = 'GOFO' since Sep 2026.
INSERT INTO carriers (code, display_name, shipbob_aliases, trackingmore_code, tracking_url_template)
VALUES (
  'gofo',
  'GOFO',
  ARRAY['GOFO', 'gofo', 'GOFO Express', 'GOFO Parcel Pickup'],
  NULL,
  'https://www.gofo.com/us/track?searchID={tracking_number}'
)
ON CONFLICT (code) DO NOTHING;

UPDATE shipments
SET carrier_code = 'gofo'
WHERE carrier_code IS NULL
  AND (
    last_mile_carrier->>'carrier' ILIKE 'gofo%'
    OR carrier_service ILIKE 'gofo%'
  );
