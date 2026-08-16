# ART-207: authentication provider evaluation

**Decision:** use **Auth0** as Serein's identity provider.

This is a security-driven choice. ART-207 requires a private product with native
OAuth/OIDC using PKCE, one identity across Next.js and iOS, revocable sessions,
and a secure **HttpOnly** web session. Auth0 is the only evaluated provider whose
official Next.js SDK documents the last requirement directly: its session and
transaction cookies are encrypted with `AUTH0_SECRET` and its `httpOnly` setting
is always true ([SDK reference](https://auth0.github.io/nextjs-auth0/)).

Use one Auth0 tenant, with two applications in it:

- a **Regular Web Application** for `apps/web`;
- a **Native Application** for `apps/ios`.

The API must use the validated OIDC subject (`sub`) as the immutable external
identity key when it creates or looks up the user's finance workspace. A web
cookie and the iOS credential are intentionally separate sessions; they are not
supposed to be shared. The common tenant and `sub` are what make the identity
shared across clients.

## Evaluation

| Requirement                       | Auth0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Clerk                                                                                                                                                                                                                                                                                                    | Supabase Auth                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private onboarding / allowlisting | Meets it. Disable public sign-up on the database connection and create approved users through the Dashboard or Management API; Auth0 documents that disabled sign-up still permits API/Dashboard user creation ([database connection docs](https://auth0.com/docs/authenticate/database-connections/passwordless-authentication-for-db-connect)). A Pre User Registration Action can enforce an explicit email/invitation allowlist before a Database or Passwordless user is created ([trigger docs](https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/pre-user-registration-trigger)). | Strongest managed invite experience: Restricted mode admits invitations, manual creation, and enterprise connections only ([restrictions](https://clerk.com/docs/guides/secure/restricting-access)). Identifier allowlists are a paid production feature.                                                | Can disable sign-up and issue approved email invitations through the server-side Admin API ([configuration](https://supabase.com/docs/guides/self-hosting/auth/config), [invites](https://supabase.com/docs/guides/auth/users)). This would need product-owned allowlist/invitation administration.                            |
| Expo native OAuth/OIDC with PKCE  | Meets it. The official Expo quickstart uses a Native application, `react-native-auth0`, and secure system-browser login. A Native app must use a development build rather than Expo Go ([Expo quickstart](https://auth0.com/docs/quickstart/native/react-native-expo)).                                                                                                                                                                                                                                                                                                                                                    | Meets it. Clerk supports Expo OAuth and public OAuth clients with PKCE ([Expo quickstart](https://clerk.com/docs/expo/getting-started/quickstart), [PKCE](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth)). Native UI/OAuth paths require a development build. | Meets it. Its React Native/Expo guide supports social OAuth and the documented PKCE flow; native redirect/deep-link handling is application work ([Expo social auth](https://supabase.com/docs/guides/auth/quickstarts/with-expo-react-native-social-auth), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)). |
| Next.js HttpOnly session          | **Meets the stated requirement.** The Auth0 Next.js SDK uses encrypted, HttpOnly session cookies ([SDK reference](https://auth0.github.io/nextjs-auth0/)); the official quickstart provides server-side session and protected-route patterns ([Next.js quickstart](https://auth0.com/docs/quickstart/webapp/nextjs)).                                                                                                                                                                                                                                                                                                      | **Does not meet the requirement literally.** Clerk's app-domain `__session` cookie is deliberately not HttpOnly so its client SDK can access it; it is short-lived (60 seconds) and Clerk documents its mitigation ([cookie architecture](https://clerk.com/docs/guides/how-clerk-works/overview)).      | **Does not meet the requirement literally.** Supabase documents that browser-side code needs access to the refresh token and therefore does not recommend HttpOnly cookies for its SSR session model ([SSR guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)).                                          |
| Revocation                        | Meets it. Refresh tokens can be invalidated with `/oauth/revoke`; the configured setting determines whether the entire grant is also revoked ([revoke endpoint](https://auth0.com/docs/api/authentication/revoke-refresh-token/revoke-refresh-token)).                                                                                                                                                                                                                                                                                                                                                                     | Meets it. A backend can revoke an individual session with `revokeSession` ([session API](https://clerk.com/docs/reference/backend/sessions/revoke-session)).                                                                                                                                             | Meets it, with a limitation: global sign-out destroys refresh tokens and sessions, but a revoked access-token JWT remains valid until its expiry ([sign-out](https://supabase.com/docs/guides/auth/signout)).                                                                                                                  |
| One identity across web and iOS   | Meets it by registering both apps in the same tenant and treating OIDC `sub` as the backend identity key. This is an architectural use of the provider's stable user identity, not cookie sharing.                                                                                                                                                                                                                                                                                                                                                                                                                         | Meets it with both SDKs connected to one Clerk instance; session storage is still platform-specific.                                                                                                                                                                                                     | Meets it with both clients connected to one Supabase project; session storage is still platform-specific.                                                                                                                                                                                                                      |

## Recommendation and trade-offs

Auth0 is recommended because the HttpOnly web-session requirement is
non-negotiable for a personal-finance product. Its main costs are two application
registrations, more initial dashboard configuration than Clerk's managed
components, and a development-build requirement for native Expo authentication.
Clerk remains a good alternative if fast invite-only UX or Expo Go support becomes
more important than an app-domain HttpOnly session cookie. Supabase Auth is not
recommended for this ticket because its documented SSR model intentionally keeps
refresh tokens available to browser code.

## Required Auth0 configuration

### Applications and connections

1. Create one Auth0 tenant and use a custom domain before production.
2. Create the Regular Web Application and the Native Application in that tenant.
3. Enable only the intended connection(s) for both applications. Start with
   verified email/passwordless access; do not enable unaudited social connections.
4. Enforce private access with one of these mutually exclusive launch policies:
   - **Approved-user launch (recommended):** disable public sign-ups; create each
     approved user using the Auth0 Dashboard or Management API.
   - **Invitation launch:** keep the registration path needed for an invitation,
     but add a blocking Pre User Registration Action that denies any email not in
     the server-maintained allowlist or an unconsumed invitation. Fail closed when
     the allowlist lookup is unavailable.
5. Require verified email before the application treats the identity as eligible
   for a finance workspace. Do not put finance data or authorization state in
   mutable user metadata.

### Callback and logout URLs

The current Expo configuration already declares `scheme: "serein"` and iOS bundle
identifier `com.artech2077.serein`. Auth0's Expo quickstart specifies the native
callback shape as `{customScheme}://{tenantDomain}/{platform}/{bundleIdentifier-or-package}/callback`
([callback format](https://auth0.com/docs/quickstart/native/react-native-expo)).

Register these exact patterns after choosing the tenant domain; replace
`<tenant-domain>` with it:

| Environment                        | Allowed Callback URL                                               | Allowed Logout URL                                                 |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Web development                    | `http://localhost:3000/auth/callback`                              | `http://localhost:3000`                                            |
| Web production                     | `https://<web-host>/auth/callback`                                 | `https://<web-host>`                                               |
| iOS                                | `serein://<tenant-domain>/ios/com.artech2077.serein/callback`      | `serein://<tenant-domain>/ios/com.artech2077.serein/callback`      |
| Android (when package name is set) | `serein://<tenant-domain>/android/<android-package-name>/callback` | `serein://<tenant-domain>/android/<android-package-name>/callback` |

The web quickstart documents the development callback, logout, and web-origin
entries, as well as the auto-mounted `/auth/callback` route
([Next.js quickstart](https://auth0.com/docs/quickstart/webapp/nextjs)). Add only
the deployed HTTPS origin to Allowed Web Origins. Keep preview URLs out unless
they are deliberately needed and individually allowlisted.

## Remaining setup work

1. Add the Android `package` identifier to `apps/ios/app.json` before enabling
   Android, then register its exact callback and logout URLs.
2. Add `@auth0/nextjs-auth0` to `apps/web`, configure `AUTH0_DOMAIN`,
   `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, and the web base URL
   as deployment secrets, and protect routes/server actions with the SDK. Never
   expose a client secret to the browser.
3. Add `react-native-auth0` and its Expo config plugin to `apps/ios`; use
   `authorize()` with `openid profile email` and use the platform's secure
   credential storage through the SDK. Build a development client to test it.
4. Make the Fastify API validate issuer, audience, signature, expiry, and
   `sub` for bearer access tokens. Map `sub` to the finance workspace on the
   server; clients must not supply a workspace identity.
5. Implement logout as a local web session clear plus Auth0 logout, and native
   credential clear plus Auth0 revocation where appropriate. Document which
   operation is "this device" versus "all devices." Keep access-token lifetimes
   short because JWT access tokens cannot be individually revoked once issued.
6. Add end-to-end tests for: unapproved sign-up denied; approved sign-in works on
   web and iOS with the same `sub`; callback mismatch fails; API rejects an
   invalid/expired token; and revoked refresh credentials cannot renew a session.

## Sources and scope

All links in this document are first-party provider documentation or provider SDK
reference documentation. The findings are current as of 2026-08-16. This ticket
records the provider and security design only; it deliberately does not add an
Auth0 tenant, credentials, application code, or production redirect URLs.
