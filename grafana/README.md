# Grafana dashboards

## Asphodel — Service Logs (Loki)

`dashboards/asphodel-service-logs.json` — one row per service shipping to Loki,
each with a log-volume-by-level timeseries and a logs panel:

| Row           | `service` label | Source                                                       |
| ------------- | --------------- | ------------------------------------------------------------ |
| indexer-store | `indexer-store` | `mud/packages/store-indexer` (`postgres-decoded-indexer.ts`) |
| indexer-api   | `indexer-api`   | `mud/packages/store-indexer` (`postgres-frontend.ts`)        |
| keryx         | `keryx`         | `keryx/cmd/keryx` (zap → `pkg/logger/loki.go`)               |

All three emit JSON lines and share the same Loki label set: `service`, `env`,
`level`. Use `| json` to filter/columnize the body fields.

### Variables

- `datasource` — pick your Loki data source (Grafana Cloud Logs).
- `env` — `label_values(env)`; defaults to All.
- `level` — multi-select `debug|info|warn|error`; defaults to All.
- `search` — free text; matched as a line filter (`|= "..."`). Empty = match all.

### Import (Grafana Cloud)

1. Dashboards → **New** → **Import**.
2. **Upload JSON file** (or paste `dashboards/asphodel-service-logs.json`).
3. Select your Loki data source when prompted. Save.

### Useful starting queries

- Errors across every service:
  `{service=~"indexer-.+|keryx", level="error"} | json`
- store-indexer by logger component (`logger.child({ component })`):
  `{service="indexer-store"} | json | component="<name>"`
- keryx by zap logger name (`logger` field, not `component`):
  `{service="keryx"} | json | logger="<name>"`
- Push/delivery failures (transport writes these to stderr):
  `{service=~"indexer-.+|keryx"} |= "loki push:"`
