-- Carriers from live Tracking API mix (§13) + status_mappings seed

INSERT INTO carriers (code, display_name, shipbob_aliases, trackingmore_code, tracking_url_template) VALUES
  ('amazon_shipping', 'Amazon Shipping', ARRAY['Amazon Shipping', 'AmazonShipping', 'amazon shipping'], NULL, NULL),
  ('speedx', 'SpeedX', ARRAY['SpeedX', 'speedx', 'Speed X'], NULL, NULL),
  ('uniuni', 'UniUni', ARRAY['UniUni', 'uniuni', 'Uni Uni'], 'uniuni', NULL),
  ('osm_worldwide', 'OSM Worldwide', ARRAY['OSMWorldwide', 'OSM Worldwide', 'osmworldwide'], NULL, NULL),
  ('cirro', 'Cirro', ARRAY['Cirro', 'cirro'], NULL, NULL),
  ('usps', 'USPS', ARRAY['USPS', 'usps', 'Stamps', 'Stamps.com'], 'usps', 'https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking_number}'),
  ('ontrac', 'OnTrac', ARRAY['OnTrac', 'ontrac', 'On Trac'], 'ontrac', 'https://www.ontrac.com/tracking/?number={tracking_number}'),
  ('better_trucks', 'Better Trucks', ARRAY['BetterTrucks', 'Better Trucks'], NULL, NULL),
  ('fedex', 'FedEx', ARRAY['FedEx', 'fedex'], 'fedex', 'https://www.fedex.com/fedextrack/?trknbr={tracking_number}'),
  ('dhl_ecs', 'DHL eCommerce', ARRAY['DhlEcs', 'DHL eCommerce', 'DHLEcommerce', 'dhlecs'], 'dhlglobalmail', 'https://webtrack.dhlglobalmail.com/?trackingnumber={tracking_number}'),
  ('ups', 'UPS', ARRAY['UPS', 'ups'], 'ups', 'https://www.ups.com/track?tracknum={tracking_number}'),
  ('shipbob_freight', 'ShipBob Freight', ARRAY['ShipBob Freight', 'ShipBobFreight'], NULL, NULL)
ON CONFLICT (code) DO NOTHING;

-- Base status mappings (raw_status → internal). Substatus-specific rows can be added later.
INSERT INTO status_mappings (source, raw_status, raw_substatus_code, internal_status, status_rank, notes) VALUES
  ('shipbob', 'PreTransit', NULL, 'LABEL_CREATED', 30, 'Tracking API PreTransit'),
  ('shipbob', 'InTransit', NULL, 'IN_TRANSIT', 40, 'Tracking API InTransit'),
  ('shipbob', 'OutForDelivery', NULL, 'OUT_FOR_DELIVERY', 50, 'Tracking API OutForDelivery'),
  ('shipbob', 'AvailableForPickup', NULL, 'OUT_FOR_DELIVERY', 50, 'Treated as out-for-delivery class'),
  ('shipbob', 'DeliveryAttemptFailed', NULL, 'EXCEPTION', 55, 'Failed attempt — distinct Klaviyo branch'),
  ('shipbob', 'DeliveryException', NULL, 'EXCEPTION', 55, 'Delivery exception — distinct Klaviyo branch'),
  ('shipbob', 'Exception', NULL, 'EXCEPTION', 55, 'Generic exception'),
  ('shipbob', 'Delivered', NULL, 'DELIVERED', 90, 'Tracking API Delivered'),
  -- Common substatus codes from §13 (same internal mapping; notes for admin)
  ('shipbob', 'InTransit', 'InTransit_001', 'IN_TRANSIT', 40, 'In Transit'),
  ('shipbob', 'InTransit', 'InTransit_002', 'IN_TRANSIT', 40, 'Arrival scan'),
  ('shipbob', 'InTransit', 'InTransit_004', 'IN_TRANSIT', 40, 'Departure Scan'),
  ('shipbob', 'InTransit', 'InTransit_017', 'IN_TRANSIT', 40, 'Carrier Picked up'),
  ('shipbob', 'PreTransit', 'PreTransit_005', 'LABEL_CREATED', 30, 'Info Received'),
  ('shipbob', 'OutForDelivery', 'OutForDelivery_001', 'OUT_FOR_DELIVERY', 50, 'Out for delivery'),
  ('shipbob', 'Delivered', 'Delivered_001', 'DELIVERED', 90, 'Delivered'),
  ('shipbob', 'DeliveryAttemptFailed', 'DeliveryAttemptFailed_001', 'EXCEPTION', 55, 'Delivery attempt failed'),
  ('shipbob', 'DeliveryException', 'DeliveryException_001', 'EXCEPTION', 55, 'Incomplete/incorrect address'),
  ('shipbob', 'Exception', 'Exception_005', 'EXCEPTION', 55, 'Shipping Exception — no access'),
  ('system', 'ORDER_RECEIVED', NULL, 'ORDER_RECEIVED', 10, 'Order created at source'),
  ('system', 'PROCESSING', NULL, 'PROCESSING', 20, 'Preparing / no tracking yet'),
  ('system', 'CANCELLED', NULL, 'CANCELLED', 90, 'Source cancellation'),
  ('system', 'RETURNED_TO_SENDER', NULL, 'RETURNED_TO_SENDER', 90, 'Return to sender')
ON CONFLICT DO NOTHING;
