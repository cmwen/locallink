import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeManagedCaddyfile, removeManagedCaddyfileBlock } from '../src/runtime/caddy-runtime';

test('managed Caddy blocks compose without overwriting another profile', () => {
  const existing = `{
  admin 127.0.0.1:2019
}

# BEGIN LOCALLINK MANAGED PRIVATE EDGE ROUTES
:24001 {
  reverse_proxy 127.0.0.1:5050
}
# END LOCALLINK MANAGED PRIVATE EDGE ROUTES
`;
  const customDomain = `# BEGIN LOCALLINK MANAGED CUSTOM DOMAIN ROUTES
dashboard.example.com {
  reverse_proxy 127.0.0.1:4173
}
# END LOCALLINK MANAGED CUSTOM DOMAIN ROUTES
`;

  const merged = mergeManagedCaddyfile(existing, customDomain);

  assert.match(merged, /BEGIN LOCALLINK MANAGED PRIVATE EDGE ROUTES/);
  assert.match(merged, /reverse_proxy 127\.0\.0\.1:5050/);
  assert.match(merged, /BEGIN LOCALLINK MANAGED CUSTOM DOMAIN ROUTES/);
  assert.match(merged, /dashboard\.example\.com/);
});

test('managed Caddy merge replaces only the matching profile block', () => {
  const existing = `# BEGIN LOCALLINK MANAGED PRIVATE EDGE ROUTES
:24001 {
  reverse_proxy 127.0.0.1:5050
}
# END LOCALLINK MANAGED PRIVATE EDGE ROUTES

# BEGIN LOCALLINK MANAGED LAN MDNS ROUTES
http://dashboard.local {
  reverse_proxy 127.0.0.1:4173
}
# END LOCALLINK MANAGED LAN MDNS ROUTES
`;
  const nextLan = `# BEGIN LOCALLINK MANAGED LAN MDNS ROUTES
http://home.local {
  reverse_proxy 127.0.0.1:8080
}
# END LOCALLINK MANAGED LAN MDNS ROUTES
`;

  const merged = mergeManagedCaddyfile(existing, nextLan);

  assert.match(merged, /reverse_proxy 127\.0\.0\.1:5050/);
  assert.doesNotMatch(merged, /dashboard\.local/);
  assert.match(merged, /http:\/\/home\.local/);
});

test('managed Caddy removal preserves blocks owned by other profiles', () => {
  const existing = `# BEGIN LOCALLINK MANAGED PRIVATE EDGE ROUTES
:24001 {
  reverse_proxy 127.0.0.1:5050
}
# END LOCALLINK MANAGED PRIVATE EDGE ROUTES

# BEGIN LOCALLINK MANAGED CUSTOM DOMAIN ROUTES
dashboard.example.com {
  reverse_proxy 127.0.0.1:4173
}
# END LOCALLINK MANAGED CUSTOM DOMAIN ROUTES
`;

  const removed = removeManagedCaddyfileBlock(existing, 'PRIVATE EDGE ROUTES');

  assert.doesNotMatch(removed, /PRIVATE EDGE ROUTES/);
  assert.match(removed, /CUSTOM DOMAIN ROUTES/);
  assert.match(removed, /dashboard\.example\.com/);
});
