# Workspace and service contract

## Configuration ownership

| Surface | Owner | Rule |
| --- | --- | --- |
| `docker-compose.yml` | developer + LocalLink structured patches | Declare Docker runtime identity, ports, dependencies, mounts, and labels. |
| `ecosystem.config.js` | developer + LocalLink structured patches | Declare PM2/task runtime identity and metadata. |
| `locallink.services.yml` | developer | Declare non-Compose service metadata where used. |
| `locallink.extensions.yml` | LocalLink plans + reviewed user choices | Declare optional capabilities and explicit edge selections. |
| `.env.example` | developer + LocalLink | Commit names and safe defaults only; leave secrets blank. |
| `.env` | local workspace | Store local choices and secrets; never print or commit it. |
| `.locallink/` | LocalLink runtime | Do not hand-edit generated configs, secrets, backups, or ownership state. |

## Discovery workflow

Run from the intended workspace root:

```bash
locallink snapshot
locallink extensions
locallink doctor
locallink onboard
```

Use service `id`, `runtimeName`, `portEnv`, dependencies, and environment metadata from the snapshot. Do not identify a runtime only by a friendly display name.

After the service exists, use its joined application contract instead of
independently guessing extension values:

```bash
locallink service contract <service-id-or-runtime-name>
```

The command returns no credential value. It reports exact Private Edge URLs,
OIDC callback/logout values and key names, and the correct host-or-Docker OTLP
endpoint.

## Docker service pattern

Keep the container port stable and derive the host port from workspace environment:

```yaml
services:
  example-api:
    build:
      context: ./services/example-api
    ports:
      - "127.0.0.1:${EXAMPLE_API_PORT:-5100}:5100"
    environment:
      PORT: "5100"
    labels:
      locallink.name: Example API
      locallink.group: docker
      locallink.runtime: docker
      locallink.portEnv: EXAMPLE_API_PORT
      locallink.envVars: EXAMPLE_API_PORT
      locallink.dependsOn: OpenTelemetry Collector
      locallink.notes: Local example API.
      locallink.detail: Explain its role and operational dependencies.
      locallink.tags: api,docker
      locallink.oidcCallbackPath: /auth/oidc/callback
      locallink.oidcPostLogoutPath: /
      locallink.oidcScopes: openid,profile,email
      locallink.oidcEnvPrefix: EXAMPLE_API
      locallink.otelServiceName: example-api
```

Bind host ports to `127.0.0.1`. Private Edge is a separate explicit route decision.

## PM2 service pattern

Declare a stable runtime name and a Dockerfile blueprint:

```js
{
  name: 'example-api',
  script: './dist/server.js',
  env: {
    PORT: { sourceEnv: 'EXAMPLE_API_PORT' },
  },
  locallink: {
    name: 'Example API',
    group: 'pm2',
    runtime: 'pm2',
    dockerfile: './Dockerfile',
    portEnv: 'EXAMPLE_API_PORT',
    envVars: ['EXAMPLE_API_PORT'],
    dependsOn: ['OpenTelemetry Collector'],
    tags: ['api', 'pm2'],
    notes: 'Local example API.',
    integrations: {
      identity: {
        callbackPath: '/auth/oidc/callback',
        postLogoutPath: '/',
        scopes: ['openid', 'profile', 'email'],
        envPrefix: 'EXAMPLE_API',
      },
      observability: {
        serviceName: 'example-api',
      },
    },
  },
}
```

Preserve existing ecosystem style. Use LocalLink’s structured config interfaces when available.

The equivalent `locallink.services.yml` entry uses the same nested
`integrations.identity` and `integrations.observability` shape. Treat an
integration as opted in only when it is declared; shared infrastructure being
healthy does not silently enroll every application.

## Dockerfile blueprint

Treat the Dockerfile as the portable static launch contract even when development runs under PM2:

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV PORT=5100
EXPOSE 5100
CMD ["node", "dist/server.js"]
```

Use a non-root final user when practical. Add a healthcheck at the Compose layer if the image lacks a suitable built-in check.

## Completion checks

- The service starts through its declared runtime manager.
- LocalLink reports the correct runtime state and resolved port.
- Required metadata and Dockerfile blueprint are present.
- A local health request succeeds.
- No secret or machine-specific URL appears in committed files.
- Private Edge exposure, if requested, uses a fresh reviewed plan and confirmation token.
