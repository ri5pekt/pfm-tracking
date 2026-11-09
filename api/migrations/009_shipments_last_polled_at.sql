-- Fixes TrackingMore poll starvation: the poll's old ORDER BY (event_count, last_event_at,
-- updated_at) has no stable final tiebreaker, so ties (common — many KLB shipments share the
-- same label-creation day) can leave a specific row permanently out of the LIMIT-N slice across
-- cycles. last_polled_at gives every open shipment a true least-recently-checked round robin.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;

-- Backfill existing TrackingMore-aggregated shipments so the new ordering starts from "now"
-- instead of flooding the round robin (and the new ops staleness alert) with historical NULLs.
UPDATE shipments SET last_polled_at = now()
WHERE aggregator = 'trackingmore' AND last_polled_at IS NULL;

CREATE INDEX IF NOT EXISTS shipments_tm_poll_order_idx
  ON shipments (last_polled_at ASC NULLS FIRST, id ASC)
  WHERE aggregator = 'trackingmore'
    AND tracking_number IS NOT NULL
    AND internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER');
