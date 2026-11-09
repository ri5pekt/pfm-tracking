-- Public "Track with carrier" link: KLB/TrackingMore rows have no carrier_tracking_url
-- (ShipBob fills it from their API). Templates make the tracking number clickable.
UPDATE carriers SET tracking_url_template = 'https://webtrack.dhlglobalmail.com/?trackingnumber={tracking_number}'
WHERE code = 'dhl_ecs' AND tracking_url_template IS NULL;

UPDATE carriers SET tracking_url_template = 'https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking_number}'
WHERE code = 'usps' AND tracking_url_template IS NULL;

UPDATE carriers SET tracking_url_template = 'https://www.ups.com/track?tracknum={tracking_number}'
WHERE code = 'ups' AND tracking_url_template IS NULL;

UPDATE carriers SET tracking_url_template = 'https://www.fedex.com/fedextrack/?trknbr={tracking_number}'
WHERE code = 'fedex' AND tracking_url_template IS NULL;

UPDATE carriers SET tracking_url_template = 'https://www.ontrac.com/tracking/?number={tracking_number}'
WHERE code = 'ontrac' AND tracking_url_template IS NULL;
