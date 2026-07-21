import type { Phase2Advisor, Phase2Option } from '../shared/contracts';
import { isCommandMissingResult, parseJsonOutput, runCommand, type CommandRunner } from '../shared/utils';
import { detectCaddyRuntime } from './caddy-runtime';

interface TailscaleStatus {
  BackendState?: string;
  MagicDNSSuffix?: string;
  Self?: {
    TailscaleIPs?: string[];
  };
  CurrentTailnet?: {
    Name?: string;
  };
}

function isEnabled(value: string | undefined): boolean {
  if (!value) {
    return true;
  }

  return !['0', 'false', 'off', 'disabled', 'no'].includes(value.toLowerCase());
}

function normalizeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.example') || url.hostname.endsWith('.example.com') || url.hostname.includes('example-tailnet')) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

async function detectCommand(
  command: string,
  args: string[],
  commandRunner: CommandRunner,
): Promise<{ available: boolean; output?: string }> {
  const result = await commandRunner(command, args, { timeoutMs: 1_500 });
  if (isCommandMissingResult(result)) {
    return { available: false };
  }

  return {
    available: result.ok,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

export async function buildPhase2Advisor(
  env: Record<string, string>,
  commandRunner: CommandRunner = runCommand,
  workspaceRoot?: string,
): Promise<Phase2Advisor> {
  if (!isEnabled(env.LOCALLINK_ENABLE_PHASE2_ADVISOR)) {
    return {
      enabled: false,
      summary: 'Phase 2 advisor is disabled in .env.',
      options: [
        {
          id: 'phase2-disabled',
          title: 'Phase 2 advisor disabled',
          detail: 'Set `LOCALLINK_ENABLE_PHASE2_ADVISOR=true` to surface Tailscale and reverse-proxy recommendations.',
          status: 'disabled',
        },
      ],
    };
  }

  const preferredEdge = (env.LOCALLINK_PHASE2_PREFERRED_EDGE || 'auto').toLowerCase();
  const pocketIdIssuer = normalizeHttpsUrl(env.POCKET_ID_APP_URL);
  const [tailscaleResult, caddyResult, traefikResult, nginxResult] = await Promise.all([
    commandRunner('tailscale', ['status', '--json'], { timeoutMs: 2_000 }),
    detectCaddyRuntime(workspaceRoot, commandRunner),
    detectCommand('traefik', ['version'], commandRunner),
    detectCommand('nginx', ['-v'], commandRunner),
  ]);

  const reverseProxyDetections = [
    caddyResult.available ? caddyResult.source === 'docker-compose' ? 'Caddy (Docker Compose)' : 'Caddy' : null,
    traefikResult.available ? 'Traefik' : null,
    nginxResult.available ? 'Nginx' : null,
  ].filter(Boolean) as string[];

  let tailscaleOption: Phase2Option;
  if (isCommandMissingResult(tailscaleResult)) {
    tailscaleOption = {
      id: 'tailscale',
      title: 'Tailscale private network',
      detail: 'Tailscale is not installed. Install it to offer a private network edge without exposing a public reverse proxy.',
      status: 'optional',
      docsUrl: 'https://tailscale.com/docs/features/tailscale-serve',
    };
  } else if (!tailscaleResult.ok) {
    tailscaleOption = {
      id: 'tailscale',
      title: 'Tailscale private network',
      detail: 'Tailscale is installed but not currently connected. Start Tailscale or authenticate the node to offer this Phase 2 option.',
      status: 'optional',
      docsUrl: 'https://tailscale.com/docs/features/tailscale-serve',
    };
  } else {
    const status = parseJsonOutput<TailscaleStatus>(tailscaleResult.stdout)[0];
    const connected = !status?.BackendState || status.BackendState.toLowerCase() === 'running';
    tailscaleOption = {
      id: 'tailscale',
      title: 'Tailscale private network',
      detail: connected
        ? 'Private network connection detected. LocalLink can offer a private Phase 2 edge without a public reverse proxy.'
        : 'Private network tooling is installed. Confirm the node connection before enabling a Phase 2 edge.',
      status: connected ? 'available' : 'optional',
      recommended: preferredEdge === 'auto' || preferredEdge === 'tailscale',
      docsUrl: 'https://tailscale.com/docs/features/tailscale-serve',
      detectedValue: 'Private network detected; address hidden',
    };
  }

  const reverseProxyOption: Phase2Option = reverseProxyDetections.length > 0
    ? {
        id: 'reverse-proxy',
        title: 'Reverse proxy edge',
        detail: `Detected ${reverseProxyDetections.join(', ')}. LocalLink can stage a reverse-proxy-friendly Phase 2 edge if private networking is not the right fit.`,
        status: 'available',
        recommended: preferredEdge === 'reverse-proxy',
        docsUrl: 'https://caddyserver.com/docs/quick-starts/reverse-proxy',
        detectedValue: reverseProxyDetections.join(', '),
      }
    : {
        id: 'reverse-proxy',
        title: 'Reverse proxy edge',
        detail: 'No reverse proxy tool was detected. Install Caddy, Traefik, or Nginx if you want LocalLink to guide a public Phase 2 edge.',
        status: 'optional',
        docsUrl: 'https://caddyserver.com/docs/quick-starts/reverse-proxy',
      };

  const localOnlyOption: Phase2Option = {
    id: 'local-only',
    title: 'Stay local-only',
    detail: 'Phase 2 remains opt-out. You can keep the current loopback-only dashboard and ignore edge recommendations entirely.',
    status: 'available',
    recommended: preferredEdge === 'local-only',
  };

  const pocketIdOption: Phase2Option = pocketIdIssuer
    ? {
        id: 'pocket-id',
        title: 'Pocket ID application SSO',
        detail: 'Private HTTPS issuer configured. Publish it through Tailscale Serve, then register each internal application as a Pocket ID OIDC client.',
        status: 'available',
        recommended: tailscaleOption.status === 'available',
        docsUrl: '/docs/pocket-id-tailscale.html',
        detectedValue: pocketIdIssuer,
      }
    : {
        id: 'pocket-id',
        title: 'Pocket ID application SSO',
        detail: 'Set POCKET_ID_APP_URL to Pocket ID\'s stable private Tailscale Serve HTTPS URL before registering internal OIDC clients.',
        status: 'optional',
        docsUrl: '/docs/pocket-id-tailscale.html',
      };

  const edgeOptions = [tailscaleOption, reverseProxyOption, localOnlyOption];
  const options = [...edgeOptions, pocketIdOption];
  const availableOptions = edgeOptions.filter((option) => option.status === 'available').length;

  return {
    enabled: true,
    summary:
      availableOptions > 0
        ? `${availableOptions} Phase 2 edge option${availableOptions === 1 ? '' : 's'} detected for this machine.`
        : 'No optional Phase 2 edge tooling detected yet; LocalLink stays local-only by default.',
    options,
  };
}
