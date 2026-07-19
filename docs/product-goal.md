# LocalLink product goal

LocalLink should make a developer's local services easy to declare, find, run,
inspect, and connect without requiring optional infrastructure. The dashboard and
local web server are the product's reliable core. Extensions add capabilities;
they are not prerequisites for using LocalLink.

## Core experience

A user with Docker and/or PM2 can use LocalLink without enabling any extension.
They remain responsible for their own services and ports, while LocalLink helps
by reading well-defined service metadata, showing runtime state and dependencies,
resolving ports, exposing logs, and running lifecycle actions.

The core contract is deliberately small:

- Declare each service and its runtime identity.
- Declare ports and environment-variable names instead of hardcoding addresses.
- Declare dependencies, health information, and documentation when available.
- Provide a Dockerfile or an explicitly referenced Dockerfile blueprint as the
  portable launch and configuration interface for native services.

LocalLink should explain missing declarations, but an extension-free workspace
must remain useful and healthy.

## Multiple workspaces on one machine

Running one LocalLink workspace must not reserve a machine-wide LocalLink
namespace. Every workspace has a stable identity derived from its root unless a
user explicitly names it. That identity owns:

- the dashboard runtime record and LocalLink state under `.locallink`;
- a distinct Docker Compose project name;
- a distinct PM2 home and daemon namespace;
- generated extension configuration and secrets; and
- an automatically selected dashboard port, unless the user pins one.

Two workspaces with the same folder name but different roots must still remain
isolated. Extension installation, onboarding progress, service discovery, and
credentials are scoped to one workspace and must never be inferred from another
workspace on the same host. `.locallink/runtime.json` is the local discovery
record for users and coding agents that need the active dashboard URL.

## Optional capability layers

Capabilities should be presented as explicit layers with clear dependencies and
onboarding states.

### Private Edge

The Private Edge layer publishes selected local services to a private Tailscale
network through Tailscale Serve and a reverse proxy. LocalLink should automate
container configuration, persistent state, routes, derived URLs, and health
checks. The user still owns the external security decisions: joining a tailnet,
enabling HTTPS, supplying a bootstrap credential, and approving access policy.

### Identity

The Identity layer adds application login through an OIDC provider such as
Pocket ID after the network gate. LocalLink can install and configure the
provider, derive its issuer URL, generate local secrets, and verify discovery
endpoints. A user must still create the first administrator/passkey and approve
application identity choices.

Applications should integrate through a generic OIDC contract rather than
depending directly on Pocket ID. A service adapter should declare callback URLs,
logout URLs, scopes, and environment-variable names. This keeps the application
swappable between compatible identity providers.

### Observability

The Observability layer installs and connects an OTLP-compatible backend such as
OpenObserve. LocalLink should own generated credentials, endpoints, collector or
exporter wiring, and verification. Services should integrate through standard
OpenTelemetry variables and protocols rather than importing OpenObserve-specific
configuration into application code.

Applications with a declared OTLP contract should require little or no manual
configuration. Custom instrumentation remains application work, but its export
interface should stay vendor-neutral.

## Coding-agent integration

Coding agents are a first-class LocalLink user. LocalLink should provide an
installable agent skill that teaches an agent how to:

- Discover the active workspace, installed capabilities, and generated service
  connection information without exposing secrets in logs.
- Add or update a service declaration and its Dockerfile blueprint.
- Use standard OIDC configuration and keep the identity provider replaceable.
- Use standard OpenTelemetry configuration and keep the telemetry backend
  replaceable.
- Ask LocalLink to generate or register credentials instead of inventing or
  duplicating them in application repositories.
- Validate health, login redirects, telemetry delivery, and edge URLs after a
  change.

The CLI should eventually offer an explicit command to install or update this
skill for supported coding agents. The skill is guidance and an interface
contract; LocalLink remains the authority for workspace state, generated values,
and lifecycle operations.

## Configuration ownership

Configuration should make it obvious what a human edits and what LocalLink owns.
The target separation is:

- Committed declarations describe desired services and capabilities.
- Human configuration contains only choices and optional overrides.
- Secrets are generated or supplied once, stored locally, and never committed.
- Derived URLs, encoded authorization headers, proxy routes, and runtime files
  are generated and should not be edited by hand.
- Runtime state records installation and onboarding progress independently from
  desired configuration.
- Workspace identity and runtime-manager namespaces prevent Docker, PM2, ports,
  generated files, and extension state from colliding with another workspace.

The current `.env`-centric model is still supported, but it should evolve toward
this separation. In particular, one canonical credential must not be copied into
multiple derived variables, and application login credentials must remain
separate from ingestion or machine credentials.

## Product promise

LocalLink should always tell the user:

1. What works locally right now.
2. Which optional capabilities are installed.
3. Which setup step is waiting for the user and why it cannot be automated.
4. Which configuration is declared, generated, secret, or runtime state.
5. What a coding agent may safely change.

Detailed installer flows, manifests, secret storage, and service-adapter schemas
are intentionally deferred to a separate implementation plan.
