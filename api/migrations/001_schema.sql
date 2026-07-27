-- Phase 0 schema per docs/dev-plan.md §3.2

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE carriers (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  tracking_url_template text,
  shipbob_aliases text[] NOT NULL DEFAULT '{}',
  trackingmore_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  sku text PRIMARY KEY,
  title text NOT NULL,
  image_url text,
  source text NOT NULL DEFAULT 'manual',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  customer_email text,
  customer_name text,
  customer_phone text,
  destination_city text,
  destination_country text,
  public_token_hash text NOT NULL UNIQUE,
  ordered_at timestamptz,
  current_status text NOT NULL DEFAULT 'ORDER_RECEIVED',
  anonymised_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  source text NOT NULL CHECK (source IN ('shipbob', 'klb')),
  source_shipment_id text NOT NULL,
  source_order_id text,
  carrier_code text REFERENCES carriers (code),
  carrier_service text,
  tracking_number text,
  carrier_tracking_url text,
  internal_status text NOT NULL DEFAULT 'PROCESSING',
  status_rank integer NOT NULL DEFAULT 20,
  status_source_event_id bigint,
  is_stalled boolean NOT NULL DEFAULT false,
  stalled_since timestamptz,
  aggregator text NOT NULL DEFAULT 'none' CHECK (aggregator IN ('none', 'trackingmore')),
  aggregator_id text,
  edd timestamptz,
  edd_source text CHECK (edd_source IS NULL OR edd_source IN ('carrier', 'shipbob')),
  last_mile_carrier jsonb,
  delivery_signed_by text,
  proof_of_delivery_urls text[] NOT NULL DEFAULT '{}',
  shipped_at timestamptz,
  delivered_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_shipment_id)
);

CREATE UNIQUE INDEX shipments_active_tracking_uidx
  ON shipments (carrier_code, tracking_number)
  WHERE tracking_number IS NOT NULL
    AND carrier_code IS NOT NULL
    AND internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER');

CREATE INDEX shipments_open_poll_idx
  ON shipments (source, source_shipment_id)
  WHERE internal_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED_TO_SENDER');

CREATE INDEX shipments_order_id_idx ON shipments (order_id);

CREATE TABLE shipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments (id) ON DELETE CASCADE,
  sku text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  title text,
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shipment_items_shipment_id_idx ON shipment_items (shipment_id);

CREATE TABLE tracking_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders (id),
  shipment_id uuid REFERENCES shipments (id),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  internal_status text NOT NULL,
  status_rank integer NOT NULL,
  source text NOT NULL CHECK (source IN ('shipbob', 'trackingmore', 'system')),
  raw_status text,
  raw_substatus_code text,
  raw_substatus text,
  description text,
  location text,
  latitude double precision,
  longitude double precision,
  raw_payload jsonb,
  event_hash text NOT NULL UNIQUE
);

CREATE INDEX tracking_events_shipment_derive_idx
  ON tracking_events (shipment_id, occurred_at DESC, status_rank DESC, id DESC);

CREATE INDEX tracking_events_order_id_idx ON tracking_events (order_id);

ALTER TABLE shipments
  ADD CONSTRAINT shipments_status_source_event_fk
  FOREIGN KEY (status_source_event_id) REFERENCES tracking_events (id);

CREATE TABLE status_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('shipbob', 'trackingmore', 'system')),
  raw_status text NOT NULL,
  raw_substatus_code text,
  internal_status text NOT NULL,
  status_rank integer NOT NULL,
  notes text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX status_mappings_lookup_uidx
  ON status_mappings (source, raw_status, COALESCE(raw_substatus_code, ''));

CREATE TABLE notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  shipment_id uuid REFERENCES shipments (id),
  event_type text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  payload jsonb,
  replayed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text,
  role text NOT NULL CHECK (role IN ('admin', 'staff')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled')),
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'staff')),
  purpose text NOT NULL CHECK (purpose IN ('invite', 'password_reset')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES admin_users (id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES admin_users (id),
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_erasure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_email text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid REFERENCES admin_users (id),
  completed_at timestamptz,
  orders_affected integer,
  events_scrubbed integer
);

CREATE TABLE sync_cursors (
  job_name text PRIMARY KEY,
  cursor_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'failed')),
  records_seen integer NOT NULL DEFAULT 0,
  records_upserted integer NOT NULL DEFAULT 0,
  events_appended integer NOT NULL DEFAULT 0,
  errors jsonb,
  cursor_before timestamptz,
  cursor_after timestamptz
);

CREATE INDEX ingestion_runs_job_started_idx ON ingestion_runs (job_name, started_at DESC);

CREATE TABLE api_call_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  integration text NOT NULL,
  operation text NOT NULL,
  http_method text NOT NULL,
  url text NOT NULL,
  response_status integer,
  duration_ms integer,
  error_message text,
  shipment_id uuid,
  request_body jsonb,
  response_body jsonb
);

CREATE INDEX api_call_log_occurred_at_idx ON api_call_log (occurred_at DESC);
CREATE INDEX api_call_log_shipment_id_idx ON api_call_log (shipment_id)
  WHERE shipment_id IS NOT NULL;

ALTER TABLE status_mappings
  ADD CONSTRAINT status_mappings_updated_by_fk
  FOREIGN KEY (updated_by) REFERENCES admin_users (id);

ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_replayed_by_fk
  FOREIGN KEY (replayed_by) REFERENCES admin_users (id);
