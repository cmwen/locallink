import { useEffect, useMemo, useRef, useState } from 'react';

import {
  executeServiceAction,
  applyPrivateEdge,
  cancelVersionUpdate,
  inspectProcess,
  normalizeLog,
  normalizeState,
  persistTemporaryRuntime,
  planPrivateEdge,
  queueVersionUpdate,
  readDashboardState,
  readWorkspaceState,
  requestPort,
  reviewProcessTermination,
  terminateProcess,
} from './api';
import type {
  DashboardState,
  ExtensionInstallPlan,
  LogEntry,
  ProcessInspection,
  ProcessTerminationReview,
  ResourceProcess,
  ResourceScope,
  ServiceRecord,
  TaskAction,
} from './types';
import {
  filterServices,
  matchesWorkspaceQuery,
  selectVisibleService,
  serviceMatchReason,
  serviceNeedsAttention,
  type ServiceHealthFilter,
} from './view-model';

type View = 'current' | 'extensions' | 'resources';
type Theme = 'dark' | 'light';
type Source = 'api' | 'mock';
type KillTarget = { type: 'service'; service: ServiceRecord } | { type: 'process'; process: ResourceProcess | ProcessInspection };

const THEME_KEY = 'locallink-theme';
const VIEW_LABELS: Record<View, string> = {
  current: 'Services',
  extensions: 'Connections',
  resources: 'System',
};
const VIEW_PATHS: Record<View, string> = {
  current: '/current',
  extensions: '/extensions',
  resources: '/resources',
};
const PATH_VIEWS: Record<string, View> = {
  '/current': 'current',
  '/external': 'extensions',
  '/extensions': 'extensions',
  '/resources': 'resources',
};

const INITIAL_STATE = normalizeState();

function toneClass(tone: string | undefined): string {
  if (tone === 'healthy' || tone === 'ok' || tone === 'pass' || tone === 'available') return 'ok';
  if (tone === 'off' || tone === 'disabled') return 'muted';
  if (tone === 'error') return 'bad';
  return 'warn';
}

function actionLevel(action: TaskAction): LogEntry['level'] {
  return action === 'stop' || action === 'restart' ? 'warn' : 'info';
}

