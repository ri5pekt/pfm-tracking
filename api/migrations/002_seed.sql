-- Carriers from live Tracking API mix (§13) + status_mappings seed

INSERT INTO carriers (code, display_name, shipbob_aliases, trackingmore_code) VALUES
  ('amazon_shipping', 'Amazon Shipping', ARRAY['Amazon Shipping', 'AmazonShipping', 'amazon shipping'], NULL),
  ('speedx', 'SpeedX', ARRAY['SpeedX', 'speedx', 'Speed X'], NULL),
  ('uniuni', 'UniUni', ARRAY['UniUni', 'uniuni', 'Uni Uni'], 'uniuni'),
  ('osm_worldwide', 'OSM Worldwide', ARRAY['OSMWorldwide', 'OSM Worldwide', 'osmworldwide'], NULL),
  ('cirro', 'Cirro', ARRAY['Cirro', 'cirro'], NULL),
  ('usps', 'USPS', ARRAY['USPS', 'usps', 'Stamps', 'Stamps.com'], 'usps'),
  ('ontrac', 'OnTrac', ARRAY['OnTrac', 'ontrac', 'On Trac'], 'ontrac'),
  ('better_trucks', 'Better Trucks', ARRAY['BetterTrucks', 'Better Trucks'], NULL),
  ('fedex', 'FedEx', ARRAY['FedEx', 'fedex'], 'fedex'),
  ('dhl_ecs', 'DHL eCommerce', ARRAY['DhlEcs', 'DHL eCommerce', 'DHLEcommerce', 'dhlecs'], 'dhlglobalmail'),
  ('ups', 'UPS', ARRAY['UPS', 'ups'], 'ups'),
  ('shipbob_freight', 'ShipBob Freight', ARRAY['ShipBob Freight', 'ShipBobFreight'], NULL)
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
