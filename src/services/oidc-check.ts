import type { ApplicationServiceContract } from './application-contract';

export type OidcCheckStatus = 'ready' | 'action-required' | 'blocked' | 'not-declared';
export type OidcCheckSeverity = 'pass' | 'warning' | 'blocked' | 'missing';

export interface OidcCheckResult {
  version: 1;
  workspace: ApplicationServiceContract['workspace'];
  service: ApplicationServiceContract['service'];
  status: OidcCheckStatus;
  canonical: {
    publicServiceUrl?: string;
    issuerUrl?: string;
    discoveryUrl?: string;
    callbackUrl?: string;
    postLogoutRedirectUrl?: string;
    scopes: string[];
  };
  proxy: {
    detected: boolean;
    internalServiceUrl?: string;
    internalCallbackUrl?: string;
    publicServiceUrl?: string;
    publicCallbackUrl?: string;
    callbackDiffers: boolean;
    detail: string;
  };
  openidClient: {
    redirectUri?: string;
    issuer?: string;
    scopes: string[];
    usePublicRedirectUriForAuthorization: true;
    usePublicRedirectUriForTokenExchange: true;
  };
  environment: ApplicationServiceContract['identity']['environment'];
  checks: Array<{
    id: string;
    severity: OidcCheckSeverity;
    detail: string;
  }>;
  nextSteps: string[];
}

function callbackPath(callbackUrl: string | undefined): string | undefined {
  if (!callbackUrl) return undefined;
  try {
    const url = new URL(callbackUrl);
    return `${url.pathname}${url.search}` || '/';
  } catch {
    return undefined;
  }
}

function joinUrl(origin: string | undefined, path: string | undefined): string | undefined {
  if (!origin || !path) return undefined;
  try {
    const url = new URL(origin);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}` || '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function buildOidcCheck(contract: ApplicationServiceContract): OidcCheckResult {
  const publicServiceUrl = contract.privateEdge.url;
  const callbackUrl = contract.identity.callbackUrl;
  const internalCallbackUrl = joinUrl(contract.local.url, callbackPath(callbackUrl));
  const callbackDiffers = Boolean(
    internalCallbackUrl
    && callbackUrl
    && safeUrl(internalCallbackUrl) !== safeUrl(callbackUrl),
  );
  const clientConfigured = contract.identity.environment
    .filter((entry) => entry.key.endsWith('_OIDC_CLIENT_ID') || entry.key.endsWith('_OIDC_CLIENT_SECRET'))
    .every((entry) => entry.configured);
  const providerReady = Boolean(contract.identity.issuerUrl && contract.identity.discoveryUrl);
  const routeReady = contract.privateEdge.state === 'ready';

  const checks: OidcCheckResult['checks'] = [
    {
      id: 'service-oidc-declaration',
      severity: contract.identity.declared ? 'pass' : 'missing',
      detail: contract.identity.declared
        ? 'The service declares its provider-neutral OIDC integration.'
        : 'Declare integrations.identity with callback/logout paths, scopes, and an environment prefix.',
    },
    {
      id: 'private-edge-public-url',
      severity: routeReady ? 'pass' : 'blocked',
      detail: routeReady
        ? `The canonical private public service URL is ${publicServiceUrl}.`
        : `The service does not have an active canonical Private Edge URL: ${contract.privateEdge.detail}`,
    },
    {
      id: 'oidc-issuer-discovery',
      severity: providerReady ? 'pass' : 'blocked',
      detail: providerReady
        ? `Use ${contract.identity.issuerUrl} as the issuer and ${contract.identity.discoveryUrl} for discovery.`
        : 'The identity provider is not healthy or its issuer is not available yet.',
    },
    {
      id: 'public-callback-uri',
      severity: callbackUrl && routeReady ? 'pass' : 'blocked',
      detail: callbackUrl && routeReady
        ? `Register and send the public callback URI ${callbackUrl}.`
        : 'A public callback URI cannot be finalized until the service integration and Private Edge route are ready.',
    },
    {
      id: 'reverse-proxy-boundary',
      severity: callbackDiffers ? 'warning' : 'pass',
      detail: callbackDiffers
        ? `The internal callback ${internalCallbackUrl} differs from the public callback ${callbackUrl}; do not derive redirect_uri from the incoming internal request URL.`
        : 'No internal/public callback origin mismatch was detected.',
    },
    {
      id: 'oidc-client-registration',
      severity: clientConfigured ? 'pass' : 'warning',
      detail: clientConfigured
        ? 'The named OIDC client ID and secret environment values are configured.'
        : 'Register one confidential OIDC client and store its ID and secret in the named local environment keys.',
    },
  ];

  const nextSteps = [...contract.nextSteps];
  if (callbackDiffers) {
    nextSteps.push('Configure openid-client with the canonical public callback URI for both authorization redirect_uri and token exchange redirect_uri; do not use the loopback callback URI.');
  }
  if (!nextSteps.some((step) => step.includes('openid-client'))) {
    nextSteps.push('Use the canonical issuer and public redirect URI above in the application OIDC adapter, and keep provider-specific claims behind that adapter.');
  }

  const status: OidcCheckStatus = !contract.identity.declared
    ? 'not-declared'
    : !routeReady || !providerReady || !callbackUrl
      ? 'blocked'
      : !clientConfigured
        ? 'action-required'
        : 'ready';

  return {
    version: 1,
    workspace: contract.workspace,
    service: contract.service,
    status,
    canonical: {
      publicServiceUrl,
      issuerUrl: contract.identity.issuerUrl,
      discoveryUrl: contract.identity.discoveryUrl,
      callbackUrl,
      postLogoutRedirectUrl: contract.identity.postLogoutRedirectUrl,
      scopes: contract.identity.scopes,
    },
    proxy: {
      detected: callbackDiffers,
      internalServiceUrl: contract.local.url,
      internalCallbackUrl,
      publicServiceUrl,
      publicCallbackUrl: callbackUrl,
      callbackDiffers,
      detail: callbackDiffers
        ? 'The reverse proxy changes the callback origin. The application must use the canonical public callback URI.'
        : 'No reverse-proxy callback-origin difference was detected.',
    },
    openidClient: {
      redirectUri: callbackUrl,
      issuer: contract.identity.issuerUrl,
      scopes: contract.identity.scopes,
      usePublicRedirectUriForAuthorization: true,
      usePublicRedirectUriForTokenExchange: true,
    },
    environment: contract.identity.environment,
    checks,
    nextSteps,
  };
}