function formatPort(port: string | undefined): string {
  if (!port || port === '-') return '-';
  return port.startsWith(':') ? port : `:${port}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMemoryMb(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

function formatSampleWindow(sampleCount: number, intervalSeconds: number): string {
  const seconds = Math.max(0, sampleCount - 1) * intervalSeconds;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function documentationHost(url: string): string {
  if (url.startsWith('/')) return 'LocalLink documentation';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function viewFromPath(): View {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'extensions' || hash === 'resources' || hash === 'current') return hash;
  const pathView = PATH_VIEWS[window.location.pathname.replace(/\/$/, '') || '/'];
  if (pathView) return pathView;
  return 'current';
}

function syncWorkspacePath(view: View, mode: 'push' | 'replace' = 'push') {
  const path = VIEW_PATHS[view];
  const nextUrl = `${path}${window.location.search}`;
  if (window.location.pathname === path && !window.location.hash) return;
  window.history[mode === 'replace' ? 'replaceState' : 'pushState']({ view }, '', nextUrl);
}

export function App() {
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const [source, setSource] = useState<Source>('mock');
  const [view, setView] = useState<View>(() => viewFromPath());
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'));
  const [queries, setQueries] = useState<Record<View, string>>({ current: '', extensions: '', resources: '' });
  const [healthFilter, setHealthFilter] = useState<ServiceHealthFilter>('all');
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [mobileServiceDetail, setMobileServiceDetail] = useState(false);
  const [pendingServices, setPendingServices] = useState<Set<string>>(() => new Set());
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState('Loading workspace snapshot...');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [addTempOpen, setAddTempOpen] = useState(false);
  const [tempServices, setTempServices] = useState<ServiceRecord[]>([]);
  const [killTarget, setKillTarget] = useState<KillTarget | null>(null);
  const [killReview, setKillReview] = useState<ProcessTerminationReview | null>(null);
  const [killReason, setKillReason] = useState('');
  const [pauseLogs, setPauseLogs] = useState(false);
  const [selectedProcess, setSelectedProcess] = useState<ProcessInspection | null>(null);
  const [updateQueued, setUpdateQueued] = useState(false);
  const [queuedVersionId, setQueuedVersionId] = useState('');
  const [extensionPlan, setExtensionPlan] = useState<ExtensionInstallPlan | null>(null);
  const [extensionApplying, setExtensionApplying] = useState(false);
  const [edgeServiceSelection, setEdgeServiceSelection] = useState<string[]>([]);
  const [edgeSelectionTouched, setEdgeSelectionTouched] = useState(false);

  const services = useMemo(() => [...state.services, ...tempServices], [state.services, tempServices]);
  const logs = useMemo(() => [...liveLogs, ...state.logs].slice(0, 180), [liveLogs, state.logs]);
  const query = queries[view];

  function setActiveQuery(value: string) {
    setQueries((current) => ({ ...current, [view]: value }));
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    void refreshState();
  }, []);

  useEffect(() => {
    if (view !== 'resources' || source !== 'api') return undefined;

    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void readDashboardState()
        .then((result) => {
          setState(result.state);
          setSource(result.source);
          setLastUpdatedAt(new Date());
        })
        .catch(() => {
          setStatus('Resource sampling is retrying.');
        });
    }, Math.max(1, state.resources.system.sampleIntervalSeconds) * 1000);

    return () => window.clearInterval(interval);
  }, [source, state.resources.system.sampleIntervalSeconds, view]);

  useEffect(() => {
    const syncViewFromHistory = () => setView(viewFromPath());
    window.addEventListener('popstate', syncViewFromHistory);
    return () => window.removeEventListener('popstate', syncViewFromHistory);
  }, []);

  function changeView(nextView: View) {
    setView(nextView);
    syncWorkspacePath(nextView);
  }

  function openService(serviceId: string) {
    setQueries((current) => ({ ...current, current: '' }));
    setHealthFilter('all');
    setSelectedServiceId(serviceId);
    setMobileServiceDetail(true);
    changeView('current');
  }

  useEffect(() => {
    if (selectedServiceId && services.some((service) => service.id === selectedServiceId)) return;
    setSelectedServiceId(services[0]?.id || '');
  }, [selectedServiceId, services]);

  useEffect(() => {
    if (view !== 'resources' || source !== 'api' || pauseLogs || !('EventSource' in window)) return undefined;

    const eventSource = new EventSource('./api/logs/stream');
    eventSource.onmessage = (event) => {
      try {
        const entry = normalizeLog(JSON.parse(event.data) as Partial<LogEntry>);
        setLiveLogs((current) => [entry, ...current].slice(0, 120));
      } catch {
        setLiveLogs((current) => [normalizeLog({ message: event.data }), ...current].slice(0, 120));
      }
    };
    eventSource.onerror = () => {
      setStatus('Live log stream is reconnecting.');
    };

    return () => eventSource.close();
  }, [source, pauseLogs, view]);

  async function refreshState() {
    setLoading(true);
    try {
      const result = await readDashboardState();
      setSource(result.source);
      if (result.source === 'api') {
        const persisted = await readWorkspaceState();
        const activeReservations = persisted.portReservations
          .filter((reservation) => reservation.status === 'reserved')
          .map((reservation) => ({ service: reservation.service, port: String(reservation.port), status: 'reserved' }));
        setState(normalizeState({
          ...result.state,
          ports: {
            ...result.state.ports,
            recent: [...activeReservations, ...result.state.ports.recent.filter((entry) => !activeReservations.some((reservation) => reservation.port === entry.port))],
          },
        }));
        setUpdateQueued(persisted.versionUpdates.some((update) => update.status === 'queued'));
        setQueuedVersionId(persisted.versionUpdates.find((update) => update.status === 'queued')?.id || '');
        setTempServices(persisted.temporaryRuntimes.map((runtime) => ({
          id: runtime.id,
          name: runtime.name,
          kind: runtime.type,
          group: runtime.type.toLowerCase().includes('docker') ? 'docker' : 'pm2',
          runtime: runtime.type.toLowerCase().includes('docker') ? 'docker' : 'pm2',
          port: String(runtime.port),
          notes: 'Persisted temporary runtime plan.',
          detail: runtime.command,
          tags: `temporary / ${runtime.type.toLowerCase()}`,
          status: runtime.status === 'running' ? 'running' : runtime.status === 'stopped' ? 'stopped' : 'unknown',
          statusLabel: runtime.status === 'running' ? 'Up' : runtime.status === 'stopped' ? 'Down' : 'Unknown',
          statusTone: runtime.status === 'running' ? 'healthy' : runtime.status === 'stopped' ? 'off' : 'warn',
          cpu: '-', memory: '-', uptime: '-', envVars: [], dependsOn: [], downstream: [],
        })));
      } else {
        setState(result.state);
      }
      setLastUpdatedAt(new Date());
      setStatus(result.source === 'mock' ? 'Live API unavailable; showing sample workspace data.' : 'Snapshot refreshed.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to read dashboard state.');
    } finally {
      setLoading(false);
    }
  }

  function pushLocalLog(message: string, stream = 'Lifecycle', level: LogEntry['level'] = 'info') {
    setLiveLogs((current) => [normalizeLog({ message, stream, level }), ...current].slice(0, 120));
  }

  function updateServiceLocal(serviceName: string, patch: Partial<ServiceRecord>) {
    setState((current) =>
      normalizeState({
        ...current,
        services: current.services.map((service) => (service.name === serviceName ? { ...service, ...patch } : service)),
      }),
    );
    setTempServices((current) => current.map((service) => (service.name === serviceName ? { ...service, ...patch } : service)));
  }

  async function runServiceAction(service: ServiceRecord, action: TaskAction) {
    if (service.id.startsWith('temp-')) {
      setStatus(`${service.name} is a persisted runtime plan. Configure a launcher before running lifecycle actions.`);
      return;
    }
    if (!service.runtime) {
      setStatus(`${service.name} has no runtime action configured.`);
      return;
    }

    setPendingServices((current) => new Set(current).add(service.name));
    pushLocalLog(`${service.name} ${action} requested.`, 'Lifecycle', actionLevel(action));

    try {
      if (source === 'api' && !service.id.startsWith('temp-')) {
        const response = await executeServiceAction(service.name, service.runtime, action);
        if (response.snapshot) {
          setState(normalizeState(response.snapshot));
        } else {
          await refreshState();
        }
        setStatus(response.result?.ok ? `${service.name} ${action} completed.` : `${service.name} ${action} returned a warning.`);
        return;
      }

      updateServiceLocal(service.name, {
        status: action === 'stop' ? 'stopped' : 'running',
        statusLabel: action === 'stop' ? 'Down' : 'Up',
        statusTone: action === 'stop' ? 'off' : 'healthy',
        uptime: action === 'stop' ? '-' : service.uptime === '-' ? '<1m' : service.uptime,
      });
      setStatus(`${service.name} ${action} applied to this dashboard session.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `${service.name} ${action} failed.`);
      pushLocalLog(`${service.name} ${action} failed.`, 'Alerts', 'error');
    } finally {
      setPendingServices((current) => {
        const next = new Set(current);
        next.delete(service.name);
        return next;
      });
    }
  }

  async function allocatePort(startFrom = state.ports.startFrom) {
    try {
      if (source === 'api') {
        const ports = await requestPort(startFrom);
        setState((current) => normalizeState({ ...current, ports }));
        setStatus(`Next free port: ${ports.nextFree}.`);
        return;
      }

      setStatus('Port allocation needs the live API. Sample workspace data cannot reserve a port.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Port allocation failed.');
    }
  }

  async function inspect(process: ResourceProcess) {
    setSelectedProcess({
      ...process,
      parentPid: 0,
      started: 'Inspecting live process...',
      identityToken: `${process.pid}:pending`,
    });

    try {
      if (source === 'api') {
        setSelectedProcess(await inspectProcess(process.pid));
      } else {
        setSelectedProcess((current) => (current ? { ...current, started: 'Sample process snapshot' } : current));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Unable to inspect process ${process.pid}.`);
    }
  }

  async function confirmSafeStop() {
    if (!killTarget) return;

    try {
      if (killTarget.type === 'service') {
        await runServiceAction(killTarget.service, 'stop');
      } else if (source === 'api') {
        if (!killReview) {
          setStatus('Termination review is still loading.');
          return;
        }
        const response = await terminateProcess(killTarget.process.pid, killReview.identityToken, killReason);
        if (response.snapshot) setState(normalizeState(response.snapshot));
        setSelectedProcess(null);
        setStatus(response.result?.message || `Process ${killTarget.process.pid} was asked to terminate.`);
      } else {
        setStatus('Process termination needs the live API.');
      }
    } finally {
      setKillTarget(null);
      setKillReview(null);
      setKillReason('');
    }
  }

  async function openSafeStop(target: KillTarget) {
    setKillTarget(target);
    setKillReview(null);
    if (target.type === 'process' && source === 'api') {
      try {
        setKillReview(await reviewProcessTermination(target.process.pid));
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Unable to review this process.');
      }
    }
  }

  function addTemporaryRuntime(input: { type: string; port: string; command: string }) {
    const service: ServiceRecord = {
      id: `temp-${Date.now()}`,
      name: `Temp ${input.type} ${input.port || 'runtime'}`,
      kind: input.type,
      group: input.type.toLowerCase().includes('docker') ? 'docker' : 'pm2',
      runtime: input.type.toLowerCase().includes('docker') ? 'docker' : 'pm2',
      port: input.port || '-',
      notes: 'Temporary runtime staged from the dashboard.',
      detail: input.command || 'Command pending.',
      tags: `temporary / ${input.type.toLowerCase()}`,
      status: 'unknown',
      statusLabel: 'Unknown',
      statusTone: 'warn',
      cpu: '-',
      memory: '-',
      uptime: '-',
      envVars: [],
      dependsOn: [],
      downstream: [],
    };

    setTempServices((current) => [service, ...current]);
    setSelectedServiceId(service.id);
    setAddTempOpen(false);
    if (source === 'api') {
      void persistTemporaryRuntime({ name: service.name, type: input.type, port: Number(input.port), command: input.command })
        .then(() => setStatus('Temporary runtime plan persisted. Lifecycle actions remain disabled until a launcher is configured.'))
        .catch((error) => setStatus(error instanceof Error ? error.message : 'Temporary runtime could not be persisted.'));
    } else {
      setStatus('Temporary runtime added to this dashboard session.');
    }
  }

  async function queueUpdate() {
    const next = !updateQueued;
    setUpdateQueued(next);
    if (source === 'api' && next) {
      try {
        const workspace = await queueVersionUpdate('0.12.4', '0.13.0');
        setQueuedVersionId(workspace.versionUpdates.find((update) => update.status === 'queued')?.id || '');
        setStatus('Version update plan queued in the workspace.');
      } catch (error) {
        setUpdateQueued(false);
        setStatus(error instanceof Error ? error.message : 'Version update could not be queued.');
      }
    } else if (source === 'api' && queuedVersionId) {
      try {
        await cancelVersionUpdate(queuedVersionId);
        setQueuedVersionId('');
        setStatus('Version update plan cancelled in the workspace.');
      } catch (error) {
        setUpdateQueued(true);
        setStatus(error instanceof Error ? error.message : 'Version update could not be cancelled.');
      }
    } else {
      setStatus(next ? 'Version update plan queued for this session.' : 'Version update removed from the local queue.');
    }
  }

  async function managePrivateEdge(action: 'plan' | 'apply') {
    if (source !== 'api') {
      setStatus('Private Edge planning needs the live LocalLink API.');
      return;
    }
    setExtensionApplying(true);
    try {
      if (action === 'plan') {
        const plan = await planPrivateEdge(edgeSelectionTouched ? edgeServiceSelection : undefined);
        setExtensionPlan(plan);
        if (edgeServiceSelection.length === 0 && plan.selection.selected.length > 0) {
          setEdgeServiceSelection(plan.selection.selected.map((service) => service.id));
        }
        setStatus(plan.summary);
      } else {
        const result = await applyPrivateEdge(edgeSelectionTouched ? edgeServiceSelection : undefined);
        setExtensionPlan(result.plan);
        setStatus(result.applied
          ? `Private Edge workspace setup updated ${result.changedFiles.join(', ')}.`
          : 'Private Edge workspace files already match the plan.');
        await refreshState();
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Private Edge planning failed.');
    } finally {
      setExtensionApplying(false);
    }
  }

  async function copyVisibleLogs() {
    const text = logs.map((log) => `${log.time} ${log.stream} ${log.level}: ${log.message}`).join('\n');
    await navigator.clipboard?.writeText(text);
    setStatus('Visible logs copied.');
  }

  const attentionItems = useMemo(() => services.filter(serviceNeedsAttention), [services]);
  const filteredServices = useMemo(() => filterServices(services, healthFilter, queries.current), [healthFilter, queries.current, services]);
  const selectedService = selectVisibleService(filteredServices, selectedServiceId);
  const queryText = queries.resources.trim().toLowerCase();
  const visibleLogs = useMemo(() => logs.filter((log) => {
    if (!queryText) return true;
    return `${log.time} ${log.stream} ${log.level} ${log.message}`.toLowerCase().includes(queryText);
  }), [logs, queryText]);

  return (
    <div className="app-shell">
      <Topbar
        view={view}
        theme={theme}
        query={query}
        setQuery={setActiveQuery}
        setView={changeView}
        setTheme={setTheme}
        refreshState={refreshState}
        openTemp={() => setAddTempOpen(true)}
        copyLogs={copyVisibleLogs}
      />

      {status ? (
        <output className="status-banner" aria-live="polite">
          <span>{status}</span>
          <span className="status-meta mono">
            {source === 'api' ? 'Live API' : 'Sample data'}
            {lastUpdatedAt ? (
              <> / <time dateTime={lastUpdatedAt.toISOString()}>{lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></>
            ) : null}
          </span>
        </output>
      ) : null}

      {view === 'current' ? (
        <CurrentWorkspace
          services={services}
          filteredServices={filteredServices}
          selectedService={selectedService}
          query={queries.current}
          loading={loading}
          healthFilter={healthFilter}
          attentionCount={attentionItems.length}
          portsHeld={state.ports.recent.length || state.ports.busy.length}
          pendingServices={pendingServices}
          networkEdgeEnabled={state.extensions.some((extension) => extension.kind === 'network-edge' && extension.enabled)}
          setHealthFilter={setHealthFilter}
          selectService={(id) => {
            setSelectedServiceId(id);
            setMobileServiceDetail(true);
          }}
          mobileServiceDetail={mobileServiceDetail}
          showServiceList={() => setMobileServiceDetail(false)}
          setResourceQuery={(value) => setQueries((current) => ({ ...current, resources: value }))}
          runServiceAction={runServiceAction}
          openSafeStop={(service) => void openSafeStop({ type: 'service', service })}
          setView={changeView}
        />
      ) : null}

      {view === 'extensions' ? (
        <ExtensionsWorkspace
          state={state}
          services={services}
          updateQueued={updateQueued}
          extensionPlan={extensionPlan}
          extensionApplying={extensionApplying}
          edgeServiceSelection={edgeServiceSelection}
          query={queries.extensions}
          managePrivateEdge={managePrivateEdge}
          setEdgeServiceSelection={setEdgeServiceSelection}
          setEdgeSelectionTouched={setEdgeSelectionTouched}
          queueUpdate={queueUpdate}
          openService={openService}
        />
      ) : null}

      {view === 'resources' ? (
        <ResourcesWorkspace
          state={state}
          source={source}
          loading={loading}
          logs={visibleLogs}
          selectedProcess={selectedProcess}
          pauseLogs={pauseLogs}
          setPauseLogs={setPauseLogs}
          allocatePort={allocatePort}
          inspectProcess={inspect}
          openSafeStop={(process) => void openSafeStop({ type: 'process', process })}
          copyLogs={copyVisibleLogs}
          openService={openService}
        />
      ) : null}

      <MobileNav view={view} setView={changeView} />

      {addTempOpen ? <TempRuntimeModal close={() => setAddTempOpen(false)} submit={addTemporaryRuntime} /> : null}

      {killTarget ? (
        <SafeStopModal
          target={killTarget}
          reason={killReason}
          review={killReview}
          setReason={setKillReason}
          close={() => setKillTarget(null)}
          confirm={confirmSafeStop}
        />
      ) : null}
    </div>
  );
}

interface TopbarProps {
  view: View;
  theme: Theme;
  query: string;
  setQuery: (value: string) => void;
  setView: (view: View) => void;
  setTheme: (theme: Theme) => void;
  refreshState: () => Promise<void>;
  openTemp: () => void;
  copyLogs: () => Promise<void>;
}

function Topbar({ view, theme, query, setQuery, setView, setTheme, refreshState, openTemp, copyLogs }: TopbarProps) {
  const placeholder =
    view === 'current'
      ? 'Search services, docs, ports...'
      : view === 'extensions'
        ? 'Filter connections, config, ports...'
        : 'Filter activity logs...';

  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          LL
        </div>
        <div>
          <strong>LocalLink</strong>
          <div className="muted mono">{VIEW_LABELS[view].toLowerCase()} workspace</div>
        </div>
      </div>
      <div className="search">
        <input className="input" type="search" enterKeyHint="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
        {view === 'current' ? (
          <button className="btn primary" type="button" onClick={openTemp}>
            Create runtime plan
          </button>
        ) : null}
        {view === 'extensions' ? (
          <button className="btn primary" type="button" onClick={() => setView('current')}>
            Back to services
          </button>
        ) : null}
        {view === 'resources' ? (
          <button className="btn" type="button" onClick={() => void copyLogs()}>
            Copy logs
          </button>
        ) : null}
      </div>
      <nav className="actions" aria-label="Workspace navigation">
        {(['current', 'extensions', 'resources'] as View[]).map((item) => (
          <button key={item} className={`btn ${view === item ? 'active' : ''}`} type="button" aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>
            {VIEW_LABELS[item]}
          </button>
        ))}
        <button className="btn" type="button" onClick={() => void refreshState()}>
          Refresh
        </button>
        <button className="btn" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </nav>
    </header>
  );
}

interface CurrentWorkspaceProps {
  services: ServiceRecord[];
  filteredServices: ServiceRecord[];
  selectedService?: ServiceRecord;
  query: string;
  loading: boolean;
  healthFilter: ServiceHealthFilter;
  attentionCount: number;
  portsHeld: number;
  pendingServices: Set<string>;
  networkEdgeEnabled: boolean;
  setHealthFilter: (filter: ServiceHealthFilter) => void;
  selectService: (id: string) => void;
  mobileServiceDetail: boolean;
  showServiceList: () => void;
  setResourceQuery: (value: string) => void;
  runServiceAction: (service: ServiceRecord, action: TaskAction) => Promise<void>;
  openSafeStop: (service: ServiceRecord) => void;
  setView: (view: View) => void;
}

function CurrentWorkspace({
  services,
  filteredServices,
  selectedService,
  query,
  loading,
  healthFilter,
  attentionCount,
  portsHeld,
  pendingServices,
  networkEdgeEnabled,
  setHealthFilter,
  selectService,
  mobileServiceDetail,
  showServiceList,
  setResourceQuery,
  runServiceAction,
  openSafeStop,
  setView,
}: CurrentWorkspaceProps) {
  return (
    <main className="pane">
      <div className="pane-head">
        <div>
          <div className="label">Health</div>
          <h1>Service health</h1>
        </div>
        <div className="actions" aria-label="Filter services by health">
          {(['all', 'attention', 'running', 'stopped'] as const).map((filter) => (
            <button key={filter} className={`btn ${healthFilter === filter ? 'active' : ''}`} type="button" aria-pressed={healthFilter === filter} onClick={() => setHealthFilter(filter)}>
              {filter === 'attention' ? 'needs attention' : filter}
            </button>
          ))}
        </div>
      </div>
      <div className="pane-body">
        <section className="summary" aria-label="Current workspace summary">
          <Metric value={loading && services.length === 0 ? '...' : String(services.length)} label="services" tone="ok" />
          <Metric value={loading && services.length === 0 ? '...' : String(attentionCount)} label="need attention" tone={attentionCount > 0 ? 'warn' : 'ok'} />
          <Metric value={loading && services.length === 0 ? '...' : String(services.filter((service) => service.status === 'running').length)} label="running" tone="ok" />
          <Metric value={loading && services.length === 0 ? '...' : String(portsHeld)} label="ports held" tone="info" />
        </section>

        <section className={`screen-grid ${mobileServiceDetail ? 'mobile-detail' : ''}`}>
          <aside className="service-stack" aria-label="Services">
            {loading && filteredServices.length === 0 ? (
              <div className="service loading-card">
                <strong>Loading services</strong>
                <span className="mono">reading local snapshot</span>
                <span className="pill warn">pending</span>
              </div>
            ) : null}
            {filteredServices.map((service) => {
              const matchReason = query ? serviceMatchReason(service, query) : null;
              return (
                <button
                  key={service.id}
                  className={`service ${selectedService?.id === service.id ? 'active' : ''}`}
                  type="button"
                  aria-pressed={selectedService?.id === service.id}
                  onClick={() => selectService(service.id)}
                >
                  <strong>{service.name}</strong>
                  <span className="mono">
                    {service.kind} / {formatPort(service.port)}
                  </span>
                  <span className={`pill ${toneClass(service.statusTone)}`}>{service.statusLabel.toLowerCase()}</span>
                  {serviceNeedsAttention(service) ? <span className="service-reason">{service.reviewReasons?.[0] || 'Operational state needs attention'}</span> : null}
                  {matchReason && matchReason !== 'name' ? <span className="match-reason">Matched in {matchReason}</span> : null}
                </button>
              );
            })}
            {!loading && filteredServices.length === 0 ? (
              <div className="service empty-service">
                <strong>No matching services</strong>
                <span>Clear search or choose another health filter.</span>
              </div>
            ) : null}
          </aside>

          {selectedService ? (
            <ServiceDetail
              service={selectedService}
              services={services}
              pending={pendingServices.has(selectedService.name)}
              networkEdgeEnabled={networkEdgeEnabled}
              selectService={selectService}
              runServiceAction={runServiceAction}
              openSafeStop={openSafeStop}
              setView={setView}
              showServiceList={showServiceList}
              setResourceQuery={setResourceQuery}
            />
          ) : (
            <article className="detail-grid empty-panel">{loading ? 'Loading workspace snapshot...' : 'No service selected.'}</article>
          )}
        </section>
      </div>
    </main>
  );
}

function ServiceDetail({
  service,
  services,
  pending,
  networkEdgeEnabled,
  selectService,
  runServiceAction,
  openSafeStop,
  setView,
  showServiceList,
  setResourceQuery,
}: {
  service: ServiceRecord;
  services: ServiceRecord[];
  pending: boolean;
  networkEdgeEnabled: boolean;
  selectService: (id: string) => void;
  runServiceAction: (service: ServiceRecord, action: TaskAction) => Promise<void>;
  openSafeStop: (service: ServiceRecord) => void;
  setView: (view: View) => void;
  showServiceList: () => void;
  setResourceQuery: (value: string) => void;
}) {
  const plannedRuntime = service.id.startsWith('temp-');
  const runtimeIdentity = service.runtimeName || service.taskName || service.windowsProcessName || service.kind;
  const runtimeLabel = service.runtime ? `${service.runtime.toUpperCase()} / ${runtimeIdentity}` : runtimeIdentity;
  const compliance = service.compliance?.summary || (service.blueprint ? 'Blueprint parsed' : 'No blueprint check');
  const attentionReasons = (service.reviewReasons || []).filter((reason) => !/^No service documentation/i.test(reason));
  const mainPageUrl = networkEdgeEnabled ? service.edgeUrls?.[0] : undefined;

  function serviceLink(name: string) {
    const target = services.find((candidate) => candidate.name === name);
    if (!target) return <span className="dependency-tag" key={name}>{name}</span>;
    return (
      <button className="dependency-tag link" type="button" key={name} onClick={() => selectService(target.id)}>
        {name}
      </button>
    );
  }

  return (
    <article className="detail-grid">
      <div className="detail-top">
        <div>
          <button className="mobile-back btn ghost" type="button" onClick={showServiceList}>Back to services</button>
          <div className="label">Detail</div>
          <h2>{service.name}</h2>
          <p>{service.detail}</p>
        </div>
        <div className="status-row">
          {mainPageUrl ? (
            <a className="btn primary" href={mainPageUrl} target="_blank" rel="noreferrer" title={`Open ${service.name} through the Network Edge`}>
              Open main page
            </a>
          ) : null}
          <span className={`pill ${toneClass(service.statusTone)}`}>{pending ? 'updating' : service.statusLabel.toLowerCase()}</span>
          <span className="pill mono">{formatPort(service.port)}</span>
        </div>
      </div>

      <div className="action-row" aria-label={`${service.name} lifecycle actions`}>
        <button className="btn primary" type="button" disabled={pending || plannedRuntime} onClick={() => void runServiceAction(service, 'start')}>
          Start
        </button>
        <button className="btn" type="button" disabled={pending || plannedRuntime} onClick={() => void runServiceAction(service, 'restart')}>
          Restart
        </button>
        <button className="btn" type="button" onClick={() => { setResourceQuery(service.name); setView('resources'); }}>
          Logs
        </button>
        <button className="btn danger" type="button" disabled={pending || plannedRuntime} onClick={() => openSafeStop(service)}>
          Stop service
        </button>
      </div>
      {plannedRuntime ? <p className="scope-note">This temporary runtime is a persisted plan only. Lifecycle execution is disabled until a runtime launcher is configured.</p> : null}

      <div className="service-facts" aria-label={`${service.name} runtime facts`}>
        <Fact label="Runtime" value={service.runtime?.toUpperCase() || service.group.toUpperCase()} mono />
        <Fact label="CPU" value={service.cpu} mono />
        <Fact label="Memory" value={service.memory} mono />
        <Fact label="Uptime" value={service.uptime} mono />
        <Fact label="Health" value={pending ? 'Updating' : service.statusLabel} />
        <Fact label="Compliance" value={service.compliance?.status || 'Not checked'} />
      </div>

      {attentionReasons.length > 0 ? (
        <div className="cardlet review-card">
          <strong>Needs attention</strong>
          <div className="review-list">
            {attentionReasons.map((reason) => <span className="review-warning" key={reason}>{reason}</span>)}
          </div>
        </div>
      ) : null}

      <div className="subgrid essential-details">
        <InfoCard
          title="Port binding"
          value={service.portEnv ? `${service.portEnv} = ${service.port || 'not resolved'}` : formatPort(service.port)}
          mono
        />
        <div className="cardlet docs-card">
          <strong>Documentation</strong>
          {service.docsUrl ? (
            <a className="docs-link" href={service.docsUrl} target="_blank" rel="noreferrer" title={`Open ${service.name} documentation`}>
              <span>Service reference</span>
              <strong>{documentationHost(service.docsUrl)}</strong>
              <span className="mono">{service.docsUrl}</span>
            </a>
          ) : (
            <p>No documentation URL is linked in workspace metadata.</p>
          )}
        </div>
        <div className="cardlet dependency-card">
          <strong>Service relationships</strong>
          <div className="relationship-row">
            <span className="label">Depends on</span>
            <div className="dependency-list">
              {(service.dependsOn || []).length > 0 ? service.dependsOn?.map(serviceLink) : <span className="muted">None declared</span>}
            </div>
          </div>
          <div className="relationship-row">
            <span className="label">Used by</span>
            <div className="dependency-list">
              {(service.downstream || []).length > 0 ? service.downstream?.map(serviceLink) : <span className="muted">None declared</span>}
            </div>
          </div>
        </div>
      </div>

      <details className="advanced-details">
        <summary>Advanced runtime details</summary>
        <div className="subgrid">
          <InfoCard title="Entry" value={service.blueprint?.command || service.script || service.runtimeName || service.runtime || 'Runtime command pending'} mono />
          <InfoCard title="Runtime identity" value={runtimeLabel} mono />
          <InfoCard title="Working directory" value={service.cwd || service.dockerfilePath || 'Workspace root'} mono />
          <InfoCard title="Environment" value={(service.envVars || []).join(' / ') || service.portEnv || 'No variables declared'} mono />
          <InfoCard title="Blueprint" value={compliance} />
        </div>
      </details>
    </article>
  );
}

function ExtensionsWorkspace({
  state,
  services,
  updateQueued,
  extensionPlan,
  extensionApplying,
  edgeServiceSelection,
  query,
  managePrivateEdge,
  setEdgeServiceSelection,
  setEdgeSelectionTouched,
  queueUpdate,
  openService,
}: {
  state: DashboardState;
  services: ServiceRecord[];
  updateQueued: boolean;
  extensionPlan: ExtensionInstallPlan | null;
  extensionApplying: boolean;
  edgeServiceSelection: string[];
  query: string;
  managePrivateEdge: (action: 'plan' | 'apply') => Promise<void>;
  setEdgeServiceSelection: React.Dispatch<React.SetStateAction<string[]>>;
  setEdgeSelectionTouched: React.Dispatch<React.SetStateAction<boolean>>;
  queueUpdate: () => Promise<void>;
  openService: (id: string) => void;
}) {
  const pocketIdOption = state.phase2.options.find((option) => option.id === 'pocket-id');
  const extensions = state.extensionLifecycle.map((extension) => {
    const detail = `${extension.summary}${extension.nextStep ? ` Next: ${extension.nextStep}` : ''}`;
    return {
      id: extension.id,
      title: extension.name,
      detail,
      state: extension.state,
      healthy: extension.state === 'healthy',
      warn: extension.state.startsWith('waiting') || extension.state === 'error',
    };
  });
  const visibleExtensions = extensions.filter((extension) => matchesWorkspaceQuery(query, extension.title, extension.detail, extension.state));
  const ports = state.ports.recent
    .filter((entry) => matchesWorkspaceQuery(query, entry.service, entry.port, entry.status, 'port'))
    .slice(0, 5);
  const showConfig = matchesWorkspaceQuery(query, 'extension config', 'dashboard', 'proxy', 'pocket id', 'identity provider', 'tailscale serve', 'network edge', state.phase2.summary);
  const showPorts = ports.length > 0 || matchesWorkspaceQuery(query, 'port list', 'configured ports', 'next open port');
  const showVersion = matchesWorkspaceQuery(query, 'version workflow', 'CLI 0.12.4 0.13.0', 'schedule update', 'cancel update');
  const hasResults = visibleExtensions.length > 0 || showConfig || showPorts || showVersion;
  const edgeCandidates = extensionPlan?.selection.available
    || services.filter((service) => Boolean(service.port && service.port !== '—')).map((service) => ({ id: service.id, name: service.name, port: service.port }));

  return (
    <main className="pane">
      <div className="pane-head">
        <div>
          <div className="label">Connections workspace</div>
          <h1>Connections and config</h1>
        </div>
        <span className="pill ok">declared per workspace</span>
      </div>
      <div className="pane-body stack">
        {visibleExtensions.length > 0 ? (
          <section className="extension-row" aria-label="Connections">
            {visibleExtensions.map((extension) => (
              <ExtensionButton key={extension.id} title={extension.title} detail={extension.detail} status={extension.state} healthy={extension.healthy} warn={extension.warn} />
            ))}
          </section>
        ) : null}

        {showConfig || showPorts ? <section className="config-stack">
          {showConfig ? <article className="config-card">
            <strong>Extension config</strong>
            <p>
              Available capabilities are built into LocalLink. Workspace declarations come from <span className="mono">locallink.extensions.yml</span>; runtime probes separately report what is installed, waiting for a person, or healthy.
            </p>
            <div className="config-lines">
              {state.extensionLifecycle.map((extension) => (
                <ConfigLine
                  key={extension.id}
                  label={extension.name}
                  value={`${extension.state} / ${extension.declared ? `declared as ${extension.declarationId}` : 'not declared'} / ${extension.automation}`}
                />
              ))}
              <ConfigLine label="Pocket ID issuer" value={pocketIdOption?.detectedValue || 'Set POCKET_ID_APP_URL to the private Tailscale Serve HTTPS URL.'} />
            </div>
            <div className="actions">
              <button className="btn" type="button" disabled={extensionApplying} onClick={() => void managePrivateEdge('plan')}>Preview Private Edge setup</button>
              {extensionPlan?.canApply ? (
                <button className="btn" type="button" disabled={extensionApplying} onClick={() => void managePrivateEdge('apply')}>Apply workspace setup</button>
              ) : null}
              <a className="btn" href="./docs/pocket-id-tailscale.html" target="_blank" rel="noreferrer">Private SSO setup</a>
              <a className="btn ghost" href="./docs/extensions.html" target="_blank" rel="noreferrer">Extension guide</a>
              <a className="btn ghost" href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">Tailscale Serve docs</a>
            </div>
            <div className="config-lines" aria-label="Private Edge service selection">
              {edgeCandidates.length > 0 ? edgeCandidates.map((service) => (
                <label key={service.id} className="config-line">
                  <span>
                    <input
                      type="checkbox"
                      checked={edgeServiceSelection.includes(service.id)}
                      onChange={() => {
                        setEdgeSelectionTouched(true);
                        setEdgeServiceSelection((current) => current.includes(service.id)
                          ? current.filter((id) => id !== service.id)
                          : [...current, service.id]);
                      }}
                    />{' '}
                    {service.name}
                  </span>
                  <strong className="mono">:{service.port}</strong>
                </label>
              )) : <p>Declare a service port before selecting Private Edge routes.</p>}
            </div>
          </article> : null}

          {showConfig && extensionPlan ? <article className="config-card">
            <strong>Private Edge onboarding plan</strong>
            <p>{extensionPlan.summary}</p>
            <div className="config-lines">
              {extensionPlan.steps.map((step) => (
                <ConfigLine
                  key={step.id}
                  label={`${step.label} · ${step.owner}`}
                  value={`${step.status} / ${step.automatic ? 'automatic' : 'manual'}${step.targetFile ? ` / ${step.targetFile}` : ''}`}
                />
              ))}
            </div>
            {extensionPlan.routePlan.routes.length > 0 ? (
              <div className="config-lines" aria-label="Generated Tailscale Serve route plan">
                {extensionPlan.routePlan.routes.map((route) => (
                  <ConfigLine
                    key={route.serviceId}
                    label={`${route.serviceName} · ${route.status}`}
                    value={`${route.url || `HTTPS :${route.httpsPort}`} → 127.0.0.1:${route.targetPort}`}
                  />
                ))}
              </div>
            ) : null}
          </article> : null}

          {showPorts ? <article className="config-card">
            <strong>Port list</strong>
            <div className="port-list table-like">
              {ports.length > 0 ? (
                ports.map((entry) => {
                  const service = services.find((candidate) => candidate.name === entry.service);
                  return (
                    <div className="port-row" key={`${entry.service}-${entry.port}`}>
                      <span className="mono">{entry.port}</span>
                      <button
                        className="link-button"
                        type="button"
                        onClick={() => {
                          if (service) {
                            openService(service.id);
                          }
                        }}
                      >
                        {entry.service}
                      </button>
                      <span className={`pill ${entry.status === 'suggested' ? 'warn' : 'ok'}`}>{entry.status}</span>
                    </div>
                  );
                })
              ) : (
                <p>No ports are listed in the current snapshot.</p>
              )}
            </div>
          </article> : null}
        </section> : null}

        {showVersion ? <section className="subgrid single">
          <article className="cardlet">
            <strong>Version workflow</strong>
            <p className="mono">CLI 0.12.4 -&gt; 0.13.0</p>
            <p>Schedules a workspace update plan only. Nothing is installed until the plan is explicitly applied.</p>
            <button
              className="btn"
              type="button"
              onClick={() => {
                void queueUpdate();
              }}
            >
              {updateQueued ? 'Cancel scheduled update' : 'Schedule update'}
            </button>
          </article>
        </section> : null}

        {!hasResults ? (
          <section className="empty-search" aria-live="polite">
            <strong>No matching connections or configuration</strong>
            <p>Clear the search to see all connection settings, ports, and update plans.</p>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function ResourcesWorkspace({
  state,
  source,
  loading,
  logs,
  selectedProcess,
  pauseLogs,
  setPauseLogs,
  allocatePort,
  inspectProcess,
  openSafeStop,
  copyLogs,
  openService,
}: {
  state: DashboardState;
  source: Source;
  loading: boolean;
  logs: LogEntry[];
  selectedProcess: ProcessInspection | null;
  pauseLogs: boolean;
  setPauseLogs: (value: boolean) => void;
  allocatePort: () => Promise<void>;
  inspectProcess: (process: ResourceProcess) => Promise<void>;
  openSafeStop: (process: ResourceProcess | ProcessInspection) => void;
  copyLogs: () => Promise<void>;
  openService: (id: string) => void;
}) {
  const [resourceScope, setResourceScope] = useState<ResourceScope>('workspace');
  const { system, history } = state.resources;
  const scopedProcesses = resourceScope === 'workspace' ? state.resources.workspaceProcesses : state.resources.hostProcesses;
  const topCpu = [...scopedProcesses].sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, 5);
  const topMemory = [...scopedProcesses].sort((left, right) => right.memoryMb - left.memoryMb).slice(0, 5);
  const processCount = scopedProcesses.length;
  const scopedCpu = resourceScope === 'workspace'
    ? scopedProcesses.reduce((total, process) => total + process.cpuPercent, 0)
    : system.cpuPercent;
  const scopedMemoryMb = resourceScope === 'workspace'
    ? scopedProcesses.reduce((total, process) => total + process.memoryMb, 0)
    : system.memoryUsedMb;
  const scopedMemoryPercent = (scopedMemoryMb / Math.max(1, system.memoryTotalMb)) * 100;
  const scopedAttention = scopedProcesses.filter((process) => process.tone === 'warn').length;
  const visibleSelectedProcess = selectedProcess && scopedProcesses.some((process) => process.pid === selectedProcess.pid) ? selectedProcess : null;
  const sampledAt = Date.parse(system.updatedAt) > 0
    ? new Date(system.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'waiting';

  return (
    <main className="two-col">
      <section className="pane resource-pane">
        <div className="pane-head">
          <div>
            <div className="label">System workspace</div>
            <h1>{resourceScope === 'workspace' ? 'Workspace resources' : 'Host resources'}</h1>
          </div>
          <div className="resource-head-actions">
            <div className="actions resource-scope-toggle" aria-label="Resource scope">
              {(['workspace', 'host'] as ResourceScope[]).map((scope) => (
                <button className={`btn ${resourceScope === scope ? 'active' : ''}`} type="button" key={scope} aria-pressed={resourceScope === scope} onClick={() => setResourceScope(scope)}>
                  {scope === 'workspace' ? 'Workspace' : 'Host'}
                </button>
              ))}
            </div>
            <div className="sample-status">
              <span className={`live-dot ${source === 'api' ? '' : 'sample'}`} aria-hidden="true" />
              <span>{source === 'api' ? `Live / ${system.sampleIntervalSeconds}s` : 'Sample data'}</span>
            </div>
          </div>
        </div>
        <div className="pane-body resource-dashboard">
          <p className="scope-note">
            {resourceScope === 'workspace'
              ? 'Showing processes attributed to services in this workspace. Switch to Host for every visible process.'
              : state.resources.scopeNote}
          </p>
          <section className="pressure-summary" aria-label={`${resourceScope} resource summary`}>
            <PressureMetric
              label="CPU"
              value={loading && history.length === 0 ? '...' : formatPercent(scopedCpu)}
              detail={resourceScope === 'workspace' ? `${processCount} attributed processes` : `${system.cpuCores} logical cores`}
              tone={scopedCpu >= 80 ? 'bad' : scopedCpu >= 60 ? 'warn' : 'ok'}
            />
            <PressureMetric
              label="Memory"
              value={loading && history.length === 0 ? '...' : formatMemoryMb(scopedMemoryMb)}
              detail={`${formatPercent(scopedMemoryPercent)} of host memory`}
              tone={scopedMemoryPercent >= 90 ? 'bad' : scopedMemoryPercent >= 75 ? 'warn' : 'info'}
            />
            <PressureMetric label="Processes" value={String(processCount)} detail={resourceScope === 'workspace' ? 'attributed to workspace' : 'visible on host'} />
            <PressureMetric
              label="Attention"
              value={String(scopedAttention)}
              detail="above pressure thresholds"
              tone={scopedAttention > 0 ? 'warn' : 'ok'}
            />
          </section>

          {resourceScope === 'host' ? <section className="trend-grid" aria-label="Host resource usage trends">
            <TrendCard
              title="CPU usage"
              value={system.cpuPercent}
              detail={`Load ${system.loadAverage[0]?.toFixed(1) || '0.0'} / ${system.cpuCores} cores`}
              samples={history}
              metric="cpuPercent"
              intervalSeconds={system.sampleIntervalSeconds}
              tone="cpu"
            />
            <TrendCard
              title="Memory usage"
              value={system.memoryPercent}
              detail={`${formatMemoryMb(system.memoryUsedMb)} used`}
              samples={history}
              metric="memoryPercent"
              intervalSeconds={system.sampleIntervalSeconds}
              tone="memory"
            />
          </section> : null}

          <section className="process-rankings" aria-label="Highest resource consumers">
            <ProcessRanking
              title="Top CPU"
              processes={topCpu}
              mode="cpu"
              totalMemoryMb={system.memoryTotalMb}
              selectedPid={visibleSelectedProcess?.pid}
              inspectProcess={inspectProcess}
            />
            <ProcessRanking
              title="Top memory"
              processes={topMemory}
              mode="memory"
              totalMemoryMb={system.memoryTotalMb}
              selectedPid={visibleSelectedProcess?.pid}
              inspectProcess={inspectProcess}
            />
          </section>

          {visibleSelectedProcess ? (
            <article className="process-inspector">
              <div className="process-inspector-head">
                <div>
                  <div className="label">Process inspector</div>
                  <h3>{visibleSelectedProcess.name}</h3>
                </div>
                <div className="actions">
                  {visibleSelectedProcess.serviceId ? (
                    <button className="btn" type="button" onClick={() => openService(visibleSelectedProcess.serviceId || '')}>
                      Open service
                    </button>
                  ) : null}
                  <button className="btn danger" type="button" onClick={() => openSafeStop(visibleSelectedProcess)}>
                    Review termination
                  </button>
                </div>
              </div>
              <div className="process-facts">
                <Fact label="PID" value={String(visibleSelectedProcess.pid)} mono />
                <Fact label="Parent PID" value={String(visibleSelectedProcess.parentPid || '-')} mono />
                <Fact label="CPU" value={visibleSelectedProcess.cpu} mono />
                <Fact label="Memory" value={visibleSelectedProcess.memory} mono />
                <Fact label="Uptime" value={visibleSelectedProcess.uptime} mono />
                <Fact label="Started" value={visibleSelectedProcess.started} />
              </div>
              <div className="command-block">
                <span className="label">Command</span>
                <code>{visibleSelectedProcess.command}</code>
              </div>
            </article>
          ) : null}
          <p className="sample-note">
            Sample captured at {sampledAt}. Select any ranked process for its parent, start time, service attribution, and full command.
          </p>
        </div>
      </section>

      <section className="pane">
        <div className="pane-head">
          <div>
            <div className="label">Operations</div>
            <h2>Ports and activity</h2>
          </div>
          <button className="btn" type="button" onClick={() => setPauseLogs(!pauseLogs)}>
            {pauseLogs ? 'Resume' : 'Pause'}
          </button>
        </div>
        <div className="pane-body operations-stack">
          <div className="summary compact-summary">
            <Metric value={String(state.ports.recent.length || state.ports.busy.length)} label="ports held" tone="info" />
            <Metric value={String(state.ports.nextFree)} label="next free" tone="ok" />
            <Metric value={String(system.flaggedCount)} label="host attention" tone={system.flaggedCount > 0 ? 'warn' : 'ok'} />
            <Metric value={String(logs.length)} label="events visible" />
          </div>

          <section className="ops-section">
            <div className="section-head">
              <div>
                <strong>Port allocation</strong>
                <p>{state.ports.rule}</p>
              </div>
              <button className="btn primary" type="button" onClick={() => void allocatePort()}>
                Allocate
              </button>
            </div>
            <div className="port-list">
              {state.ports.recent.slice(0, 6).map((entry) => (
                <div className="port-row" key={`${entry.service}-${entry.port}`}>
                  <span className="mono">{entry.port}</span>
                  <span>{entry.service}</span>
                  <span className={`pill ${entry.status === 'suggested' ? 'warn' : 'ok'}`}>{entry.status}</span>
                </div>
              ))}
              {state.ports.recent.length === 0 ? <p className="empty-copy">No service port bindings were detected.</p> : null}
            </div>
          </section>

          <section className="ops-section activity-section">
            <div className="section-head">
              <div>
                <strong>Runtime activity</strong>
                <p>{pauseLogs ? 'Feed paused at the current position.' : 'Docker, PM2, and lifecycle events.'}</p>
              </div>
              <button className="btn ghost" type="button" onClick={() => void copyLogs()}>
                Copy
              </button>
            </div>
            <div className="logs" role="log" aria-live={pauseLogs ? 'off' : 'polite'}>
              {logs.slice(0, 80).map((log) => (
                <div className="log-line" key={`${log.timestamp}-${log.stream}-${log.message}`}>
                  <span>{log.time}</span>
                  <span className={log.level === 'error' ? 'bad' : log.level === 'warn' ? 'warn' : ''}>{log.level}</span>
                  <span>
                    {log.stream}: {log.message}
                  </span>
                </div>
              ))}
              {logs.length === 0 ? <p className="empty-copy">No runtime events have been captured yet.</p> : null}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function PressureMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'ok' | 'warn' | 'bad' | 'info';
}) {
  return (
    <div className="pressure-metric">
      <span className="label">{label}</span>
      <strong className={tone}>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function TrendCard({
  title,
  value,
  detail,
  samples,
  metric,
  intervalSeconds,
  tone,
}: {
  title: string;
  value: number;
  detail: string;
  samples: DashboardState['resources']['history'];
  metric: 'cpuPercent' | 'memoryPercent';
  intervalSeconds: number;
  tone: 'cpu' | 'memory';
}) {
  const values = samples.length > 0 ? samples.map((sample) => sample[metric]) : [value];
  const chartValues = values.length === 1 ? [values[0], values[0]] : values;
  const average = values.reduce((sum, current) => sum + current, 0) / values.length;
  const peak = Math.max(...values);
  const points = chartValues
    .map((current, index) => {
      const x = (index / Math.max(1, chartValues.length - 1)) * 320;
      const y = 104 - Math.min(100, Math.max(0, current));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <article className={`trend-card ${tone}`}>
      <div className="trend-head">
        <div>
          <strong>{title}</strong>
          <p>{detail}</p>
        </div>
        <span className="trend-value mono">{formatPercent(value)}</span>
      </div>
      <svg
        className="trend-chart"
        viewBox="0 0 320 112"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title} over ${formatSampleWindow(values.length, intervalSeconds)}`}
      >
        <line x1="0" y1="4" x2="320" y2="4" />
        <line x1="0" y1="54" x2="320" y2="54" />
        <line x1="0" y1="104" x2="320" y2="104" />
        <polygon points={`0,104 ${points} 320,104`} />
        <polyline points={points} />
      </svg>
      <div className="trend-meta mono">
        <span>avg {formatPercent(average)}</span>
        <span>peak {formatPercent(peak)}</span>
        <span>{values.length} samples / {formatSampleWindow(values.length, intervalSeconds)}</span>
      </div>
    </article>
  );
}

