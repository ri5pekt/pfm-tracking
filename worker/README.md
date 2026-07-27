# Worker

BullMQ worker process. Phase 0 boots Redis connection + heartbeat job.
Phase 1 adds `shipbob.orders.sync` and `shipbob.tracking.poll`.

```bash
npm run dev -w worker
```
