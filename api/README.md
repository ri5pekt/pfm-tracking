# API service

HTTP API: public tracking + lookup (Phase 1), admin auth (Phase 0), RichPanel (Phase 3).

## Scripts

```bash
npm run dev -w api      # tsx watch
npm run migrate -w api  # apply SQL migrations
npm run test -w api
```

## Admin auth (Phase 0)

- `POST /admin/auth/login` — email + password, httpOnly session cookie
- `POST /admin/auth/logout`
- `GET /admin/auth/me`
- `POST /admin/invites` — admin-only; returns one-time accept token
- `POST /admin/invites/accept`
- `GET /admin/users` — admin-only
- `GET /admin/version` — `APP_VERSION` + `GIT_SHA`
- `GET /admin/shipments` — empty list stub

Bootstrap first admin via `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` when the users table is empty.
