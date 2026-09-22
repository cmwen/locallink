import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MDNS_SERVICE_TYPE,
  planAccessProfile,
  planAccessProfiles,
  renderAccessProfileCaddyfile,
  type AccessServiceInfo,
} from '../src/runtime/access-profiles';

function service(overrides: Partial<AccessServiceInfo> = {}): AccessServiceInfo {
  return {
    id: 'dashboard',
    name: 'LocalLink Dashboard',
    runtimeName: 'locallink-dashboard',
    runtime: 'pm2',
    port: '4010',
    ...overrides,
  };
}

test('plans the standard Tailscale profile without requiring Caddy', () => {
  const plan = planAccessProfile(
    service(),
    { id: 'tailnet', profile: 'tailscale', hostname: 'machine.tailnet.ts.net' },
    { tailscaleAvailable: true, caddyAvailable: false },
  );

  assert.equal(plan.ready, true);
  assert.equal(plan.normalized?.adapter, 'tailscale-serve');
  assert.equal(plan.route?.tailscaleServe, true);
  assert.equal(plan.route?.caddyRequired, false);
  assert.equal(plan.listener?.owner, 'tailscale');
  assert.deepEqual(plan.discovery, {
    kind: 'tailscale-dns',
    hostname: 'machine.tailnet.ts.net',
    mechanism: 'tailscale-serve',
  });
  assert.equal(plan.prerequisites.some((item) => item.id === 'caddy-runtime'), false);
  assert.equal(plan.sideEffects, 'none');
});

test('plans custom-domain Tailscale access as a Caddy route plus external DNS prerequisite', () => {
  const plan = planAccessProfile(
    service({ loopbackOnly: true }),
    { profile: 'tailscale-custom-domain', hostname: 'dashboard.example.com' },
    { caddyAvailable: true, customDnsConfigured: false },
  );

  assert.equal(plan.ready, false);
  assert.equal(plan.normalized?.adapter, 'caddy');
  assert.equal(plan.route?.caddyRequired, true);
  assert.equal(plan.listener?.owner, 'caddy');
  assert.equal(plan.listener?.port, 443);
  assert.equal(plan.discovery?.kind, 'custom-dns');
  assert.equal(plan.prerequisites.find((item) => item.id === 'custom-dns')?.owner, 'external');
  assert.equal(plan.prerequisites.find((item) => item.id === 'custom-dns')?.blocking, true);
});

test('plans LAN mDNS with direct adapter and emits DNS-SD intent without custom DNS', () => {
  const plan = planAccessProfile(
    service({ listenHost: '192.168.1.20', lanReachable: true }),
    {
      profile: 'lan-mdns',
      hostname: 'dashboard.local',
      serviceType: DEFAULT_MDNS_SERVICE_TYPE,
      instanceName: 'Dashboard',
    },
    { mdnsAvailable: true, caddyAvailable: false },
  );

  assert.equal(plan.ready, true);
  assert.equal(plan.normalized?.adapter, 'direct');
  assert.equal(plan.route?.caddyRequired, false);
  assert.equal(plan.listener?.owner, 'service');
  assert.deepEqual(plan.discovery, {
    kind: 'mdns-dns-sd',
    hostname: 'dashboard.local',
    serviceType: '_locallink._tcp',
    instanceName: 'Dashboard',
    targetHost: '192.168.1.20',
    port: 4010,
    protocol: 'http',
    path: '/',
    txt: {
      id: 'dashboard',
      profile: 'lan-mdns',
      path: '/',
      protocol: 'http',
    },
  });
  assert.equal(plan.prerequisites.some((item) => item.id === 'custom-dns'), false);
});

test('selects Caddy for a loopback-only LAN service and makes it an explicit prerequisite', () => {
  const plan = planAccessProfile(
    service({ listenHost: '127.0.0.1' }),
    { profile: 'lan-mdns', hostname: 'dashboard.local' },
    { caddyAvailable: true, mdnsAvailable: true },
  );

  assert.equal(plan.ready, true);
  assert.equal(plan.normalized?.adapter, 'caddy');
  assert.equal(plan.route?.caddyRequired, true);
  assert.equal(plan.listener?.port, 80);
  assert.equal(plan.discovery?.kind, 'mdns-dns-sd');
});

test('does not claim a direct LAN route for a loopback-only service', () => {
  const plan = planAccessProfile(
    service({ loopbackOnly: true }),
    { profile: 'lan-mdns', hostname: 'dashboard.local', adapter: 'direct' },
    { mdnsAvailable: true },
  );

  assert.equal(plan.ready, false);
  assert.equal(plan.prerequisites.find((item) => item.id === 'lan-listener')?.status, 'error');
});

test('validates all three hostname patterns and rejects a cross-profile hostname', () => {
  const result = planAccessProfiles({
    service: service(),
    runtime: { tailscaleAvailable: true, mdnsAvailable: true, caddyAvailable: true, customDnsConfigured: true },
    declarations: [
      { profile: 'tailscale', hostname: 'machine.example.com' },
      { profile: 'tailscale-custom-domain', hostname: 'dashboard.example.com' },
      { profile: 'lan-mdns', hostname: 'dashboard.local' },
    ],
  });

  assert.equal(result.profiles[0]?.ready, false);
  assert.equal(result.profiles[0]?.prerequisites.find((item) => item.id === 'hostname')?.status, 'error');
  assert.equal(result.profiles[1]?.ready, true);
  assert.equal(result.profiles[2]?.ready, true);
  assert.equal(result.ready, false);
});

test('keeps Caddy and DNS side-effect-free when prerequisites are unknown', () => {
  const result = planAccessProfiles({
    service: service({ loopbackOnly: true }),
    declarations: [
      { profile: 'tailscale-custom-domain', hostname: 'dashboard.example.com' },
      { profile: 'lan-mdns', hostname: 'dashboard.local' },
    ],
  });

  assert.equal(result.sideEffects, 'none');
  assert.equal(result.profiles[0]?.prerequisites.find((item) => item.id === 'caddy-runtime')?.status, 'warning');
  assert.equal(result.profiles[0]?.prerequisites.find((item) => item.id === 'custom-dns')?.status, 'warning');
  assert.equal(result.profiles[1]?.normalized?.adapter, 'caddy');
  assert.equal(result.profiles[1]?.prerequisites.find((item) => item.id === 'caddy-runtime')?.status, 'warning');
  const caddyfile = renderAccessProfileCaddyfile(result.profiles);
  assert.match(caddyfile, /BEGIN LOCALLINK MANAGED CUSTOM DOMAIN ROUTES/);
  assert.match(caddyfile, /dashboard\.example\.com/);
  assert.match(caddyfile, /BEGIN LOCALLINK MANAGED LAN MDNS ROUTES/);
  assert.match(caddyfile, /http:\/\/dashboard\.local:80/);
});
