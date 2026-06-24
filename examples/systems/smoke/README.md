# LocalLink Smoke System

Minimal fixture for testing workspace lifecycle without Docker services or Taskfile dependencies.

```bash
pnpm up:smoke
pnpm status:smoke
pnpm ai:smoke
pnpm down:smoke
```

The fixture prefers API port `4210` and dashboard port `4211`, but `locallink up` will allocate the next available loopback ports when those are occupied. Use `pnpm status:smoke` to read the real assigned URLs.

It starts two PM2-managed LocalLink processes:

- `locallink-smoke-api`
- `locallink-smoke-dashboard`
