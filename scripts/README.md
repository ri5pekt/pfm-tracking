# Scripts

## `seed-sample-orders.ts`

Loads **50 ShipBob + 50 KLB** orders (≥14 days old) with carrier timelines
(ShipBob Tracking API + TrackingMore for KLB).

```bash
npm run seed:samples
```

Requires `.env` keys: `SHIPBOB_API_KEY`, `SHIPBOB_CHANNEL_ID`, `KLB_LEGACY_API_SECRET`,
`TRACKINGMORE_API_KEY`, `DATABASE_URL`.

## `sync-trackingmore.ts`

Re-polls TrackingMore for KLB shipments that were registered but still lack
carrier checkpoints (common for the first minutes/hours after create).

```bash
npm run sync:trackingmore
```

The worker also runs `trackingmore.poll` every 15 minutes automatically.
