# LocalLink future features

This document is the product roadmap, not a description of features that are
already available. The current product boundary is documented in
[product-goal.md](product-goal.md), and the live workspace can report its actual
state with:

```bash
locallink doctor
locallink onboard
```

LocalLink's extension-free dashboard, service discovery, port allocation, and
lifecycle controls must continue to work while the foundation capabilities
evolve.

## Current boundary

LocalLink already automates the workspace-owned parts of Docker Caddy,
Tailscale Serve routing, Pocket ID installation, OpenObserve installation, and
OpenTelemetry Collector configuration. It also reports the remaining
automatic, manual, blocked, and optional onboarding steps.

Some security decisions intentionally remain manual:

- Joining or creating a tailnet and approving its access policy.
- Enabling tailnet HTTPS support when required.
- Reviewing which services receive Private Edge routes.
- Creating the first Pocket ID administrator and passkey.
- Registering an OIDC client and placing its client secret in the consuming
  application's local secret store.
- Choosing or adding application-specific authentication and telemetry code.

Current safety boundaries are not roadmap items:

- Extensions remain optional.
- LocalLink does not enable Tailscale Funnel or public exposure by default.
- Host-installed Caddy is unsupported; Caddy automation targets the
  workspace-owned Docker service.
- Contracts, dashboards, logs, and committed templates do not return secrets.
- LocalLink never silently resets an identity issuer, account, password, or
  persistent data volume.

## Priority 1: guided foundation onboarding

The next onboarding work should turn the existing report into a resumable,
evidence-backed workflow:

- Record completion evidence for user-owned checkpoints without treating a
  checkbox as proof that an external action succeeded.
- Detect tailnet login, HTTPS readiness, Caddy/Tailscale reachability, Pocket ID
  first-admin readiness, and stale configuration after every step.
- Provide exact commands and deep links where an external administrator must
  act.
- Add a dry-run wizard that shows generated files, route changes, secret
  locations, and rollback boundaries before applying anything.
- Keep every plan scoped to one stable workspace ID and reject machine-wide
  listener collisions.

The immediate deliverable is persistent checkpoint state plus validation for
the manual steps already returned by `locallink onboard`.

## Priority 2: provider-neutral application identity

Shared Pocket ID infrastructure is useful only when an application can consume
it without provider-specific coupling. LocalLink should add a versioned OIDC
client adapter contract that can:

- Validate a service's callback URLs, post-logout URLs, scopes, and environment
  variable names.
- Create, list, rotate, and revoke an application client when the selected
  identity provider exposes a supported administrative API.
- Store the resulting client secret in a local secret adapter and expose only
  the secret's location or reference.
- Generate application configuration using standard issuer, client ID, client
  secret, callback, scope, and logout concepts.
- Require explicit confirmation before rotation or revocation and preserve
  enough state for a safe rollback.
- Verify the complete redirect and session flow without logging credentials,
  cookies, or tokens.

Pocket ID should be the first adapter, but the application-facing contract must
remain replaceable. Provider encryption keys, administrator credentials, and
application client secrets must never be reused for one another.

## Priority 3: service-scoped telemetry automation

The shared collector and OpenObserve backend are implemented. The next layer
should help each application adopt the generic OTLP contract:

- Inject the correct host/PM2 or Docker endpoint through the service
  declaration rather than copying backend credentials.
- Provide framework recipes for Node.js, Python, and other common runtimes.
- Generate or patch small, reviewable instrumentation adapters when an
  application asks for them.
- Send a service-specific trace, metric, and log canary and verify each result
  through the collector.
- Report missing instrumentation separately from collector or backend failure.
- Add optional dashboards and alerts without making application code depend on
  OpenObserve.

## Priority 4: safer Private Edge evolution

Private Edge should become easier to change without weakening its confirmation
model:

- Add additive `service expose` and `service unexpose` commands so one service
  can change without replacing the complete selection.
- Preview generated Caddy and Tailscale configuration in the dashboard.
- Lint route ownership, listener collisions, HTTPS readiness, and tailnet
  policy assumptions before mutation.
- Verify access from the intended network boundary, not only from the local
  host.
- Preserve the rule that public exposure and Funnel require a separate,
  deliberate future design.

## Priority 5: multiple-workspace operations

Workspaces already have stable IDs, isolated PM2 homes, isolated Compose
projects, allocated dashboard ports, and stale runtime cleanup. A future
machine-level launcher can build on those boundaries:

- Discover active workspace runtime records without merging their
  configuration or credentials.
- Show workspace ports, resource use, foundation readiness, and collisions in
  one read-only view.
- Start, stop, or open one selected workspace with an explicit target.
- Provide backup and restore operations scoped to a workspace and extension.
- Test simultaneous workspaces that have the same directory basename.

This launcher must not introduce a shared global credential file or allow one
workspace to mutate another workspace's routes.

## Priority 6: coding-agent developer experience

The bundled skill and MCP contracts should evolve with the service interfaces:

- Add framework-specific OIDC and OpenTelemetry recipes behind the generic
  contracts.
- Let agents preview declaration, Dockerfile, environment, and route changes
  before applying them.
- Report which files are human-owned, generated, secret, or runtime state.
- Validate application health, login redirects, telemetry delivery, and edge
  URLs as one service onboarding result.
- Version the skill and contracts so an agent can detect and update an older
  managed copy safely.

## Priority 7: releases, upgrades, and recovery

Before broader distribution, LocalLink needs:

- Versioned workspace-state and generated-file migrations.
- Pre-upgrade checks, backups, rollback instructions, and restore tests for
  Pocket ID and OpenObserve data.
- Pinned, reviewable image versions with an explicit update command.
- Cross-platform packaging and a repeatable CLI upgrade path.
- CI coverage for a fresh extension-free workspace, each individual
  capability, the full foundation stack, two simultaneous workspaces, and
  failed apply/rollback paths.

## Priority 8: security hardening

- Pluggable local secret stores with strict file-permission fallback.
- An audit record for plans, confirmations, writes, route mutations, credential
  lifecycle actions, and rollback results.
- Automated redaction tests across CLI, HTTP, MCP, logs, snapshots, and error
  messages.
- Least-privilege checks for Docker, Tailscale, provider APIs, and generated
  files.
- A threat model covering a malicious service declaration, compromised coding
  agent, route collision, and cross-workspace access.

## Definition of done for a future feature

A roadmap feature is complete only when it:

1. Works in an extension-free workspace or remains clearly optional.
2. Has a read-only plan and identifies automatic, manual, and blocked work.
3. Defines configuration ownership and never returns secret values.
4. Is idempotent, verifies the resulting external state, and has a scoped
   rollback or recovery path.
5. Remains isolated across two simultaneous LocalLink workspaces.
6. Is exposed consistently through the appropriate CLI, HTTP, MCP, dashboard,
   documentation, and agent-skill surfaces.
7. Has tests for success, adoption of existing state, invalid credentials,
   partial failure, and retry.

## Recommended delivery order

1. Persistent manual-checkpoint evidence and onboarding validation.
2. Pocket ID OIDC client lifecycle behind the provider-neutral identity
   adapter.
3. Service-scoped telemetry injection and canary verification.
4. Additive Private Edge expose/unexpose operations.
5. Read-only multi-workspace launcher and recovery tooling.
6. Additional identity, telemetry, framework, and secret-store adapters.
