-- Sync run detail lines for admin Sync runs UI
CREATE TABLE ingestion_run_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  order_number text,
  order_id uuid REFERENCES orders (id) ON DELETE SET NULL,
  shipment_id uuid REFERENCES shipments (id) ON DELETE SET NULL,
  tracking_number text,
  external_id text,
  action text NOT NULL
    CHECK (action IN ('created', 'updated', 'unchanged', 'skipped', 'error')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingestion_run_items_run_idx ON ingestion_run_items (run_id);
CREATE INDEX ingestion_run_items_run_action_idx ON ingestion_run_items (run_id, action);
CREATE INDEX ingestion_run_items_order_number_idx ON ingestion_run_items (order_number)
  WHERE order_number IS NOT NULL;
