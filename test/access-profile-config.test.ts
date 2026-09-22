import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigRepository } from '../src/config/files';

async function createTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'locallink-access-profile-'));
}

test('ConfigRepository parses the three access profiles from services and ecosystem declarations', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, 'locallink.services.yml'),
    `services:
  - name: Home Media
    group: pm2
    integrations:
      access:
        endpoints:
          - id: home-lan
            profile: lan-mdns
            hostname: media.local
            serviceType: _http._tcp
            adapter: direct
`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'ecosystem.config.js'),
    `module.exports = {
  apps: [
    {
      name: 'Dashboard',
      script: './dashboard.js',
      locallink: {
        integrations: {
          access: {
            endpoints: [
              { id: 'tailnet', profile: 'tailscale', adapter: 'tailscale-serve' },
              {
                id: 'branded',
                profile: 'tailscale-custom-domain',
                hostname: 'dashboard.example.net',
                protocol: 'https',
                adapter: 'caddy',
                dnsReady: true,
              },
            ],
          },
        },
      },
    },
  ],
};
`,
    'utf8',
  );

  const model = await new ConfigRepository(root).loadProjectModel();
  const media = model.definitions.find((service) => service.name === 'Home Media');
  const dashboard = model.definitions.find((service) => service.name === 'Dashboard');

  assert.deepEqual(media?.integrations?.access, {
    endpoints: [{
      id: 'home-lan',
      profile: 'lan-mdns',
      hostname: 'media.local',
      serviceType: '_http._tcp',
      adapter: 'direct',
    }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(dashboard?.integrations?.access)), {
    endpoints: [
      { id: 'tailnet', profile: 'tailscale', adapter: 'tailscale-serve' },
      {
        id: 'branded',
        profile: 'tailscale-custom-domain',
        hostname: 'dashboard.example.net',
        protocol: 'https',
        adapter: 'caddy',
        dnsReady: true,
      },
    ],
  });
});

test('ConfigRepository parses Compose access labels and preserves privateEdge compatibility', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    `services:
  dashboard:
    image: example/dashboard
    labels:
      locallink.privateEdgeLocalOrigin: "true"
      locallink.accessEndpoints: '[{"id":"tailnet","profile":"tailscale"},{"id":"lan","profile":"lan-mdns","hostname":"dashboard.local","serviceType":"_locallink._tcp","adapter":"caddy"}]'
`,
    'utf8',
  );

  const model = await new ConfigRepository(root).loadProjectModel();
  const dashboard = model.definitions.find((service) => service.runtimeName === 'dashboard');

  assert.deepEqual(dashboard?.integrations?.privateEdge, {
    localOrigin: true,
    anonymousCors: false,
    publicPortEnv: undefined,
    publicOriginEnv: undefined,
  });
  assert.deepEqual(dashboard?.integrations?.access, {
    endpoints: [
      { id: 'tailnet', profile: 'tailscale' },
      {
        id: 'lan',
        profile: 'lan-mdns',
        hostname: 'dashboard.local',
        serviceType: '_locallink._tcp',
        adapter: 'caddy',
      },
    ],
  });
});

test('ConfigRepository ignores unsupported access profiles and normalizes supported label declarations', async () => {
  const root = await createTempProject();
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    `services:
  api:
    image: example/api
    labels:
      locallink.access.profile: LAN-MDNS
      locallink.access.hostname: api.local
      locallink.access.serviceType: _http._tcp
      locallink.access.0.profile: tailscale-custom-domain
      locallink.access.0.hostname: api.example.net
      locallink.access.0.adapter: CADDY
      locallink.access.1.profile: unsupported
`,
    'utf8',
  );

  const model = await new ConfigRepository(root).loadProjectModel();
  const api = model.definitions.find((service) => service.runtimeName === 'api');

  assert.deepEqual(api?.integrations?.access, {
    endpoints: [
      {
        id: 'lan-mdns-1',
        profile: 'lan-mdns',
        hostname: 'api.local',
        serviceType: '_http._tcp',
      },
      {
        id: '0',
        profile: 'tailscale-custom-domain',
        hostname: 'api.example.net',
        adapter: 'caddy',
      },
    ],
  });
});