function ProcessRanking({
  title,
  processes,
  mode,
  totalMemoryMb,
  selectedPid,
  inspectProcess,
}: {
  title: string;
  processes: ResourceProcess[];
  mode: 'cpu' | 'memory';
  totalMemoryMb: number;
  selectedPid?: number;
  inspectProcess: (process: ResourceProcess) => Promise<void>;
}) {
  return (
    <article className="process-ranking">
      <div className="ranking-head">
        <div>
          <strong>{title}</strong>
          <p>{mode === 'cpu' ? 'Process CPU share in this view' : 'Resident memory footprint'}</p>
        </div>
        <span className="label">Top 5</span>
      </div>
      <div className="ranking-list">
        {processes.slice(0, 5).map((process, index, ranked) => {
          const percent = mode === 'cpu'
            ? (process.cpuPercent / Math.max(1, ranked[0]?.cpuPercent || process.cpuPercent)) * 100
            : (process.memoryMb / Math.max(1, ranked[0]?.memoryMb || totalMemoryMb)) * 100;
          const value = mode === 'cpu' ? process.cpu : process.memory;

          return (
            <button
              className={`process-row-button ${selectedPid === process.pid ? 'active' : ''}`}
              type="button"
              key={`${mode}-${process.pid}`}
              onClick={() => void inspectProcess(process)}
              title={`Inspect PID ${process.pid}: ${process.command}`}
            >
              <span className="rank mono">{index + 1}</span>
              <span className="process-copy">
                <strong>{process.name}</strong>
                <span className="mono">PID {process.pid} / {process.uptime}</span>
                <span className="process-command">{process.command}</span>
              </span>
              <span className="process-usage">
                <strong className="mono">{value}</strong>
                <meter className="usage-meter" min="0" max="100" value={Math.max(0, percent)} aria-label={`${title}: ${value}`} />
              </span>
            </button>
          );
        })}
        {processes.length === 0 ? <p className="empty-copy">No process data is available.</p> : null}
      </div>
    </article>
  );
}

