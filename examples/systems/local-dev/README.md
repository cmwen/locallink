# LocalLink Local Dev System

This is a committed, non-secret system workspace fixture for local testing.

Run it from the repository root:

```bash
pnpm up
pnpm down
pnpm start
pnpm dashboard
pnpm snapshot
```

Or select it explicitly:

```bash
node ../../../bin/locallink.js --workspace . api
node ../../../bin/locallink.js --workspace . dashboard
```

Isolation choices:

- `COMPOSE_PROJECT_NAME=locallink_local_dev`
- `PM2_HOME=.locallink/pm2/local-dev`
- API/dashboard ports `4110` / `4111`
- Dashboard extension enabled for `pnpm up` smoke testing
- Postgres host port `55432`
- Queue worker port `6102`
