# LocalLink UI Redesign QA

## Scope

- Worktree: `/home/cmwen/dev/locallink-ui-redesign`
- Branch: `codex/ui-framework-redesign`
- Frontend stack: React + TypeScript + Vite
- Source design inputs:
  - `/home/cmwen/.codex/attachments/bbf20666-407f-427e-a83e-6650e34147bb/DESIGN-HANDOFF.md`
  - `/home/cmwen/.codex/attachments/bdf65c69-ed3f-4bc4-9d4d-0296000d6f1c/locallink-wireframe.css`
  - workspace screen HTML files for current, external, and resources views

## Implemented

- Replaced the old vanilla dashboard bundle with a React/TypeScript app under `frontend/`.
- Preserved the wireframe visual system: OKLCH dark/light tokens, compact panes, 7-8px radii, bordered operational cards, sticky desktop toolbar, and mobile bottom navigation.
- Implemented the three target workspaces as React views:
  - Current: service list, health filters, lifecycle actions, linked docs, runtime facts, configuration, and clickable service relationships.
  - Extensions: dashboard/proxy/edge toggles, config summary, port list, version queue.
  - Resources: five-second CPU/memory trends, independent top-five CPU and memory rankings, process inspection, port allocation, logs, and process termination review.
- Resource sampling starts with the server, keeps a bounded three-minute history, and excludes the short-lived `ps` probe from rankings.
- Added direct workspace routes for `/current`, `/extensions`, `/external`, and `/resources`, while keeping `/dashboard` as the general shell.
- Connected existing backend APIs where they exist:
  - `GET /api/state`
  - `GET /api/logs/stream`
  - `POST /api/tasks`
  - `POST /api/ports/next`
  - `GET /api/processes/:pid`
  - `POST /api/processes/:pid/terminate`
- Kept mock/sample state fallback for static preview and API outage scenarios.

## Missing Backend Contracts

- Temporary runtime registration is session-only in the UI. A persisted create/list/delete API is still needed.
- Extension settings are session-only in the UI. A persisted workspace config API is still needed.
- Port release is not implemented because there is no reservation persistence model yet. Current port data is scan-derived.
- Version update queue is local UI state only. It needs a CLI/update workflow endpoint before it should perform real updates.

## Verification

- `pnpm -s build` passes.
- `pnpm -s test` passes with 37 tests.
- Local web server responds on `http://127.0.0.1:4217`.
- `/`, `/dashboard`, `/current`, `/extensions`, `/external`, `/resources`, and `/template` serve the React asset bundle.
- `/api/state` returns live services, ports, logs, host pressure history, and separate process rankings.
- Playwright Chromium screenshot capture completed for `/current`, `/extensions`, and `/resources` at:
  - 360x800
  - 390x844
  - 430x932
  - 600x960
  - 820x1180
  - 1024x768
  - 1366x768
  - 1440x900
  - 1920x1080
- Screenshot artifacts are in `/tmp/locallink-ui-shots`.
- Representative visual inspection caught and fixed the stretched service-detail action row before this QA note was finalized.
- The screenshot matrix predates the expanded pressure charts and process rankings; those additions were validated through TypeScript, API contract checks, and responsive CSS review in this pass.