function Metric({ value, label, tone }: { value: string; label: string; tone?: 'ok' | 'warn' | 'bad' | 'info' }) {
  return (
    <div className="metric">
      <strong className={tone}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="fact">
      <span className="label">{label}</span>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </div>
  );
}

function InfoCard({ title, value, mono, action }: { title: string; value: string; mono?: boolean; action?: React.ReactNode }) {
  return (
    <div className="cardlet">
      <strong>{title}</strong>
      <p className={mono ? 'mono' : ''}>{value}</p>
      {action}
    </div>
  );
}

function ExtensionButton({
  title,
  detail,
  status,
  healthy,
  warn,
}: {
  title: string;
  detail: string;
  status: string;
  healthy: boolean;
  warn?: boolean;
}) {
  return (
    <div className="extension">
      <span className="extension-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <span className={`pill ${healthy ? 'ok' : warn ? 'warn' : ''}`}>{status}</span>
    </div>
  );
}

function ConfigLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="label">{label}</span>
      <p className="mono">{value}</p>
    </div>
  );
}

function MobileNav({ view, setView }: { view: View; setView: (view: View) => void }) {
  return (
    <nav className="mobile-nav" aria-label="Mobile screen navigation">
      {(['current', 'extensions', 'resources'] as View[]).map((item) => (
        <button key={item} className={view === item ? 'active' : ''} type="button" aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>
          {VIEW_LABELS[item]}
        </button>
      ))}
      <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        Top
      </button>
    </nav>
  );
}

function useNativeDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    }
  }, []);

  function closeDialog() {
    dialogRef.current?.close();
  }

  function handleClose() {
    onClose();
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }

  return { dialogRef, closeDialog, handleClose };
}

function TempRuntimeModal({ close, submit }: { close: () => void; submit: (input: { type: string; port: string; command: string }) => void }) {
  const [type, setType] = useState('Docker');
  const [port, setPort] = useState('6080');
  const [command, setCommand] = useState('docker run --rm -p 6080:80 local/test-api');
  const { dialogRef, closeDialog, handleClose } = useNativeDialog(close);

  return (
    <dialog ref={dialogRef} className="modal-card" aria-labelledby="runtime-plan-title" onClose={handleClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit({ type, port, command });
        }}
      >
        <div className="pane-head">
          <div>
            <div className="label">Temporary runtime</div>
            <h2 id="runtime-plan-title">Create runtime plan</h2>
          </div>
          <button className="btn ghost" type="button" onClick={closeDialog}>
            Close
          </button>
        </div>
        <div className="modal-body">
          <p>This saves a plan to the workspace. Lifecycle controls stay disabled until a launcher is configured.</p>
          <div className="form-grid">
            <label>
              <span className="label">Type</span>
              <select className="select" value={type} onChange={(event) => setType(event.target.value)} data-initial-focus>
                <option>Docker</option>
                <option>PM2</option>
                <option>MCP server</option>
                <option>Dev server</option>
              </select>
            </label>
            <label>
              <span className="label">Port</span>
              <input className="input" value={port} onChange={(event) => setPort(event.target.value)} />
            </label>
          </div>
          <label>
            <span className="label">Command</span>
            <textarea rows={3} value={command} onChange={(event) => setCommand(event.target.value)} />
          </label>
          <button className="btn primary" type="submit">
            Save runtime plan
          </button>
        </div>
      </form>
    </dialog>
  );
}

