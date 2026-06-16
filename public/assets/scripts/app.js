const PAGE_CONFIG = {
  launcher: {
    usesApi: true,
    footerNote:
      'LocalLink Phase 1 is designed as a local-only control plane: no public proxy, no cloud dependency, and no machine-specific absolute paths in the configuration model.',
    surfaceCards: state => [
      {
        title: 'Canonical dashboard',
        detail:
          'Open the full LocalLink surface wired to the runtime snapshot, service actions, and live log stream endpoints.',
        meta: state.snapshot.value || 'Live runtime state',
        href: './dashboard.html',
        cta: 'Open dashboard'
      },
      {
        title: 'Template preview',
        detail:
          'Inspect the extracted composition contract with the same shared modules, interactions, and mock snapshot data.',
        meta: 'Static contract preview',
        href: './template.html',
        cta: 'Open template'
      },
      {
        title: 'PWA shell',
        detail:
          `Manifest ${state.pwa.manifest || 'pending'} · service worker ${state.pwa.serviceWorker || 'pending'} · offline ${state.pwa.offline || 'pending'}.`,
        meta: state.pwa.install || 'Install readiness',
        href: './manifest.webmanifest',
        cta: 'Inspect manifest'
      }
    ]
  },
  dashboard: {
    usesApi: true,
    footerNote:
      'LocalLink Phase 1 is designed as a local-only control plane: no public proxy, no cloud dependency, and no machine-specific absolute paths in the configuration model.'
  },
  template: {
    usesApi: false,
    heroOverride: {
      eyebrow: 'Mockup composition contract',
      title: 'Reusable UI modules for LocalLink surfaces.',
      body:
        'Preview the extracted tokens, hierarchy, and interactions against static mock data before the backend snapshot is connected.'
    },
    footerNote:
      'This preview surface is intentionally static: it validates the shared module composition, token extraction, and local-only interaction model before /api/state is available.',
    surfaceCards: () => [
      {
        title: 'Mock state source',
        detail:
          'This surface renders from a shared mock snapshot so the launcher, dashboard, and preview stay visually aligned during integration.',
        meta: 'assets/data/mock-state.json',
        href: './assets/data/mock-state.json',
        cta: 'Open data'
      },
      {
        title: 'Live dashboard route',
        detail:
          'Move to the canonical dashboard once the backend exposes /api/state, /api/tasks, /api/ports/next, and /api/logs/stream.',
        meta: 'API-driven surface',
        href: './dashboard.html',
        cta: 'Open dashboard'
      },
      {
        title: 'Shared shell assets',
        detail:
          'CSS, JS, manifest, and service worker are all reused directly from public/assets for low-risk integration.',
        meta: 'Framework-free shell',
        href: './manifest.webmanifest',
        cta: 'Inspect shell'
      }
    ]
  }
};

const DEFAULT_FOOTER =
  'LocalLink Phase 1 is designed as a local-only control plane: no public proxy, no cloud dependency, and no machine-specific absolute paths in the configuration model.';
const THEME_KEY = 'locallink-theme';
const SNAPSHOT_CACHE_KEY = 'locallink-last-live-state';
const LIGHT_THEME_COLOR = '#f4f7fa';
const DARK_THEME_COLOR = '#0f161f';
const LOG_TABS = [
  { value: 'all', label: 'All' },
  { value: 'lifecycle', label: 'Lifecycle' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'alerts', label: 'Alerts' }
];
const DEFAULT_STATE = {
  app: {
    name: 'LocalLink',
    subtitle: 'Local-first orchestration for Docker, PM2, and dev servers',
    scope: '127.0.0.1 only'
  },
  hero: {
    eyebrow: 'Phase 1 control plane',
    title: 'One dashboard for local runtimes, ports, and logs.',
    body:
      'Monitor hybrid services, trigger lifecycle actions, and hand the whole workspace to AI through the same compact surface.'
  },
  snapshot: {
    value: '0 services',
    detail:
      'rehydrated from Docker, PM2, PWA dev servers, and Windows process probes'
  },
  stats: [],
  pwa: {
    manifest: 'Pending',
    serviceWorker: 'Pending',
    offline: 'Pending',
    install: 'Install readiness unknown',
    scope: 'localhost'
  },
  diagnostics: {
    status: 'ok',
    summary: 'All startup checks passed.',
    checks: []
  },
  phase2: {
    enabled: true,
    summary: 'No optional Phase 2 edge tooling detected yet; LocalLink stays local-only by default.',
    options: []
  },
  filters: [],
  services: [],
  tools: [],
  logs: [],
  ports: {
    startFrom: 5000,
    nextFree: 5000,
    busy: [],
    busyText: 'None',
    rule: 'First free local port',
    recent: []
  },
  resources: {
    summary: [],
    processes: []
  },
  constraints: [],
  timeline: []
};

const page = document.body.dataset.page || 'dashboard';
const config = PAGE_CONFIG[page] || PAGE_CONFIG.dashboard;
const ui = {
  body: document.body,
  appShell: document.querySelector('[data-app-shell]'),
  appName: document.querySelector('[data-app-name]'),
  appSubtitle: document.querySelector('[data-app-subtitle]'),
  search: document.querySelector('[data-search]'),
  themeToggle: document.querySelector('[data-theme-toggle]'),
  refresh: document.querySelector('[data-refresh]'),
  statusBanner: document.querySelector('[data-status-banner]'),
  heroEyebrow: document.querySelector('[data-hero-eyebrow]'),
  heroTitle: document.querySelector('[data-hero-title]'),
  heroBody: document.querySelector('[data-hero-body]'),
  heroPills: document.querySelector('[data-hero-pills]'),
  snapshotValue: document.querySelector('[data-snapshot-value]'),
  snapshotDetail: document.querySelector('[data-snapshot-detail]'),
  snapshotPills: document.querySelector('[data-snapshot-pills]'),
  summaryGrid: document.querySelector('[data-summary-grid]'),
  launcherGrid: document.querySelector('[data-launcher-grid]'),
  filterRow: document.querySelector('[data-filter-row]'),
  serviceGrid: document.querySelector('[data-service-grid]'),
  servicesEmpty: document.querySelector('[data-services-empty]'),
  pwaGrid: document.querySelector('[data-pwa-grid]'),
  diagnosticsGrid: document.querySelector('[data-diagnostics-grid]'),
  toolsList: document.querySelector('[data-tools-list]'),
  phase2Grid: document.querySelector('[data-phase2-grid]'),
  logTabs: document.querySelector('[data-log-tabs]'),
  logList: document.querySelector('[data-log-list]'),
  logsEmpty: document.querySelector('[data-logs-empty]'),
  logViewer: document.querySelector('[data-log-viewer]'),
  logViewerSearch: document.querySelector('[data-log-viewer-search]'),
  logViewerTimeFilter: document.querySelector('[data-log-viewer-time-filter]'),
  logViewerTabs: document.querySelector('[data-log-viewer-tabs]'),
  logViewerSummary: document.querySelector('[data-log-viewer-summary]'),
  logViewerList: document.querySelector('[data-log-viewer-list]'),
  logViewerEmpty: document.querySelector('[data-log-viewer-empty]'),
  nextPort: document.querySelector('[data-next-port]'),
  portStartLabel: document.querySelector('[data-port-start-label]'),
  portForm: document.querySelector('[data-port-form]'),
  portInput: document.querySelector('[data-port-input]'),
  portBusy: document.querySelector('[data-port-busy]'),
  portRule: document.querySelector('[data-port-rule]'),
  portRecent: document.querySelector('[data-port-recent]'),
  portEmpty: document.querySelector('[data-port-empty]'),
  resourceSummary: document.querySelector('[data-resource-summary]'),
  processTable: document.querySelector('[data-process-table]'),
  processEmpty: document.querySelector('[data-process-empty]'),
  processDetail: document.querySelector('[data-process-detail]'),
  processDetailEmpty: document.querySelector('[data-process-detail-empty]'),
  constraintsGrid: document.querySelector('[data-constraints-grid]'),
  timelineGrid: document.querySelector('[data-timeline-grid]'),
  footerNote: document.querySelector('[data-footer-note]'),
  themeMeta: document.querySelector('meta[name="theme-color"]')
};

