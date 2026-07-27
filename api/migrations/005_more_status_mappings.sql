-- Cover common TrackingMore checkpoint codes seen in live KLB polls.
-- Base raw_status rows already exist; these document frequent substatus codes.

INSERT INTO status_mappings (source, raw_status, raw_substatus_code, internal_status, status_rank, notes) VALUES
  ('trackingmore', 'transit', 'transit001', 'IN_TRANSIT', 40, 'TM transit001'),
  ('trackingmore', 'transit', 'transit002', 'IN_TRANSIT', 40, 'TM transit002'),
  ('trackingmore', 'transit', 'transit003', 'IN_TRANSIT', 40, 'TM transit003'),
  ('trackingmore', 'transit', 'transit004', 'IN_TRANSIT', 40, 'TM transit004'),
  ('trackingmore', 'inforeceived', NULL, 'LABEL_CREATED', 30, 'TM inforeceived (lowercase)'),
  ('trackingmore', 'inforeceived', 'inforeceived001', 'LABEL_CREATED', 30, 'TM inforeceived001'),
  ('trackingmore', 'delivered', 'delivered001', 'DELIVERED', 90, 'TM delivered001'),
  ('trackingmore', 'pickup', 'pickup001', 'OUT_FOR_DELIVERY', 50, 'TM pickup001'),
  ('trackingmore', 'pickup', 'pickup002', 'OUT_FOR_DELIVERY', 50, 'TM pickup002'),
  ('trackingmore', 'undelivered', 'undelivered004', 'EXCEPTION', 55, 'TM undelivered004'),
  ('shipbob', 'AvailableForPickup', 'AvailableForPickup_001', 'OUT_FOR_DELIVERY', 50, 'Available for pickup'),
  ('shipbob', 'InTransit', 'InTransit_012', 'IN_TRANSIT', 40, 'Delay in transit'),
  ('shipbob', 'Delivered', 'Delivered_002', 'DELIVERED', 90, 'Picked up at post office');
