---
name: locallink-workspace
description: Develop, declare, integrate, and verify applications in a LocalLink workspace. Use when an agent adds or updates a Docker, PM2, or task-backed service; writes its Dockerfile blueprint or LocalLink metadata; exposes it through Private Edge; adds provider-neutral OIDC login; connects OpenTelemetry logs, metrics, or traces; or diagnoses LocalLink onboarding and runtime state.
---

# LocalLink Workspace

Use LocalLink as the authority for workspace identity, derived endpoints, runtime state, generated infrastructure, and secrets. Keep application interfaces portable across identity and telemetry providers.

## Establish the workspace

1. Find the nearest workspace containing `.env`, `docker-compose.yml`, and `locallink.extensions.yml`.
2. Run read-only discovery before editing:

   ```bash
   locallink snapshot
   locallink extensions
   locallink onboard
   ```

3. For an existing application, read its joined, secret-free integration contract:

   ```bash
   locallink service contract <service-id-or-runtime-name>
   ```

4. Use `locallink onboard` ownership as the default sequence. Run the relevant
   detailed read-only plan when identity, observability, or private access needs
   diagnosis:

   ```bash
   locallink extension plan identity
   locallink extension plan observability
   locallink extension plan private-edge
   ```

5. Treat the returned workspace ID and root as a boundary. Never reuse endpoints, ports, routes, credentials, generated files, Docker resources, or PM2 state from another LocalLink workspace.

Do not shell-source `.env`; workspace values can contain spaces or other non-shell text. Do not print `.env`, secret files, encoded authorization values, client secrets, or container environments. Read only the named non-secret keys needed for a change.

## Choose the workflow

- Read [references/workspace-contract.md](references/workspace-contract.md) when adding, changing, launching, or declaring a service.
- Read [references/identity-oidc.md](references/identity-oidc.md) when adding login, sessions, callbacks, logout, or access control.
- Read [references/observability-otel.md](references/observability-otel.md) when adding instrumentation, OTLP export, service names, logs, metrics, or traces.

Use more than one reference when a service needs multiple capabilities.

## Preserve ownership boundaries

- Edit committed service declarations and application adapters.
- Let `locallink extension apply ...` own generated extension configuration, derived URLs, encoded backend authorization, local state, and managed Docker infrastructure.
- Keep secrets in ignored local configuration. Put only blank placeholders and documentation in `.env.example`.
- Preview Private Edge changes and require the user’s fresh confirmation token before publishing a route.
- Never expose the OpenTelemetry Collector through Private Edge. Publish only explicitly selected human-facing services.
- Stop when LocalLink reports unowned infrastructure, stale credentials, non-persistent data, an issuer migration, or another user-owned decision.

## Keep application interfaces generic

- Put OIDC behind an application-owned identity adapter. Accept issuer, client ID, client secret, callback, logout URL, and scopes from environment variables.
- Put telemetry behind OpenTelemetry SDKs and standard `OTEL_*` variables. Do not import OpenObserve-specific code or send its authorization header from an application.
- Give every application a stable, unique `OTEL_SERVICE_NAME`.
- Resolve URLs and ports from environment variables. Do not hardcode the current tailnet name, HTTPS listener, loopback port, Pocket ID hostname, or OpenObserve address.

## Verify the change

1. Validate application tests and its Dockerfile/build contract.
2. Confirm LocalLink discovers the service and its declared runtime identity:

   ```bash
   locallink snapshot
   locallink service contract <service-id-or-runtime-name>
   locallink doctor
   ```

3. Re-run relevant extension plans. Apply only automatic workspace-owned steps that are within the user’s request.
4. Verify the local health endpoint before any private URL.
5. For OIDC, verify discovery, callback, session persistence, logout, and redirect-loop behavior without logging tokens.
6. For telemetry, emit a test signal and verify it under the declared service name. `locallink extension apply observability` already verifies the shared collector-to-backend path.
7. Report manual administrator, OIDC-client registration, route-confirmation, or access-policy steps explicitly.
