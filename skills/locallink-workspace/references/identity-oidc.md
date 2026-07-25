# Provider-neutral OIDC integration

## Boundary

Tailscale controls private network reachability. Pocket ID provides application identity after the user reaches the service. Do not replace either boundary with the other.

LocalLink can install Pocket ID, derive its private issuer, preserve its key/data, and verify runtime health. The user must complete the first administrator/passkey setup, approve callback/logout URLs, and create one OIDC client per application.

## Discover the issuer and manual state

Run:

```bash
locallink service contract <service-id-or-runtime-name>
locallink extension plan identity
locallink extensions
```

Use the application contract’s issuer, callback, logout, scopes, and environment
key names. Use `service.issuer` from the shared identity plan only when diagnosing
the provider. If route publication is pending, report that dependency rather
than inventing a hostname.

## Application contract

Declare a service-specific prefix and paths in the service metadata. LocalLink
then derives a contract equivalent to:

```dotenv
EXAMPLE_OIDC_ISSUER_URL=https://private-issuer.example/
EXAMPLE_OIDC_CLIENT_ID=
EXAMPLE_OIDC_CLIENT_SECRET=
EXAMPLE_OIDC_REDIRECT_URI=https://private-app.example/auth/callback
EXAMPLE_OIDC_POST_LOGOUT_REDIRECT_URI=https://private-app.example/
EXAMPLE_OIDC_SCOPES=openid profile email
```

Commit blank secret placeholders only. Store the real client ID/secret in ignored local configuration. Never reuse Pocket ID’s encryption key as an application client secret.

## Adapter rules

- Discover authorization, token, user-info, end-session, and JWKS endpoints from `ISSUER/.well-known/openid-configuration`.
- Validate issuer, signature, audience, expiry, nonce, and state.
- Use Authorization Code flow with PKCE.
- Keep session cookies `HttpOnly`, `Secure`, and appropriately `SameSite`.
- Keep provider-specific claims behind an adapter that maps to the application’s internal user/session type.
- Do not use an insecure callback URL merely to avoid configuring the private HTTPS route.
- Do not log authorization codes, tokens, cookies, client secrets, or raw claims.

## Client registration handoff

Give the user an exact registration checklist:

- client display name;
- callback URL(s);
- post-logout URL(s);
- scopes;
- whether the app is public or confidential;
- where the returned client ID and secret must be stored.

Do not claim LocalLink created a client until an authenticated provider API or explicit user action proves it.

## Verification

Verify OIDC discovery first, then:

1. unauthenticated access starts one authorization flow;
2. callback returns to the intended private origin;
3. session survives a normal page reload;
4. logout clears the local session and uses the configured provider flow;
5. expired or invalid state/nonce is rejected;
6. login does not loop between callback and sign-in;
7. no secret or token appears in logs or dashboard metadata.
