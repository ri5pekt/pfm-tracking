-- TM tags DHL "en route to distribution center" as inforeceived001.
-- DHL (and Narvar) treat that scan as En Route / In Transit.
UPDATE tracking_events
SET internal_status = 'IN_TRANSIT', status_rank = 40
WHERE source = 'trackingmore'
  AND lower(coalesce(raw_status, '')) IN ('inforeceived', 'pending')
  AND description ILIKE '%en route to dhl%';

UPDATE shipments s
SET
  internal_status = x.internal_status,
  status_rank = x.status_rank,
  status_source_event_id = x.id,
  last_event_at = x.occurred_at,
  updated_at = now()
FROM (
  SELECT DISTINCT ON (te.shipment_id)
    te.shipment_id,
    te.id,
    te.internal_status,
    te.status_rank,
    te.occurred_at
  FROM tracking_events te
  WHERE te.shipment_id IS NOT NULL
  ORDER BY te.shipment_id, te.occurred_at DESC, te.status_rank DESC, te.id DESC
) x
WHERE s.id = x.shipment_id
  AND s.internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER')
  AND s.id IN (
    SELECT te.shipment_id
    FROM tracking_events te
    WHERE te.source = 'trackingmore'
      AND te.internal_status = 'IN_TRANSIT'
      AND te.description ILIKE '%en route to dhl%'
  );

UPDATE orders o SET
  current_status = s.internal_status,
  updated_at = now()
FROM (
  SELECT DISTINCT ON (order_id)
    order_id,
    internal_status
  FROM shipments
  ORDER BY order_id, status_rank DESC, updated_at DESC
) s
WHERE o.id = s.order_id
  AND o.id IN (
    SELECT s2.order_id
    FROM shipments s2
    JOIN tracking_events te ON te.shipment_id = s2.id
    WHERE te.source = 'trackingmore'
      AND te.internal_status = 'IN_TRANSIT'
      AND te.description ILIKE '%en route to dhl%'
  );