const runtime = {
  state: normalizeState(DEFAULT_STATE),
  activeFilter: 'all',
  activeLogTab: 'all',
  query: '',
  liveLogs: [],
  pendingServices: new Set(),
  usingMockFallback: page === 'template',
  eventSource: null,
  streamWarningShown: false,
  loading: false,
  logViewerOpen: false,
  logViewerQuery: '',
  logViewerTimeFilter: 'all',
  selectedProcess: null,
  pendingProcessIds: new Set(),
  cachedSnapshotSavedAt: null
};

if (ui.appShell) {
  initialize();
}

async function initialize() {
  bindEvents();
  applyStoredTheme();
  updateNavState();
  hydratePersistedState();
  renderAll();
  await loadState({ announce: page === 'template' });
  registerServiceWorker();
}

function hasLiveApiConnection() {
  return config.usesApi && !runtime.usingMockFallback;
}

function liveApiUnavailable() {
  return config.usesApi && runtime.usingMockFallback;
}

function hydratePersistedState() {
  if (!config.usesApi) return;
  const cached = readPersistedSnapshot();
  if (!cached) return;

  runtime.state = applyPageOverrides(normalizeState(cached.state));
  runtime.usingMockFallback = true;
  runtime.cachedSnapshotSavedAt = cached.savedAt || null;
}

function readPersistedSnapshot() {
  const raw = safeStorage('getItem', SNAPSHOT_CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const state = parsed?.state && typeof parsed.state === 'object'
      ? parsed.state
      : parsed && typeof parsed === 'object'
        ? parsed
        : null;
    if (!state) return null;

    return {
      savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : '',
      state
    };
  } catch {
    return null;
  }
}

function persistLiveSnapshot(state) {
  if (!config.usesApi) return;

  const savedAt = new Date().toISOString();
  runtime.cachedSnapshotSavedAt = savedAt;
  safeStorage(
    'setItem',
    SNAPSHOT_CACHE_KEY,
    JSON.stringify({
      savedAt,
      state: cloneState(state)
    })
  );
}

function formatPersistedSnapshotTime(savedAt) {
  const parsed = Date.parse(savedAt || '');
  if (!Number.isFinite(parsed)) return 'an earlier session';

  return new Date(parsed).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function bindEvents() {
  ui.search?.addEventListener('input', event => {
    runtime.query = String(event.target.value || '').trim().toLowerCase();
    renderServices();
    renderLogs();
    renderPorts();
  });

  ui.refresh?.addEventListener('click', async () => {
    const announce = page === 'template';
    await loadState({ announce: true, templateRefresh: announce });
    if (page === 'template') {
      pushLiveLog(
        normalizeLog({
          stream: 'Runtime',
          level: 'info',
          message: 'Preview snapshot reloaded from the shared mock contract.'
        })
      );
    }
  });

  ui.themeToggle?.addEventListener('click', () => {
    const nextTheme = ui.body.dataset.theme === 'dark' ? 'light' : 'dark';
    safeStorage('setItem', THEME_KEY, nextTheme);
    applyTheme(nextTheme);
    pushLiveLog(
      normalizeLog({
        stream: 'Runtime',
        level: 'info',
        message: `Theme switched to ${nextTheme} mode.`
      })
    );
  });

  ui.portForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const startFrom = Number(ui.portInput?.value) || runtime.state.ports.startFrom || 5000;
    await handlePortRequest(startFrom);
  });

  ui.logViewerSearch?.addEventListener('input', event => {
    runtime.logViewerQuery = String(event.target.value || '').trim().toLowerCase();
    renderLogViewer();
  });

  ui.logViewerTimeFilter?.addEventListener('change', event => {
    runtime.logViewerTimeFilter = String(event.target.value || 'all');
    renderLogViewer();
  });

  document.addEventListener('click', event => {
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) {
      runtime.activeFilter = filterButton.dataset.filter || 'all';
      renderFilters();
      renderServices();
      return;
    }

    const logTabButton = event.target.closest('[data-log-tab]');
    if (logTabButton) {
      runtime.activeLogTab = logTabButton.dataset.logTab || 'all';
      renderLogTabs();
      renderLogs();
      return;
    }

    const panelButton = event.target.closest('[data-panel]');
    if (panelButton) {
      setPanel(panelButton.dataset.panel || 'overview');
      return;
    }

    const focusButton = event.target.closest('[data-focus]');
    if (focusButton) {
      setPanel(focusButton.dataset.focus || 'overview');
      return;
    }

    const focusServiceButton = event.target.closest('[data-focus-service]');
    if (focusServiceButton) {
      focusServiceCard(focusServiceButton.dataset.focusService || '');
      return;
    }

    const commandButton = event.target.closest('[data-command]');
    if (commandButton) {
      handleServiceCommand(commandButton);
      return;
    }

    const openLogViewerButton = event.target.closest('[data-open-log-viewer]');
    if (openLogViewerButton) {
      setLogViewerOpen(true);
      return;
    }

    const closeLogViewerButton = event.target.closest('[data-close-log-viewer]');
    if (closeLogViewerButton || event.target === ui.logViewer) {
      setLogViewerOpen(false);
      return;
    }

    const inspectProcessButton = event.target.closest('[data-process-inspect]');
    if (inspectProcessButton) {
      handleProcessInspect(inspectProcessButton);
      return;
    }

    const terminateProcessButton = event.target.closest('[data-process-terminate]');
    if (terminateProcessButton) {
      handleProcessTerminate(terminateProcessButton);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && runtime.logViewerOpen) {
      setLogViewerOpen(false);
    }
  });

  const systemThemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
  systemThemeQuery?.addEventListener('change', event => {
    if (safeStorage('getItem', THEME_KEY)) return;
    applyTheme(event.matches ? 'dark' : 'light');
  });
}

async function loadState(options = {}) {
  setLoading(true);
  try {
    let state;
    if (config.usesApi) {
      try {
        const apiState = await fetchJson('./api/state');
        runtime.usingMockFallback = false;
        runtime.cachedSnapshotSavedAt = null;
        state = normalizeState(apiState);
        setStatus(options.announce ? 'Snapshot refreshed from /api/state.' : '', 'info');
      } catch (error) {
        const fallback = readPersistedSnapshot();
        runtime.usingMockFallback = true;
        runtime.cachedSnapshotSavedAt = fallback?.savedAt || null;
        state = normalizeState(fallback?.state || DEFAULT_STATE);
        setStatus(
          fallback
            ? `Live API unavailable; showing the last saved snapshot from ${formatPersistedSnapshotTime(fallback.savedAt)} until /api/state responds again.`
            : 'Live API unavailable and no saved snapshot is available yet.',
          'warn'
        );
      }
    } else {
      const previewState = await fetchJson('./assets/data/mock-state.json');
      runtime.usingMockFallback = true;
      state = normalizeState(previewState);
      if (options.announce) {
        setStatus('Template preview loaded from the shared mock snapshot.', 'info');
      }
    }

    runtime.state = applyPageOverrides(state);
    if (hasLiveApiConnection()) {
      persistLiveSnapshot(runtime.state);
    }
    if (
      runtime.selectedProcess &&
      !(runtime.state.resources?.processes || []).some(process => process.pid === runtime.selectedProcess.pid)
    ) {
      runtime.selectedProcess = null;
    }
    runtime.activeFilter = ensureActiveFilter(runtime.activeFilter, runtime.state.filters);
    renderAll();
    applyStartupStatus();
    updateLogStream();
  } catch (error) {
    setStatus(`Unable to load LocalLink state: ${error.message}.`, 'error');
  } finally {
    setLoading(false);
  }
}

function applyPageOverrides(state) {
  const next = cloneState(state);
  if (config.heroOverride) {
    next.hero = { ...next.hero, ...config.heroOverride };
  }
  next.footerNote = config.footerNote || DEFAULT_FOOTER;
  return next;
}

function setLoading(loading) {
  runtime.loading = loading;
  ui.appShell?.setAttribute('aria-busy', String(loading));
  if (ui.refresh) ui.refresh.disabled = loading;
}

function setStatus(message, tone = 'info') {
  if (!ui.statusBanner) return;
  if (!message) {
    ui.statusBanner.hidden = true;
    ui.statusBanner.textContent = '';
    ui.statusBanner.dataset.tone = '';
    return;
  }
  ui.statusBanner.hidden = false;
  ui.statusBanner.dataset.tone = tone;
  ui.statusBanner.textContent = message;
}

function applyStoredTheme() {
  const stored = safeStorage('getItem', THEME_KEY);
  applyTheme(stored || preferredTheme());
}

