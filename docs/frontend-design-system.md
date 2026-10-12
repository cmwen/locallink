# LocalLink frontend design system

LocalLink uses `@cmwen/min-design-system` 0.3.0 (Forest & Fern). The version is pinned so package updates can be reviewed against the dashboard before adoption.

## Integration

`frontend/src/main.tsx` imports the exported `forest-and-fern.css` bundle before application styles. Use that explicit CSS path with strict TypeScript; the bare package entry has no type declaration and fails the side-effect import check.

The document root owns `data-ff-theme`. The existing `locallink-theme` preference persists light/dark selection, with a dark fallback when browser storage is unavailable. The application boundary opts into compact density and subtle motion. Browser chrome colors follow the selected palette.

`frontend/src/styles.css` maps legacy application tokens onto `--ff-*` tokens. The package owns palette, native controls, disabled states, focus rings, semantic tones, and reduced-motion behavior. Application CSS owns domain layouts, chart geometry, log presentation, responsive navigation, and restrained corner/font overrides. Main workspace panels, desktop navigation, and dialogs opt into subtle wave edges through `ff-wave-surface` and `data-ff-wave="soft"`. The package masks decorative layers only; text, controls, and focus outlines stay unmasked. Forced-colors mode restores plain system borders. No remote font requests or optional package JavaScript are required.

Use `ff-button` with secondary/quiet/danger variants, `ff-input`, `ff-select`, `ff-dialog`, `ff-pill`, `ff-alert`, and `ff-nav-link` for shared UI. Avoid duplicating their base styles. Application-selected button filters use the package's selected palette. Service selectors use `ff-selectable`; health pills retain status text and map to success, neutral, warning, or danger.

## Workspace structure

Desktop navigation stays beside the content, with destination descriptions and a service count. Mobile navigation stays below the content, reserving bottom space and safe-area padding. Both expose real route links and the active destination. Launchpad is available only while the network edge is enabled.

The header contains the page description, search, primary action, refresh, and theme selection. PM2 workspace save/resurrect actions are grouped in a native disclosure. Service overview and detail keep lifecycle actions, health filters, relationships, and the existing mobile list/detail flow. Native modal behavior and termination review remain application-owned.

## Validation

Frontend TypeScript and Vite production build pass. The frontend view-model and HTTP-server suites pass (22 tests), including filtered service selection, workspace queries, direct routes, and guarded PM2 workflows.

Browser verification remains pending: check all four views in light/dark at desktop and mobile widths, theme persistence, keyboard navigation, service selection, PM2 disclosure, modal Escape/focus restoration, and resource/log interactions. Automated browser access was unavailable during this implementation; build and server tests do not establish visual or accessibility conformance.

No upstream design-system changes were required. A future package improvement could document strict TypeScript imports or provide a declaration for the bare CSS entry point.

## Candidates for shared package recipes

- **Panel with header/body/footer slots:** provide a ready-to-use wave surface with positioning, isolation, background/border removal, content spacing, and forced-colors fallback. LocalLink currently supplies this scaffolding around `ff-wave-surface`.
- **Filter and scope controls:** group selectable buttons with consistent selected/disabled/focus styles, compact wrapping, and documented semantics for independent toggles versus mutually exclusive choices. Avoid tab semantics when the controls filter a view.
- **Metric and fact displays:** support label/value/unit layouts, tabular numbers, semantic tones, definition lists, and native meter/progress styling. Keep data sampling and thresholds application-owned.
- **Action disclosure:** document a native details/summary recipe for secondary action groups, with compact layout and mobile-safe positioning. Keep execution and repeat-submission protection in the app.
- **Activity/log viewer:** provide readable monospace rows, timestamp/source/severity slots, wrapping, bounded scrolling, and guidance for pause/copy/live announcements. Keep streaming and log retention in the app.

Prioritize panels and filter groups: they account for repeated integration CSS. These should remain CSS/native-HTML recipes, consistent with the package's framework-agnostic approach; service orchestration and process inspection belong in LocalLink.
