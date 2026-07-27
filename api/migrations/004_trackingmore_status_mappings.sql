-- Phase 2: TrackingMore status_mappings (config, not only code fallbacks)

INSERT INTO status_mappings (source, raw_status, raw_substatus_code, internal_status, status_rank, notes) VALUES
  ('trackingmore', 'pending', NULL, 'LABEL_CREATED', 30, 'TM pending / info received'),
  ('trackingmore', 'notfound', NULL, 'LABEL_CREATED', 30, 'TM not found yet'),
  ('trackingmore', 'transit', NULL, 'IN_TRANSIT', 40, 'TM in transit'),
  ('trackingmore', 'pickup', NULL, 'OUT_FOR_DELIVERY', 50, 'TM out for delivery / pickup'),
  ('trackingmore', 'delivered', NULL, 'DELIVERED', 90, 'TM delivered'),
  ('trackingmore', 'undelivered', NULL, 'EXCEPTION', 55, 'TM undelivered / attempt failed class'),
  ('trackingmore', 'exception', NULL, 'EXCEPTION', 55, 'TM exception'),
  ('trackingmore', 'expired', NULL, 'EXCEPTION', 55, 'TM expired — often needs retrack'),
  ('trackingmore', 'InfoReceived', NULL, 'LABEL_CREATED', 30, 'TM checkpoint InfoReceived'),
  ('trackingmore', 'InTransit', NULL, 'IN_TRANSIT', 40, 'TM checkpoint InTransit'),
  ('trackingmore', 'OutForDelivery', NULL, 'OUT_FOR_DELIVERY', 50, 'TM checkpoint OutForDelivery'),
  ('trackingmore', 'Delivered', NULL, 'DELIVERED', 90, 'TM checkpoint Delivered'),
  ('trackingmore', 'Exception', NULL, 'EXCEPTION', 55, 'TM checkpoint Exception'),
  ('trackingmore', 'AttemptFail', NULL, 'EXCEPTION', 55, 'TM delivery attempt failed'),
  ('trackingmore', 'DeliveryFailure', NULL, 'EXCEPTION', 55, 'TM delivery failure');
