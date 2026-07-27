# Customer tracking page

Served by the API in v1:

- `GET /t/:token` — branded HTML (DB only) or JSON with `Accept: application/json`
- `GET /lookup` — lost-link form
- `POST /lookup` — order number + email **or** postcode → `{ trackingUrl, order }`

See `docs/dev-plan.md` §6–§7 and `api/src/public/tracking-page.html`.
