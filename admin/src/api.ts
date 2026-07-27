export type AdminUser = {
  id: string;
  email: string;
  role: 'admin' | 'staff';
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

export function fetchShipments() {
  return request<{
    items: unknown[];
    counts: Record<string, number>;
  }>('/admin/shipments');
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
