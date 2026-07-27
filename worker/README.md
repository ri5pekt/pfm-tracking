# Worker

BullMQ jobs:

- `shipbob.sync` — every 20m
- `klb.sync` — every 20m
- `trackingmore.poll` — every 15m
- `stalled.detect` — daily
- `retention.scrub` — daily
- `reconcile.daily` — daily

Manual:

```bash
npm run sync:shipbob
npm run sync:klb
npm run sync:trackingmore
npm run sync:stalled
npm run sync:retention
npm run sync:reconcile
npm run sync:notifications
npm run export:parallel-snapshot
npm run diff:narvar -- --pfm exports/parallel-snapshot-….csv --narvar narvar.csv
```
