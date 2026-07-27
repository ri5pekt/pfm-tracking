export type AdminUser = {
  id: string;
  email: string;
  role: 'admin' | 'staff';
};

export type ShipmentListItem = {
  id: string;
  source: string;
  tracking_number: string | null;
  carrier_code: string | null;
  carrier_name: string | null;
  carrier_service: string | null;
  internal_status: string;
  is_stalled: boolean;
  order_number: string;
  customer_email: string | null;
  destination_city: string | null;
  destination_country: string | null;
  order_created_at: string | null;
  order_imported_at: string | null;
  shipment_imported_at: string | null;
  latest_event_description: string | null;
  latest_event_location: string | null;
  latest_event_at: string | null;
  last_event_at: string | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status, body });
  }
  return res.json() as Promise<T>;
}

export function login(email: string, password: string) {
  return request<{ user: AdminUser }>('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout() {
  return request<{ ok: boolean }>('/admin/auth/logout', { method: 'POST' });
}

export function fetchMe() {
  return request<{ user: AdminUser }>('/admin/auth/me');
}

export function fetchVersion() {
  return request<{ version: string; gitSha: string }>('/admin/version');
}

export function fetchShipments(params?: {
  q?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}) {
  const sp = new URLSearchParams();
  if (params?.q) sp.set('q', params.q);
  if (params?.status && params.status !== 'all') sp.set('status', params.status);
  if (params?.page) sp.set('page', String(params.page));
  if (params?.pageSize) sp.set('pageSize', String(params.pageSize));
  if (params?.sortBy) sp.set('sortBy', params.sortBy);
  if (params?.sortDir) sp.set('sortDir', params.sortDir);
  const qs = sp.toString();
  return request<{
    items: ShipmentListItem[];
    total: number;
    page: number;
    pageSize: number;
    sortBy: string;
    sortDir: string;
    counts: Record<string, number>;
  }>(`/admin/shipments${qs ? `?${qs}` : ''}`);
}

export function fetchShipmentDetail(id: string) {
  return request<{
    shipment: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    items: Array<Record<string, unknown>>;
    notifications: Array<Record<string, unknown>>;
  }>(`/admin/shipments/${id}`);
}

export function fetchTrackingLink(id: string) {
  return request<{ url: string }>(`/admin/shipments/${id}/tracking-link`);
}

export function retrackShipment(id: string) {
  return request<{
    ok: boolean;
    eventsInserted: number;
    deliveryStatus: string | null;
    checkpointCount: number;
    error?: string;
  }>(`/admin/shipments/${id}/retrack`, { method: 'POST' });
}

export function fetchDashboard() {
  return request<DashboardData>('/admin/dashboard');
}

export type DashboardData = {
  counts: Record<string, number>;
  bySource: Array<{ source: string; n: number }>;
  cursors: Array<{
    job_name: string;
    cursor_at: string | null;
    last_success_at: string | null;
    updated_at: string;
  }>;
  recentRuns: Array<{
    id: string;
    job_name: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    records_seen: number;
    records_upserted: number;
    events_appended: number;
  }>;
  notifications: Array<{ eventType: string; status: string; n: number }>;
  unmappedRecentEvents: number;
  reconcile?: {
    openWithoutTracking: number;
    openStaleNoEvents: number;
    orphanAggregatorIds: number;
    unmappedStatusPairs: number;
    findings: Array<{ kind: string; detail: string; n: number }>;
  };
  opsHealth?: {
    ok: boolean;
    checkedAt: string;
    recentFailures: number;
    alerts: string[];
    jobs: Array<{
      jobName: string;
      critical: boolean;
      status: string;
      lastSuccessAt: string | null;
      lagMs: number | null;
      lagThresholdMs: number;
    }>;
  };
};

export function fetchUnmappedStatuses() {
  return request<{
    items: Array<{
      source: string;
      raw_status: string;
      raw_substatus_code: string | null;
      n: number;
      sample_description: string | null;
    }>;
  }>('/admin/unmapped-statuses');
}

export function requestErasure(email: string) {
  return request<{
    requestId: string;
    ordersAffected: number;
    eventsScrubbed: number;
  }>('/admin/privacy/erasure', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function replayNotification(id: string) {
  return request<{ ok: boolean; status: string; error?: string }>(
    `/admin/notifications/${id}/replay`,
    { method: 'POST' },
  );
}

export function inviteUser(email: string, role: 'admin' | 'staff') {
  return request<{
    inviteId: string;
    email: string;
    role: string;
    acceptToken: string;
    acceptUrl: string;
  }>('/admin/invites', {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
}

export function acceptInvite(token: string, password: string) {
  return request<{ user: AdminUser }>('/admin/invites/accept', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

export function listUsers() {
  return request<{
    users: Array<{
      id: string;
      email: string;
      role: string;
      status: string;
      last_login_at: string | null;
      created_at: string;
    }>;
  }>('/admin/users');
}

export type StatusMapping = {
  id: string;
  source: string;
  raw_status: string;
  raw_substatus_code: string | null;
  internal_status: string;
  status_rank: number;
  notes: string | null;
  updated_at?: string;
};

export function fetchStatusMappings() {
  return request<{ items: StatusMapping[]; internalStatuses: string[] }>(
    '/admin/status-mappings',
  );
}

export function createStatusMapping(body: {
  source: 'shipbob' | 'trackingmore' | 'system';
  raw_status: string;
  raw_substatus_code?: string | null;
  internal_status: string;
  status_rank: number;
  notes?: string | null;
}) {
  return request<{ item: StatusMapping }>('/admin/status-mappings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteStatusMapping(id: string) {
  return request<{ ok: boolean }>(`/admin/status-mappings/${id}`, { method: 'DELETE' });
}

export type DeliveryReport = {
  days: number;
  summary: {
    total: number;
    delivered: number;
    exceptionRatePct: number;
    avgTransitDays: number | null;
    stalled: number;
  };
  byCarrier: Array<{
    carrier: string;
    delivered: number;
    exceptions: number;
    inFlight: number;
    avgTransitDays: number | null;
    onTime: number;
    late: number;
  }>;
  bySource: Array<{
    source: string;
    total: number;
    delivered: number;
    exceptions: number;
    stalled: number;
    avgTransitDays: number | null;
  }>;
  deliveredDaily: Array<{ day: string; n: number }>;
};

export function fetchDeliveryReport(days = 30) {
  return request<DeliveryReport>(`/admin/reports/delivery?days=${days}`);
}

export type IngestionRunListItem = {
  id: string;
  jobName: string;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  recordsSeen: number;
  recordsUpserted: number;
  eventsAppended: number;
  itemCount: number;
  durationMs: number | null;
};

export function fetchIngestionRuns(params: {
  from?: string;
  to?: string;
  source?: string;
  status?: string;
  job_name?: string;
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.source) qs.set('source', params.source);
  if (params.status) qs.set('status', params.status);
  if (params.job_name) qs.set('job_name', params.job_name);
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return request<{
    page: number;
    limit: number;
    total: number;
    from: string;
    to: string;
    items: IngestionRunListItem[];
  }>(`/admin/ingestion-runs${q ? `?${q}` : ''}`);
}

export function fetchIngestionRun(
  id: string,
  params?: { page?: number; limit?: number; action?: string; q?: string },
) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.action) qs.set('action', params.action);
  if (params?.q) qs.set('q', params.q);
  const q = qs.toString();
  return request<{
    run: IngestionRunListItem & {
      errors: unknown;
      cursorBefore: string | null;
      cursorAfter: string | null;
    };
    actionCounts: Record<string, number>;
    items: {
      page: number;
      limit: number;
      total: number;
      rows: Array<{
        id: string;
        orderNumber: string | null;
        orderId: string | null;
        shipmentId: string | null;
        trackingNumber: string | null;
        externalId: string | null;
        action: string;
        detail: string | null;
        createdAt: string;
      }>;
    };
  }>(`/admin/ingestion-runs/${id}${q ? `?${q}` : ''}`);
}
