# Cloudflare free schedule worker

This Worker refreshes the public LoL Esports schedule on demand and caches the
normalized response for five minutes. It intentionally uses only the Workers
Cache API: no D1 database, KV namespace, queue, cron trigger, paid plan, or
always-on process is required.

Endpoints:

- `GET /health` reports the service and free-tier design.
- `GET /schedule` returns normalized matches for the dashboard.

Deploy from the repository root with:

```powershell
npx.cmd wrangler deploy --config workers/schedule/wrangler.toml
```

The static site keeps its committed JSON as a fallback whenever this Worker or
the upstream schedule API is unavailable.