function applyTheme(theme) {
  ui.body.dataset.theme = theme;
  if (ui.themeToggle) {
    ui.themeToggle.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    ui.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  ui.themeMeta?.setAttribute('content', theme === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
}

function preferredTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

function updateLogStream() {
  if (!('EventSource' in window) || page === 'template' || runtime.usingMockFallback) {
    runtime.eventSource?.close();
    runtime.eventSource = null;
    return;
  }
  if (runtime.eventSource) return;

  runtime.eventSource = new EventSource('./api/logs/stream');
  runtime.eventSource.onopen = () => {
    runtime.streamWarningShown = false;
    if (ui.statusBanner?.dataset.tone === 'warn' && /log stream/i.test(ui.statusBanner.textContent)) {
      setStatus('', 'info');
    }
  };
  runtime.eventSource.onmessage = event => {
    try {
      const payload = JSON.parse(event.data);
      pushLiveLog(normalizeLog(payload));
    } catch {
      pushLiveLog(
        normalizeLog({
          stream: 'Runtime',
          level: 'info',
          message: String(event.data || '').trim() || 'Received log event.'
        })
      );
    }
  };
  runtime.eventSource.onerror = () => {
    if (runtime.streamWarningShown) return;
    runtime.streamWarningShown = true;
    setStatus('Live log stream reconnecting; recent lines will resume when /api/logs/stream recovers.', 'warn');
  };
}

function applyStartupStatus() {
  if (runtime.usingMockFallback) return;
  const diagnostics = runtime.state.diagnostics;
  const actionable = Array.isArray(diagnostics?.checks)
    ? diagnostics.checks.filter(check => check.status !== 'ok')
    : [];
  if (actionable.length === 0) return;
  setStatus(
    actionable.map(check => `${check.label}: ${check.summary}`).join(' '),
    diagnostics.status === 'error' ? 'error' : 'warn'
  );
}

function renderAll() {
  renderHeader();
  renderHero();
  renderSummary();
  renderLauncher();
  renderFilters();
  renderServices();
  renderPwa();
  renderDiagnostics();
  renderTools();
  renderPhase2();
  renderLogTabs();
  renderLogs();
  renderLogViewer();
  renderPorts();
  renderResources();
  renderProcessDetail();
  renderConstraints();
  renderTimeline();
  renderFooter();
  updateNavState();
}

function renderHeader() {
  if (ui.appName) ui.appName.textContent = runtime.state.app.name;
  if (ui.appSubtitle) ui.appSubtitle.textContent = runtime.state.app.subtitle;
  if (ui.search && ui.search.value !== runtime.query) ui.search.value = runtime.query;
}

function renderHero() {
  if (ui.heroEyebrow) ui.heroEyebrow.textContent = runtime.state.hero.eyebrow;
  if (ui.heroTitle) ui.heroTitle.textContent = runtime.state.hero.title;
  if (ui.heroBody) ui.heroBody.textContent = runtime.state.hero.body;
  renderPills(ui.heroPills, [runtime.state.app.scope, runtime.state.pwa.install, runtime.state.pwa.serviceWorker]);
  if (ui.snapshotValue) ui.snapshotValue.textContent = runtime.state.snapshot.value;
  if (ui.snapshotDetail) ui.snapshotDetail.textContent = runtime.state.snapshot.detail;
  renderPills(ui.snapshotPills, [runtime.state.pwa.manifest, runtime.state.pwa.offline]);
}

function renderSummary() {
  if (!ui.summaryGrid) return;
  ui.summaryGrid.innerHTML = runtime.state.stats
    .map(
      stat => `
        <div class="summary-card">
          <strong>${escapeHtml(stat.value)}</strong>
          <span>${escapeHtml(stat.label)} — ${escapeHtml(stat.detail)}</span>
        </div>
      `
    )
    .join('');
}

function renderLauncher() {
  if (!ui.launcherGrid) return;
  const cards = typeof config.surfaceCards === 'function' ? config.surfaceCards(runtime.state) : [];
  ui.launcherGrid.innerHTML = cards
    .map(
      card => `
        <article class="launch-card">
          <div>
            <strong>${escapeHtml(card.title)}</strong>
            <p>${escapeHtml(card.detail)}</p>
          </div>
          <div class="inline-meta">
            <span class="pill">${escapeHtml(card.meta)}</span>
          </div>
          <div class="card-actions">
            <a class="ghost action-link" href="${escapeAttribute(card.href)}">${escapeHtml(card.cta)}</a>
          </div>
        </article>
      `
    )
    .join('');
}

function renderFilters() {
  if (!ui.filterRow) return;
  ui.filterRow.innerHTML = runtime.state.filters
    .map(
      filter => `
        <button class="chip${runtime.activeFilter === filter.value ? ' is-active' : ''}" type="button" data-filter="${escapeAttribute(filter.value)}">
          ${escapeHtml(filter.label)}
        </button>
      `
    )
    .join('');
}

function renderServices() {
  if (!ui.serviceGrid) return;
  const services = getVisibleServices();
  ui.servicesEmpty.hidden = services.length > 0;
  ui.serviceGrid.innerHTML = services
    .map(service => buildServiceCard(service))
    .join('');
}

function renderPwa() {
  if (!ui.pwaGrid) return;
  const cards = [
    {
      strong: runtime.state.pwa.manifest,
      detail: 'Web App Manifest present and scoped to the LocalLink shell.'
    },
    {
      strong: runtime.state.pwa.serviceWorker,
      detail: 'Offline shell cached for quick relaunch and predictable startup.'
    },
    {
      strong: runtime.state.pwa.offline,
      detail: 'Shell assets stay local-first so installability remains obvious.'
    },
    {
      strong: runtime.state.pwa.scope,
      detail: 'Bound to localhost to keep the Phase 1 control plane local only.'
    }
  ];
  ui.pwaGrid.innerHTML = cards
    .map(
      card => `
        <div class="mini-card">
          <strong>${escapeHtml(card.strong)}</strong>
          <span>${escapeHtml(card.detail)}</span>
        </div>
      `
    )
    .join('');
}

function renderDiagnostics() {
  if (!ui.diagnosticsGrid) return;
  const diagnostics = runtime.state.diagnostics || { summary: '', checks: [] };
  const checks = Array.isArray(diagnostics.checks) ? diagnostics.checks : [];
  ui.diagnosticsGrid.innerHTML = checks
    .map(
      check => `
        <div class="mini-card" data-tone="${escapeAttribute(check.status || 'ok')}">
          <strong>${escapeHtml(check.label || 'Startup check')}</strong>
          <span>${escapeHtml(check.summary || diagnostics.summary || 'No summary available.')}</span>
          <span>${escapeHtml(check.detail || '')}</span>
        </div>
      `
    )
    .join('');
}

function renderTools() {
  if (!ui.toolsList) return;
  ui.toolsList.innerHTML = runtime.state.tools
    .map(
      tool => `
        <div class="tool-card">
          <strong>${escapeHtml(tool.name)}</strong>
          <code>Input: ${escapeHtml(tool.input)}</code>
          <p>${escapeHtml(tool.detail)}</p>
        </div>
      `
    )
    .join('');
}

function renderPhase2() {
  if (!ui.phase2Grid) return;
  const advisor = runtime.state.phase2 || { summary: '', options: [] };
  const options = Array.isArray(advisor.options) ? advisor.options : [];
  const summaryCard = advisor.summary
    ? `
      <div class="mini-card" data-tone="${escapeAttribute(advisor.enabled === false ? 'off' : 'ok')}">
        <strong>Phase 2 summary</strong>
        <span>${escapeHtml(advisor.summary)}</span>
      </div>
    `
    : '';

  ui.phase2Grid.innerHTML = [summaryCard]
    .concat(options
    .map(
      option => `
        <div class="mini-card" data-tone="${escapeAttribute(mapOptionStatusTone(option.status))}">
          <strong>${escapeHtml(option.title)}</strong>
          <span>${escapeHtml(option.detail)}</span>
          ${option.detectedValue ? `<span>Detected: ${escapeHtml(option.detectedValue)}</span>` : ''}
          ${
            option.docsUrl
              ? `<div class="card-actions"><a class="ghost action-link" href="${escapeAttribute(option.docsUrl)}" target="_blank" rel="noreferrer">Docs</a></div>`
              : ''
          }
        </div>
      `
    ))
    .join('');
}

function renderLogTabs() {
  const tabsMarkup = LOG_TABS.map(
    tab => `
      <button class="tab${runtime.activeLogTab === tab.value ? ' is-active' : ''}" type="button" data-log-tab="${escapeAttribute(tab.value)}">
        ${escapeHtml(tab.label)}
      </button>
    `
  ).join('');

  if (ui.logTabs) {
    ui.logTabs.innerHTML = tabsMarkup;
  }
  if (ui.logViewerTabs) {
    ui.logViewerTabs.innerHTML = tabsMarkup;
  }
}

function renderLogs() {
  if (!ui.logList) return;
  const logs = getVisibleLogs();
  ui.logsEmpty.hidden = logs.length > 0;
  ui.logList.innerHTML = logs
    .map(
      log => `
        <div class="log-line" data-level="${escapeAttribute(log.level)}">
          <span class="log-time">${escapeHtml(log.time)}</span>
          <span class="log-stream">${escapeHtml(log.stream)}</span>
          <span class="log-message">${escapeHtml(log.message)}</span>
        </div>
      `
    )
    .join('');
}

function renderLogViewer() {
  if (!ui.logViewer || !ui.logViewerList) return;

  const logs = getVisibleLogs({
    query: runtime.logViewerQuery,
    timeFilter: runtime.logViewerTimeFilter
  });

  if (ui.logViewerSearch && ui.logViewerSearch.value !== runtime.logViewerQuery) {
    ui.logViewerSearch.value = runtime.logViewerQuery;
  }
  if (ui.logViewerTimeFilter && ui.logViewerTimeFilter.value !== runtime.logViewerTimeFilter) {
    ui.logViewerTimeFilter.value = runtime.logViewerTimeFilter;
  }
  if (ui.logViewerSummary) {
    ui.logViewerSummary.textContent = `${logs.length} log lines · ${describeLogTab(runtime.activeLogTab)} · ${describeTimeFilter(runtime.logViewerTimeFilter)}.`;
  }
  if (ui.logViewerEmpty) {
    ui.logViewerEmpty.hidden = logs.length > 0;
  }

  ui.logViewerList.innerHTML = logs
    .map(
      log => `
        <div class="log-line is-detailed" data-level="${escapeAttribute(log.level)}">
          <span class="log-time">${escapeHtml(formatDetailedLogTime(log.timestamp, log.time))}</span>
          <span class="log-stream">${escapeHtml(log.stream)}</span>
          <span class="log-level">${escapeHtml(log.level)}</span>
          <span class="log-message">${escapeHtml(log.message)}</span>
        </div>
      `
    )
    .join('');
}

function renderPorts() {
  const ports = runtime.state.ports;
  if (ui.nextPort) ui.nextPort.textContent = String(ports.nextFree);
  if (ui.portStartLabel) ui.portStartLabel.textContent = `Start scanning from ${ports.startFrom}`;
  if (ui.portInput && document.activeElement !== ui.portInput) ui.portInput.value = String(ports.startFrom);
  if (ui.portBusy) ui.portBusy.textContent = `Busy: ${ports.busyText}`;
  if (ui.portRule) ui.portRule.textContent = `Rule: ${ports.rule}`;
  if (!ui.portRecent) return;

  const query = runtime.query;
  const visibleRows = ports.recent.filter(entry => {
    if (!query) return true;
    return `${entry.service} ${entry.port} ${entry.status}`.toLowerCase().includes(query);
  });
  ui.portEmpty.hidden = visibleRows.length > 0;
  ui.portRecent.innerHTML = visibleRows
    .map(
      entry => `
        <div class="table-row">
          <span>${escapeHtml(entry.service)}</span>
          <span class="mono">${escapeHtml(entry.port)}</span>
          <span>${escapeHtml(entry.status)}</span>
        </div>
      `
    )
    .join('');
}

function renderResources() {
  if (ui.resourceSummary) {
    ui.resourceSummary.innerHTML = (runtime.state.resources?.summary || [])
      .map(
        stat => `
          <div class="summary-card">
            <strong>${escapeHtml(stat.value)}</strong>
            <span>${escapeHtml(stat.label)} — ${escapeHtml(stat.detail)}</span>
          </div>
        `
      )
      .join('');
  }

  if (!ui.processTable) return;
  const query = runtime.query;
  const visibleProcesses = (runtime.state.resources?.processes || []).filter(process => {
    if (!query) return true;
    return `${process.name} ${process.command} ${process.pid} ${process.cpu} ${process.memory} ${process.reason}`.toLowerCase().includes(query);
  });

  if (ui.processEmpty) {
    ui.processEmpty.hidden = visibleProcesses.length > 0;
  }

  ui.processTable.innerHTML = visibleProcesses.map(process => buildProcessRow(process)).join('');
}

function renderProcessDetail() {
  if (!ui.processDetail || !ui.processDetailEmpty) return;
  if (!runtime.selectedProcess) {
    ui.processDetail.hidden = true;
    ui.processDetailEmpty.hidden = false;
    ui.processDetail.innerHTML = '';
    return;
  }

  const disableActions = liveApiUnavailable() || runtime.pendingProcessIds.has(runtime.selectedProcess.pid);
  ui.processDetail.hidden = false;
  ui.processDetailEmpty.hidden = true;
  ui.processDetail.innerHTML = `
    <div class="mini-card">
      <strong>${escapeHtml(runtime.selectedProcess.name)}</strong>
      <span>PID ${escapeHtml(String(runtime.selectedProcess.pid))} · Parent ${escapeHtml(runtime.selectedProcess.parentPid > 0 ? String(runtime.selectedProcess.parentPid) : '—')}</span>
      <span>CPU ${escapeHtml(runtime.selectedProcess.cpu)} · RAM ${escapeHtml(runtime.selectedProcess.memory)} · Uptime ${escapeHtml(runtime.selectedProcess.uptime)}</span>
      <span>Started ${escapeHtml(runtime.selectedProcess.started)}</span>
      <span>${escapeHtml(runtime.selectedProcess.command)}</span>
      <div class="card-actions">
        <button class="ghost" type="button" data-process-terminate="${escapeAttribute(String(runtime.selectedProcess.pid))}"${disableActions ? ' disabled' : ''}>Terminate</button>
      </div>
    </div>
  `;
}

function mapOptionStatusTone(status) {
  if (status === 'available') return 'ok';
  if (status === 'disabled') return 'off';
  return 'warn';
}

function buildProcessRow(process) {
  const disableActions = runtime.pendingProcessIds.has(process.pid) || liveApiUnavailable();
  return `
    <div class="table-row process-row" data-tone="${escapeAttribute(process.tone)}">
      <span>
        <strong>${escapeHtml(process.name)}</strong>
        <small>PID ${escapeHtml(String(process.pid))} · ${escapeHtml(process.reason)}</small>
      </span>
      <span class="mono">${escapeHtml(process.cpu)}</span>
      <span class="mono">${escapeHtml(process.memory)}</span>
      <span>${escapeHtml(process.uptime)}</span>
      <div class="card-actions">
        <button class="ghost" type="button" data-process-inspect="${escapeAttribute(String(process.pid))}"${disableActions ? ' disabled' : ''}>Inspect</button>
        <button class="ghost" type="button" data-process-terminate="${escapeAttribute(String(process.pid))}"${disableActions ? ' disabled' : ''}>Terminate</button>
      </div>
    </div>
  `;
}

function renderConstraints() {
  if (!ui.constraintsGrid) return;
  ui.constraintsGrid.innerHTML = runtime.state.constraints
    .map(
      item => `
        <div class="mini-card">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.detail)}</span>
        </div>
      `
    )
    .join('');
}

function renderTimeline() {
  if (!ui.timelineGrid) return;
  ui.timelineGrid.innerHTML = runtime.state.timeline
    .map(
      item => `
        <div class="mini-card">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.detail)}</span>
        </div>
      `
    )
    .join('');
}

function renderFooter() {
  if (ui.footerNote) {
    ui.footerNote.textContent = runtime.state.footerNote || DEFAULT_FOOTER;
  }
}

function focusServiceCard(serviceName) {
  if (!serviceName) return;

  const targetService = runtime.state.services.find(service => service.name === serviceName);
  if (!targetService) {
    setStatus(`Service "${serviceName}" is not declared in the current snapshot.`, 'warn');
    return;
  }

  runtime.query = '';
  runtime.activeFilter = targetService.group || 'all';
  if (ui.search) ui.search.value = '';
  renderFilters();
  renderServices();
  setPanel('services');

  window.requestAnimationFrame(() => {
    const cards = Array.from(document.querySelectorAll('[data-service-card]'));
    const targetCard = cards.find(card => card.dataset.name === serviceName);
    if (!targetCard) return;

    targetCard.classList.add('is-targeted');
    targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => targetCard.classList.remove('is-targeted'), 2200);
  });
}

function buildServiceReferenceRow(label, serviceNames) {
  if (!serviceNames?.length) return '';

  return `
    <div class="service-metadata-item service-metadata-item-links">
      <span>${escapeHtml(label)}</span>
      <div class="service-link-list">
        ${serviceNames
          .map(
            name => `
              <button class="service-link" type="button" data-focus-service="${escapeAttribute(name)}">
                ${escapeHtml(name)}
              </button>
            `
          )
          .join('')}
      </div>
    </div>
  `;
}

function buildMetadataRow(label, value, detail = '', tone = '') {
  if (!value) return '';

  return `
    <div class="service-metadata-item${tone ? ` ${escapeAttribute(tone)}` : ''}">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
    </div>
  `;
}

function complianceTone(status) {
  if (status === 'pass') return 'is-ok';
  if (status === 'warn') return 'is-warn';
  return '';
}

function buildServiceMetadata(service) {
  const rows = [
    buildMetadataRow('Dockerfile', service.blueprint?.dockerfilePath || ''),
    buildMetadataRow('EXPOSE', service.blueprint?.expose?.join(', ') || ''),
    buildServiceReferenceRow('Depends on', service.dependsOn),
    buildServiceReferenceRow('Downstream', service.downstream),
    buildMetadataRow('Env vars', service.envVars?.join(', ') || ''),
    service.compliance
      ? buildMetadataRow(
          'Blueprint compliance',
          `${String(service.compliance.status || 'skipped').toUpperCase()} — ${service.compliance.summary}`,
          service.compliance.issues?.join(' · ') || '',
          complianceTone(service.compliance.status)
        )
      : '',
  ].filter(Boolean);

  const docsLink = service.docsUrl
    ? `<a class="ghost action-link" href="${escapeAttribute(service.docsUrl)}" target="_blank" rel="noreferrer">Docs</a>`
    : '';

  if (rows.length === 0 && !docsLink) {
    return '';
  }

  return `
    <div class="service-metadata">
      ${rows.length > 0 ? `<div class="service-metadata-grid">${rows.join('')}</div>` : ''}
      ${docsLink ? `<div class="card-actions">${docsLink}</div>` : ''}
    </div>
  `;
}

function buildServiceCard(service) {
  const isPending = runtime.pendingServices.has(service.name);
  const disableActions = isPending || liveApiUnavailable();
  const statusLabel = isPending && service.statusTone === 'healthy' ? 'Updating' : service.statusLabel;
  const statusTone = isPending && service.statusTone === 'healthy' ? 'warn' : service.statusTone;
  return `
    <article class="service-card" data-service-card data-group="${escapeAttribute(service.group)}" data-name="${escapeAttribute(service.name)}">
      <div class="service-top">
        <div>
          <p class="service-name">${escapeHtml(service.name)}</p>
          <p class="service-kind">${escapeHtml(service.kind)} · ${escapeHtml(service.notes)}</p>
        </div>
        <span class="status ${escapeAttribute(statusTone)}${isPending ? ' is-updating' : ''}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="service-stats">
        <div><b>${escapeHtml(service.port)}</b><span>Port</span></div>
        <div><b>${escapeHtml(service.cpu)}</b><span>CPU</span></div>
        <div><b>${escapeHtml(service.memory)}</b><span>Memory</span></div>
        <div><b>${escapeHtml(service.uptime)}</b><span>Uptime</span></div>
      </div>
      <p class="service-notes">${escapeHtml(service.detail)}</p>
      ${buildServiceMetadata(service)}
      <div class="mono">${escapeHtml(service.tags)}</div>
      <div class="service-actions">
        <button class="ghost" type="button" data-command="start" data-runtime="${escapeAttribute(service.runtime)}" data-service="${escapeAttribute(service.name)}"${disableActions ? ' disabled' : ''}>Start</button>
        <button class="ghost" type="button" data-command="stop" data-runtime="${escapeAttribute(service.runtime)}" data-service="${escapeAttribute(service.name)}"${disableActions ? ' disabled' : ''}>Stop</button>
        <button class="primary" type="button" data-command="restart" data-runtime="${escapeAttribute(service.runtime)}" data-service="${escapeAttribute(service.name)}"${disableActions ? ' disabled' : ''}>Restart</button>
      </div>
    </article>
  `;
}

function getVisibleServices() {
  return runtime.state.services.filter(service => {
    const matchesFilter = runtime.activeFilter === 'all' || service.group === runtime.activeFilter;
    if (!matchesFilter) return false;
    if (!runtime.query) return true;
    return service.searchable.includes(runtime.query);
  });
}

function getVisibleLogs(options = {}) {
  const query = typeof options.query === 'string' ? options.query : runtime.query;
  const timeFilter = typeof options.timeFilter === 'string' ? options.timeFilter : 'all';

  return mergeLogs(runtime.liveLogs, runtime.state.logs).filter(log => {
    if (!matchesLogTab(log)) return false;
    if (!matchesTimeFilter(log, timeFilter)) return false;
    if (!query) return true;
    return `${log.time} ${log.stream} ${log.level} ${log.message}`.toLowerCase().includes(query);
  });
}

function matchesLogTab(log) {
  if (runtime.activeLogTab === 'all') return true;
  if (runtime.activeLogTab === 'lifecycle') return log.stream === 'Lifecycle';
  if (runtime.activeLogTab === 'runtime') {
    return ['Runtime', 'PM2', 'Docker'].includes(log.stream);
  }
  if (runtime.activeLogTab === 'alerts') return log.level !== 'info';
  return true;
}

function pushLiveLog(log) {
  runtime.liveLogs.unshift(log);
  runtime.liveLogs = mergeLogs(runtime.liveLogs, []).slice(0, 200);
  renderLogs();
  renderLogViewer();
}

function setLogViewerOpen(open) {
  runtime.logViewerOpen = open;
  if (!ui.logViewer) return;
  ui.logViewer.hidden = !open;
  ui.logViewer.setAttribute('aria-hidden', String(!open));
  if (open) {
    ui.body.dataset.logViewerOpen = 'true';
    if (ui.logViewerSearch) {
      if (!runtime.logViewerQuery && runtime.query) {
        runtime.logViewerQuery = runtime.query;
      }
      ui.logViewerSearch.focus();
      ui.logViewerSearch.select();
    }
    renderLogViewer();
    return;
  }

  delete ui.body.dataset.logViewerOpen;
}

function matchesTimeFilter(log, timeFilter) {
  if (!timeFilter || timeFilter === 'all') return true;

  const timestamp = Date.parse(log.timestamp || '');
  if (!Number.isFinite(timestamp)) return true;

  const ranges = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000
  };
  const maxAge = ranges[timeFilter];
  if (!maxAge) return true;
  return Date.now() - timestamp <= maxAge;
}

