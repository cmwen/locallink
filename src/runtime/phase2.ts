import type { Phase2Advisor, Phase2Option } from '../shared/contracts';
import { isCommandMissingResult, parseJsonOutput, runCommand, type CommandRunner } from '../shared/utils';

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
  const [tailscaleResult, caddyResult, traefikResult, nginxResult] = await Promise.all([
    commandRunner('tailscale', ['status', '--json'], { timeoutMs: 2_000 }),
    detectCommand('caddy', ['version'], commandRunner),
    detectCommand('traefik', ['version'], commandRunner),
    detectCommand('nginx', ['-v'], commandRunner),
  ]);

  const reverseProxyDetections = [
    caddyResult.available ? 'Caddy' : null,
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
      docsUrl: 'https://tailscale.com/kb',
    };
  } else if (!tailscaleResult.ok) {
    tailscaleOption = {
      id: 'tailscale',
      title: 'Tailscale private network',
      detail: 'Tailscale is installed but not currently connected. Start Tailscale or authenticate the node to offer this Phase 2 option.',
      status: 'optional',
      docsUrl: 'https://tailscale.com/kb',
    };
  } else {
    const status = parseJsonOutput<TailscaleStatus>(tailscaleResult.stdout)[0];
    const tailnet = status?.CurrentTailnet?.Name || status?.MagicDNSSuffix || 'active tailnet';
    const ipAddress = status?.Self?.TailscaleIPs?.[0];
    tailscaleOption = {
      id: 'tailscale',
      title: 'Tailscale private network',
      detail: ipAddress
        ? `Connected to ${tailnet} and reachable on ${ipAddress}. LocalLink can offer a private Phase 2 edge without a public reverse proxy.`
        : `Connected to ${tailnet}. LocalLink can offer a private Phase 2 edge without a public reverse proxy.`,
      status: 'available',
      recommended: preferredEdge === 'auto' || preferredEdge === 'tailscale',
      docsUrl: 'https://tailscale.com/kb',
      detectedValue: ipAddress,
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

  const options = [tailscaleOption, reverseProxyOption, localOnlyOption];
  const availableOptions = options.filter((option) => option.status === 'available').length;

  return {
    enabled: true,
    summary:
      availableOptions > 0
        ? `${availableOptions} Phase 2 edge option${availableOptions === 1 ? '' : 's'} detected for this machine.`
        : 'No optional Phase 2 edge tooling detected yet; LocalLink stays local-only by default.',
    options,
  };
}
