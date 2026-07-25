# Provider-neutral OpenTelemetry integration

## Discover the workspace transport

Run:

```bash
locallink extension plan observability
locallink extensions
```

Require the plan to report:

- OpenObserve healthy, persistent, and authenticated;
- collector healthy, configured, and loopback-only;
- `deliveryVerified: true`;
- the application receiver endpoints.

Do not copy `OPENOBSERVE_ACCESS_KEY_B64`, root credentials, or backend-specific headers into an application.

## Host and PM2 applications

Use the workspace’s standard host values:

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<workspace-port>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=example-api
```

Read the actual endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT`; do not assume port 4318 is free in every workspace.

## Docker applications

Loopback inside a container means that container, not the collector. Map LocalLink’s derived Compose endpoint into the standard SDK variable:

```yaml
services:
  example-api:
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: ${LOCALLINK_OTEL_DOCKER_ENDPOINT}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: example-api
    depends_on:
      - otel-collector
```

Read the resolved endpoint from
`locallink service contract <service-id-or-runtime-name>`. The underlying
workspace Compose endpoint is stored in `LOCALLINK_OTEL_DOCKER_ENDPOINT`; do not
hardcode the collector service name. Preserve existing `depends_on` entries.

## Instrumentation rules

- Use official OpenTelemetry SDKs and instrumentation for the application language.
- Set a stable, unique `OTEL_SERVICE_NAME`; do not use a display label that changes frequently.
- Add `service.version` and deployment/workspace attributes when useful and low-cardinality.
- Propagate W3C trace context across service calls.
- Correlate logs with trace/span IDs through the SDK or logging bridge.
- Keep health checks, passwords, tokens, cookies, authorization headers, prompts containing secrets, and high-cardinality personal data out of telemetry.
- Make sampling and sensitive-data filtering application-owned decisions.
- Avoid OpenObserve imports, endpoint paths, stream headers, and Basic authorization in application code.

## Verification

The extension canary proves the shared collector-to-OpenObserve path. The application must still prove its own instrumentation:

1. start the application through its declared runtime;
2. exercise one representative request;
3. confirm a log or span under its exact `OTEL_SERVICE_NAME`;
4. confirm errors include useful status without secret payloads;
5. confirm trace context crosses one downstream call when applicable;
6. rerun `locallink snapshot` and the observability plan.