function SafeStopModal({
  target,
  reason,
  review,
  setReason,
  close,
  confirm,
}: {
  target: KillTarget;
  reason: string;
  review: ProcessTerminationReview | null;
  setReason: (value: string) => void;
  close: () => void;
  confirm: () => Promise<void>;
}) {
  const title = target.type === 'service' ? target.service.name : `${target.process.name} (${target.process.pid})`;
  const heading = target.type === 'service' ? 'Review service stop' : 'Review process termination';
  const { dialogRef, closeDialog, handleClose } = useNativeDialog(close);

  return (
    <dialog ref={dialogRef} className="modal-card" aria-labelledby="safe-stop-title" onClose={handleClose}>
        <div className="pane-head">
          <div>
            <div className="label">Safe termination</div>
            <h2 id="safe-stop-title">{heading}</h2>
          </div>
          <button className="btn ghost" type="button" onClick={closeDialog}>
            Close
          </button>
        </div>
        <div className="modal-body">
          {target.type === 'process' ? (
            <>
              <p>
                {review ? `${review.name} was reviewed at ${new Date(review.reviewedAt).toLocaleTimeString()}.` : 'Reviewing process identity, parent state, children, and open ports...'}
              </p>
              {review?.warnings.length ? (
                <div className="review-list">
                  {review.warnings.map((warning) => <div className="review-warning" key={warning}>{warning}</div>)}
                </div>
              ) : null}
              {review?.dependents.length ? <p className="mono">Children: {review.dependents.join(', ')}</p> : null}
              {review?.ports.length ? <p className="mono">Bindings: {review.ports.join(', ')}</p> : null}
            </>
          ) : (
            <p>Stopping {title} will use the configured runtime action and refresh the service snapshot.</p>
          )}
          <label>
            <span className="label">Reason (optional)</span>
            <textarea
              rows={3}
              placeholder="For example: orphan process after closing the dev server"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              data-initial-focus
            />
          </label>
          <button className="btn danger" type="button" disabled={target.type === 'process' && (!review || !review.canTerminate)} onClick={() => void confirm()}>
            {target.type === 'service' ? 'Stop service' : review ? 'Terminate reviewed process' : 'Reviewing process...'}
          </button>
        </div>
    </dialog>
  );
}