function describeLogTab(value) {
  return LOG_TABS.find(tab => tab.value === value)?.label || 'All';
}

function describeTimeFilter(value) {
  switch (value) {
    case '15m':
      return 'last 15 minutes';
    case '1h':
      return 'last 1 hour';
    case '6h':
      return 'last 6 hours';
    case '24h':
      return 'last 24 hours';
    default:
      return 'all time';
  }
}

function formatDetailedLogTime(timestamp, fallbackTime) {
  const parsed = Date.parse(timestamp || '');
  if (!Number.isFinite(parsed)) return fallbackTime || 'Unknown time';
  return new Date(parsed).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function setPanel(name) {
  ui.body.dataset.focusPanel = name;
  updateNavState();
  const target = name === 'overview'
    ? document.querySelector('.hero')
    : document.querySelector(`[data-shell-panel="${name}"]`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateNavState() {
  const active = ui.body.dataset.focusPanel || 'overview';
  document.querySelectorAll('[data-panel]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.panel === active);
  });
}

async function handlePortRequest(startFrom) {
  if (!Number.isFinite(startFrom) || startFrom < 1024) {
    setStatus('Port scans must start from a valid port number above 1023.', 'error');
    return;
  }

  if (hasLiveApiConnection()) {
    try {
      const response = await postJson('./api/ports/next', { startFrom });
      applyPortResponse(response, startFrom);
      setStatus(`Next free port resolved from /api/ports/next: ${runtime.state.ports.nextFree}.`, 'info');
      pushLiveLog(
        normalizeLog({
          stream: 'Runtime',
          level: 'info',
          message: `Port scan resolved ${runtime.state.ports.nextFree} as the next free slot.`
        })
      );
      return;
    } catch (error) {
      setStatus('Port endpoint unavailable; reconnect /api/ports/next to resume live allocation.', 'warn');
      return;
    }
  }

  if (config.usesApi) {
    setStatus('Port allocation is unavailable until /api/ports/next reconnects.', 'warn');
    return;
  }

  const nextFree = computeNextFreePort(startFrom, runtime.state.ports.busy);
  runtime.state.ports = normalizePorts({
    ...runtime.state.ports,
    startFrom,
    nextFree,
    recent: buildRecentPorts(startFrom, nextFree, runtime.state.ports.recent, runtime.state.ports.busy)
  });
  syncDerivedState(runtime.state);
  renderSummary();
  renderPorts();
  pushLiveLog(
    normalizeLog({
      stream: 'Runtime',
      level: 'info',
      message: `Port scan resolved ${nextFree} as the next free slot.`
    })
  );
}

function applyPortResponse(response, startFrom) {
  runtime.state.ports = normalizePorts({
    ...runtime.state.ports,
    ...response,
    startFrom: Number(response?.startFrom ?? startFrom)
  });
  syncDerivedState(runtime.state);
  if (hasLiveApiConnection()) {
    persistLiveSnapshot(runtime.state);
  }
  renderSummary();
  renderPorts();
}

async function handleServiceCommand(button) {
  const serviceName = button.dataset.service;
  const action = button.dataset.command;
  const runtimeName = button.dataset.runtime || inferRuntime(serviceName);
  if (!serviceName || !action) return;

  if (liveApiUnavailable()) {
    setStatus('Service actions are unavailable until /api/tasks reconnects.', 'warn');
    pushLiveLog(
      normalizeLog({
        stream: 'Alerts',
        level: 'warn',
        message: `Cannot ${action} ${serviceName} while the live API is unavailable.`
      })
    );
    return;
  }

  runtime.pendingServices.add(serviceName);
  renderServices();

  const optimisticRequested = `${serviceName} ${action} requested from the current surface.`;
  pushLiveLog(normalizeLog({ stream: 'Lifecycle', level: action === 'restart' ? 'warn' : 'info', message: optimisticRequested }));

  try {
    if (hasLiveApiConnection()) {
      const response = await postJson('./api/tasks', {
        runtime: runtimeName,
        serviceName,
        action
      });
      applyTaskResponse(serviceName, action, response);
      await loadState();
    } else {
      await applyLocalServiceAction(serviceName, action);
    }
  } catch (error) {
    setStatus(`Task action failed for ${serviceName}: ${error.message}.`, 'error');
    pushLiveLog(normalizeLog({ stream: 'Alerts', level: 'error', message: `${serviceName} ${action} failed: ${error.message}.` }));
  } finally {
    runtime.pendingServices.delete(serviceName);
    renderServices();
  }
}

async function handleProcessInspect(button) {
  const pid = Number(button.dataset.processInspect || 0);
  if (!Number.isFinite(pid) || pid <= 0) return;

  const currentProcess = runtime.state.resources.processes.find(entry => entry.pid === pid);
  runtime.selectedProcess = currentProcess
    ? {
        pid: currentProcess.pid,
        parentPid: 0,
        name: currentProcess.name,
        command: currentProcess.command,
        cpu: currentProcess.cpu,
        cpuPercent: currentProcess.cpuPercent,
        memory: currentProcess.memory,
        memoryMb: currentProcess.memoryMb,
        uptime: currentProcess.uptime,
        started: 'Inspecting live process…'
      }
    : runtime.selectedProcess;
  renderProcessDetail();

  runtime.pendingProcessIds.add(pid);
  renderResources();

  try {
    if (!config.usesApi) {
      runtime.selectedProcess = currentProcess
        ? { ...runtime.selectedProcess, started: 'Unavailable in preview mode' }
        : null;
      renderProcessDetail();
      return;
    }

    if (liveApiUnavailable()) {
      setStatus('Process inspection is unavailable until /api/processes reconnects.', 'warn');
      runtime.selectedProcess = currentProcess
        ? { ...runtime.selectedProcess, started: 'Live inspection unavailable while the API reconnects.' }
        : null;
      renderProcessDetail();
      return;
    }

    runtime.selectedProcess = await fetchJson(`./api/processes/${pid}`);
    renderProcessDetail();
  } catch (error) {
    setStatus(`Unable to inspect process ${pid}: ${error.message}.`, 'warn');
    if (runtime.selectedProcess && runtime.selectedProcess.pid === pid) {
      runtime.selectedProcess = {
        ...runtime.selectedProcess,
        started: 'The process changed before the detailed inspection completed.'
      };
      renderProcessDetail();
    }
  } finally {
    runtime.pendingProcessIds.delete(pid);
    renderResources();
  }
}

async function handleProcessTerminate(button) {
  const pid = Number(button.dataset.processTerminate || 0);
  if (!Number.isFinite(pid) || pid <= 0) return;

  runtime.pendingProcessIds.add(pid);
  renderResources();
  renderProcessDetail();

  try {
    if (!config.usesApi) {
      setStatus('Process termination is only available when the live API is connected.', 'warn');
      return;
    }

    if (liveApiUnavailable()) {
      setStatus('Process termination is unavailable until /api/processes reconnects.', 'warn');
      return;
    }

    const response = await postJson(`./api/processes/${pid}/terminate`, { signal: 'SIGTERM' });
    const stateFromResponse = extractStatePayload(response);
    if (stateFromResponse) {
      runtime.state = applyPageOverrides(normalizeState(stateFromResponse));
      persistLiveSnapshot(runtime.state);
    }
    runtime.selectedProcess = runtime.selectedProcess?.pid === pid ? null : runtime.selectedProcess;
    setStatus(response.result?.message || `Process ${pid} was asked to terminate.`, 'warn');
    renderAll();
  } catch (error) {
    setStatus(`Unable to terminate process ${pid}: ${error.message}.`, 'error');
  } finally {
    runtime.pendingProcessIds.delete(pid);
    renderResources();
    renderProcessDetail();
  }
}

function applyTaskResponse(serviceName, action, response) {
  const stateFromResponse = extractStatePayload(response);
  if (stateFromResponse) {
    runtime.state = applyPageOverrides(normalizeState(stateFromResponse));
    persistLiveSnapshot(runtime.state);
  }

  const updatedService = extractServiceUpdate(response, serviceName);
  if (updatedService) {
    mergeService(updatedService);
  }

  const logs = extractLogs(response);
  if (logs.length === 0) {
    logs.push(
      normalizeLog({
        stream: 'Lifecycle',
        level: action === 'restart' ? 'warn' : 'info',
        message: `${serviceName} ${action} completed.`
      })
    );
  }
  logs.forEach(pushLiveLog);
  syncDerivedState(runtime.state);
  renderAll();
}

async function applyLocalServiceAction(serviceName, action) {
  const current = runtime.state.services.find(service => service.name === serviceName);
  if (!current) return;

  if (action === 'stop') {
    mergeService({ ...current, status: 'stopped', statusLabel: 'Down', statusTone: 'off', cpu: '0%', memory: '0 MB', uptime: '—' });
    pushLiveLog(normalizeLog({ stream: 'Lifecycle', level: 'warn', message: `${serviceName} stopped from the current surface.` }));
  }

  if (action === 'start') {
    mergeService({ ...current, status: 'running', statusLabel: 'Up', statusTone: 'healthy', uptime: current.uptime === '—' ? '1m' : current.uptime, memory: current.memory === '0 MB' ? '64 MB' : current.memory });
    pushLiveLog(normalizeLog({ stream: 'Lifecycle', level: 'info', message: `${serviceName} started from the current surface.` }));
  }

  if (action === 'restart') {
    mergeService({ ...current, status: 'running', statusLabel: 'Restarting', statusTone: 'warn' });
    renderServices();
    pushLiveLog(normalizeLog({ stream: 'Lifecycle', level: 'warn', message: `${serviceName} restart requested from the current surface.` }));
    await new Promise(resolve => {
      window.setTimeout(() => {
        mergeService({ ...current, status: 'running', statusLabel: 'Up', statusTone: 'healthy' });
        pushLiveLog(normalizeLog({ stream: 'Lifecycle', level: 'info', message: `${serviceName} recovered and reported healthy.` }));
        resolve();
      }, 900);
    });
    return;
  }

  syncDerivedState(runtime.state);
  renderAll();
}

function mergeService(serviceUpdate) {
  runtime.state.services = runtime.state.services.map(service =>
    service.name === serviceUpdate.name ? normalizeServices([{ ...service, ...serviceUpdate }])[0] : service
  );
  syncDerivedState(runtime.state);
}

function normalizeState(input = {}) {
  const merged = {
    ...cloneState(DEFAULT_STATE),
    ...input,
    app: { ...DEFAULT_STATE.app, ...(input.app || {}) },
    hero: { ...DEFAULT_STATE.hero, ...(input.hero || {}) },
    snapshot: { ...DEFAULT_STATE.snapshot, ...(input.snapshot || {}) },
    pwa: { ...DEFAULT_STATE.pwa, ...(input.pwa || {}) },
    diagnostics: normalizeDiagnostics(input.diagnostics || DEFAULT_STATE.diagnostics),
    phase2: normalizePhase2(input.phase2 || DEFAULT_STATE.phase2),
    resources: normalizeResources(input.resources || DEFAULT_STATE.resources)
  };

  merged.services = normalizeServices(Array.isArray(input.services) ? input.services : []);
  merged.filters = normalizeFilters(Array.isArray(input.filters) ? input.filters : [], merged.services);
  merged.tools = normalizeTools(Array.isArray(input.tools) ? input.tools : []);
  merged.logs = normalizeLogs(Array.isArray(input.logs) ? input.logs : []);
  merged.ports = normalizePorts(input.ports || {});
  merged.constraints = normalizeSimpleCards(Array.isArray(input.constraints) ? input.constraints : []);
  merged.timeline = normalizeSimpleCards(Array.isArray(input.timeline) ? input.timeline : []);
  merged.stats = normalizeStats(Array.isArray(input.stats) ? input.stats : []);
  syncDerivedState(merged);
  return merged;
}

function normalizeServices(services) {
  return services.map(raw => {
    const kind = String(raw.kind || raw.type || 'Service');
    const group = String(raw.group || deriveGroup(kind)).toLowerCase();
    const name = String(raw.name || 'Unnamed service');
    const runtimeName = String(raw.runtime || deriveRuntime(group)).toLowerCase();
    const statusLabel = String(raw.statusLabel || deriveStatusLabel(raw.status));
    const statusTone = String(raw.statusTone || deriveStatusTone(raw.status, statusLabel));
    const status = String(raw.status || deriveStatusValue(statusLabel)).toLowerCase();
    const normalized = {
      name,
      kind,
      group,
      runtime: runtimeName,
      status,
      statusLabel,
      statusTone,
      port: raw.port == null ? '—' : String(raw.port),
      cpu: String(raw.cpu || '—'),
      memory: String(raw.memory || '—'),
      uptime: String(raw.uptime || '—'),
      notes: String(raw.notes || 'Local runtime surface.'),
      detail: String(raw.detail || raw.notes || 'Runtime details pending.'),
      tags: String(raw.tags || `${group} · local`),
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      downstream: Array.isArray(raw.downstream) ? raw.downstream.map(String) : [],
      envVars: Array.isArray(raw.envVars) ? raw.envVars.map(String) : [],
      docsUrl: raw.docsUrl ? String(raw.docsUrl) : '',
      blueprint: raw.blueprint
        ? {
            dockerfilePath: String(raw.blueprint.dockerfilePath || ''),
            expose: Array.isArray(raw.blueprint.expose) ? raw.blueprint.expose.map(String) : [],
            envVars: Array.isArray(raw.blueprint.envVars) ? raw.blueprint.envVars.map(String) : [],
            command: String(raw.blueprint.command || '')
          }
        : null,
      compliance: raw.compliance
        ? {
            status: String(raw.compliance.status || 'skipped').toLowerCase(),
            summary: String(raw.compliance.summary || ''),
            issues: Array.isArray(raw.compliance.issues) ? raw.compliance.issues.map(String) : []
          }
        : null
    };
    normalized.searchable = `${normalized.name} ${normalized.kind} ${normalized.group} ${normalized.status} ${normalized.statusLabel} ${normalized.port} ${normalized.cpu} ${normalized.memory} ${normalized.uptime} ${normalized.notes} ${normalized.detail} ${normalized.tags} ${normalized.dependsOn.join(' ')} ${normalized.downstream.join(' ')} ${normalized.envVars.join(' ')} ${normalized.docsUrl} ${normalized.blueprint?.dockerfilePath || ''} ${normalized.blueprint?.expose?.join(' ') || ''} ${normalized.blueprint?.command || ''} ${normalized.compliance?.summary || ''} ${normalized.compliance?.issues?.join(' ') || ''}`.toLowerCase();
    return normalized;
  });
}

function normalizeFilters(filters, services) {
  const list = filters.length
    ? filters.map(filter => ({ label: String(filter.label || filter.value || 'All'), value: String(filter.value || 'all').toLowerCase() }))
    : deriveFiltersFromServices(services);
  const hasAll = list.some(filter => filter.value === 'all');
  const next = hasAll ? list : [{ label: 'All', value: 'all' }, ...list];
  return dedupeBy(next, item => item.value);
}

function normalizeTools(tools) {
  return tools.map(tool => ({
    name: String(tool.name || 'tool'),
    input: String(tool.input || 'None'),
    detail: String(tool.detail || 'No detail provided.')
  }));
}

function normalizeLogs(logs) {
  return logs.map(normalizeLog);
}

function normalizeLog(log) {
  const timestamp = normalizeLogTimestamp(log?.timestamp);
  const time = log?.time
    ? String(log.time)
    : new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const stream = String(log?.stream || 'Runtime');
  const level = ['info', 'warn', 'error'].includes(String(log?.level || '').toLowerCase()) ? String(log.level).toLowerCase() : 'info';
  const message = String(log?.message || 'No log message supplied.');
  return { timestamp, time, stream, level, message };
}

function normalizeLogTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return new Date().toISOString();
}

function normalizePorts(ports) {
  const busy = Array.isArray(ports.busy)
    ? ports.busy.map(value => Number(value)).filter(Number.isFinite)
    : [];
  const startFrom = Number(ports.startFrom) || 5000;
  const nextFree = Number(ports.nextFree) || computeNextFreePort(startFrom, busy);
  const recent = Array.isArray(ports.recent)
    ? ports.recent.map(entry => ({
        service: String(entry.service || 'unknown'),
        port: String(entry.port || '—'),
        status: String(entry.status || 'pending')
      }))
    : buildRecentPorts(startFrom, nextFree, [], busy);
  return {
    startFrom,
    nextFree,
    busy,
    busyText: String(ports.busyText || (busy.length ? busy.join(', ') : 'None')),
    rule: String(ports.rule || `First free port above ${startFrom}`),
    recent
  };
}

function normalizeSimpleCards(items) {
  return items.map(item => ({
    title: String(item.title || 'Item'),
    detail: String(item.detail || '')
  }));
}

function normalizeStats(stats) {
  return stats.map(stat => ({
    label: String(stat.label || 'Metric'),
    value: String(stat.value || '—'),
    detail: String(stat.detail || '')
  }));
}

function normalizeDiagnostics(input) {
  const checks = Array.isArray(input?.checks)
    ? input.checks.map(check => ({
        id: String(check.id || check.label || 'check'),
        label: String(check.label || 'Startup check'),
        status: ['ok', 'warn', 'error'].includes(String(check.status || '').toLowerCase())
          ? String(check.status).toLowerCase()
          : 'ok',
        summary: String(check.summary || 'No summary available.'),
        detail: String(check.detail || '')
      }))
    : [];
  const status = ['ok', 'warn', 'error'].includes(String(input?.status || '').toLowerCase())
    ? String(input.status).toLowerCase()
    : checks.some(check => check.status === 'error')
      ? 'error'
      : checks.some(check => check.status === 'warn')
        ? 'warn'
        : 'ok';

  return {
    status,
    summary: String(input?.summary || 'All startup checks passed.'),
    checks
  };
}

function normalizePhase2(input) {
  return {
    enabled: input?.enabled !== false,
    summary: String(input?.summary || ''),
    options: Array.isArray(input?.options)
      ? input.options.map(option => ({
          id: String(option.id || option.title || 'option'),
          title: String(option.title || 'Option'),
          detail: String(option.detail || ''),
          status: ['available', 'optional', 'unavailable', 'disabled'].includes(String(option.status || '').toLowerCase())
            ? String(option.status).toLowerCase()
            : 'optional',
          recommended: Boolean(option.recommended),
          docsUrl: option.docsUrl ? String(option.docsUrl) : '',
          detectedValue: option.detectedValue ? String(option.detectedValue) : ''
        }))
      : []
  };
}

function normalizeResources(input) {
  return {
    summary: normalizeStats(Array.isArray(input?.summary) ? input.summary : []),
    processes: Array.isArray(input?.processes)
      ? input.processes.map(process => ({
          pid: Number(process.pid) || 0,
          name: String(process.name || 'process'),
          command: String(process.command || ''),
          cpu: String(process.cpu || '0%'),
          cpuPercent: Number(process.cpuPercent) || 0,
          memory: String(process.memory || '0 MB'),
          memoryMb: Number(process.memoryMb) || 0,
          uptime: String(process.uptime || '—'),
          tone: ['warn', 'healthy', 'off'].includes(String(process.tone || '').toLowerCase())
            ? String(process.tone).toLowerCase()
            : 'healthy',
          reason: String(process.reason || 'Normal')
        }))
      : []
  };
}

function syncDerivedState(state) {
  const totalServices = state.services.length;
  const healthyServices = state.services.filter(service => service.statusTone === 'healthy').length;
  const alertServices = state.services.filter(service => service.statusTone !== 'healthy').length;
  const tracked = findStat(state.stats, 'tracked services');
  const healthy = findStat(state.stats, 'healthy');
  const alerts = findStat(state.stats, 'alerts');
  const nextPort = findStat(state.stats, 'next free port');
  state.snapshot.value = `${totalServices} services`;
  state.stats = [
    {
      label: tracked?.label || 'Tracked services',
      value: String(totalServices),
      detail: tracked?.detail || 'Docker + PM2 + Windows'
    },
    {
      label: healthy?.label || 'Healthy',
      value: String(healthyServices),
      detail: healthy?.detail || 'Up right now'
    },
    {
      label: alerts?.label || 'Alerts',
      value: String(alertServices),
      detail: alerts?.detail || 'Needs attention'
    },
    {
      label: nextPort?.label || 'Next free port',
      value: String(state.ports.nextFree),
      detail: nextPort?.detail || `Start above ${state.ports.startFrom}`
    }
  ];
}

function extractStatePayload(response) {
  if (!response || typeof response !== 'object') return null;
  const keys = ['app', 'hero', 'snapshot', 'stats', 'pwa', 'diagnostics', 'phase2', 'filters', 'services', 'tools', 'logs', 'ports', 'resources', 'constraints', 'timeline'];
  if (keys.some(key => key in response)) return { ...runtime.state, ...response };
  for (const key of ['state', 'snapshot', 'data']) {
    if (response[key] && typeof response[key] === 'object' && keys.some(prop => prop in response[key])) {
      return { ...runtime.state, ...response[key] };
    }
  }
  return null;
}

function extractServiceUpdate(response, serviceName) {
  if (!response || typeof response !== 'object') return null;
  const candidates = [response.service, response.updatedService, response.serviceState];
  if (Array.isArray(response.services)) candidates.push(...response.services);
  for (const containerKey of ['state', 'snapshot', 'data']) {
    const nested = response[containerKey];
    if (nested?.service) candidates.push(nested.service);
    if (Array.isArray(nested?.services)) candidates.push(...nested.services);
  }
  const match = candidates.find(candidate => candidate && String(candidate.name || '') === serviceName);
  return match ? normalizeServices([match])[0] : null;
}

function extractLogs(response) {
  if (!response || typeof response !== 'object') return [];
  const raw = [response.logs, response.logLines, response.lines, response.events]
    .concat(['state', 'snapshot', 'data'].flatMap(key => [response[key]?.logs, response[key]?.logLines, response[key]?.lines]))
    .find(candidate => Array.isArray(candidate));
  if (!raw) return [];
  return raw.map(entry => (typeof entry === 'string' ? normalizeLog({ stream: 'Lifecycle', level: 'info', message: entry }) : normalizeLog(entry)));
}

function computeNextFreePort(startFrom, busy) {
  let port = Number(startFrom) || 5000;
  const busySet = new Set((busy || []).map(value => Number(value)).filter(Number.isFinite));
  while (busySet.has(port)) port += 1;
  return port;
}

function buildRecentPorts(startFrom, nextFree, existing = [], busy = []) {
  const preserved = Array.isArray(existing)
    ? existing.filter(entry => String(entry.status).toLowerCase() !== 'suggested').slice(0, 4)
    : [];
  const rows = preserved.length
    ? preserved
    : busy.slice(0, 4).map(port => ({ service: `bound service ${port}`, port: String(port), status: 'occupied' }));
  return [...rows, { service: 'next open port', port: String(nextFree), status: 'suggested' }].slice(0, 5);
}

function deriveFiltersFromServices(services) {
  const groups = dedupeBy(
    services.map(service => ({ label: formatGroupLabel(service.group), value: service.group })),
    item => item.value
  );
  return [{ label: 'All', value: 'all' }, ...groups];
}

function deriveGroup(kind) {
  const lower = String(kind || '').toLowerCase();
  if (lower.includes('docker')) return 'docker';
  if (lower.includes('pm2')) return 'pm2';
  if (lower.includes('windows')) return 'windows';
  if (lower.includes('pwa') || lower.includes('vite')) return 'pwa';
  return 'all';
}

function deriveRuntime(group) {
  if (group === 'docker') return 'docker';
  if (group === 'windows') return 'taskfile';
  return 'pm2';
}

function deriveStatusLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'running' || value === 'healthy') return 'Up';
  if (value === 'stopped' || value === 'down' || value === 'off') return 'Down';
  if (value === 'restarting' || value === 'pending' || value === 'degraded') return 'Restarting';
  if (value === 'unknown') return 'Unknown';
  return 'Unknown';
}

function deriveStatusValue(label) {
  const value = String(label || '').toLowerCase();
  if (value.includes('up')) return 'running';
  if (value.includes('down') || value.includes('off')) return 'stopped';
  if (value.includes('restart') || value.includes('pending')) return 'pending';
  if (value.includes('unknown')) return 'unknown';
  return 'unknown';
}

function deriveStatusTone(status, label) {
  const value = `${status || ''} ${label || ''}`.toLowerCase();
  if (value.includes('up') || value.includes('running') || value.includes('healthy')) return 'healthy';
  if (value.includes('unknown')) return 'warn';
  if (value.includes('restart') || value.includes('pending')) return 'warn';
  return 'off';
}

function findStat(stats, labelMatch) {
  return stats.find(stat => stat.label.toLowerCase().includes(labelMatch));
}

function formatGroupLabel(group) {
  if (group === 'pm2') return 'PM2';
  if (group === 'pwa') return 'PWAs';
  if (group === 'docker') return 'Docker';
  if (group === 'windows') return 'Windows';
  return group.charAt(0).toUpperCase() + group.slice(1);
}

function ensureActiveFilter(current, filters) {
  return filters.some(filter => filter.value === current) ? current : 'all';
}

function inferRuntime(serviceName) {
  return runtime.state.services.find(service => service.name === serviceName)?.runtime || 'local';
}

function renderPills(container, values) {
  if (!container) return;
  container.innerHTML = values
    .filter(Boolean)
    .map(value => `<span class="pill">${escapeHtml(String(value))}</span>`)
    .join('');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  return response.json();
}

function mergeLogs(primary, secondary) {
  const seen = new Set();
  return [...primary, ...secondary].filter(log => {
    const key = `${log.timestamp || log.time}|${log.stream}|${log.level}|${log.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeStorage(method, key, value) {
  try {
    if (method === 'getItem') return window.localStorage.getItem(key);
    if (method === 'setItem') return window.localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}
