# LabelScan client applications

This document explains the two client experiences that ship with LabelScan:

- the Expo mobile app used by store operators to capture and review labels;
- the React back office used to search arrivals and manage authorized accounts.

The interfaces are written in French for their users. This guide is written in
English for contributors and operators. It describes the behavior that is present
in the repository, including known limitations, so that a reader does not need
historical project context to understand the product.

The backend remains the source of truth for identity, tenant access, extraction,
validation, and saved arrival records. Client-side route guards, profile constants,
and caches improve the experience; they are not authorization boundaries.

## At a glance

| Client | Primary users | Main purpose | Technology |
| --- | --- | --- | --- |
| Mobile app | Store managers assigned to one active business portal | Capture a label, monitor extraction, review every business field, and save the arrival | Expo SDK 57, React Native 0.86, React 19.2 |
| Back office | Managers, administrators, and super administrators | Browse authorized arrivals and manage the identities allowed by the current role | React 19, Vite 7, Wouter |

The normal business flow is:

~~~text
Camera capture
  → durable local queue
  → authenticated ingestion
  → server-side OCR and extraction
  → operator review
  → atomic server finalization
  → mobile catalogue and web back office
~~~

The mobile app never performs the authoritative OCR or business validation itself.
It prepares the image, provides immediate barcode context, and asks the server to do
the extraction.

## Supported trade profiles

LabelScan supports three profession codes. A profile controls the field groups,
labels, completeness indicator, suggestions, filters, and detail presentation.

| Profession code | User-facing name | Information covered |
| --- | --- | --- |
| <code>poissonnerie</code> | Poissonnerie | Product and species identification, fishing or farming method, FAO area, origin, sanitary traceability, dates, storage, allergens, and commercial data |
| <code>boucherie</code> | Boucherie | Product, animal and cut identification, birth/rearing/slaughter/cutting countries, establishment approvals, traceability, dates, storage, allergens, and commercial data |
| <code>charcuterie_traiteur</code> | Charcuterie / Traiteur | Product and manufacturer identification, ingredients, additives, allergens, instructions, sanitary traceability, preparation/packaging/expiry data, conditioning, storage, and commercial data |

The active mobile presentation contract is profile version 2. The mobile profile
definitions live in
[src/services/businessProfiles.ts](../../src/services/businessProfiles.ts).
The back-office display definitions live in
[web/src/portals](../../web/src/portals), while the server owns its canonical
extraction and validation contracts. When a field is added or renamed, these
surfaces must be reviewed together.

The review form requires a decision for every field in the selected profile. The
operator can enter a value or explicitly mark the field as <code>NC</code>. The
smaller <code>requiredFields</code> lists in the profile configuration drive
business emphasis; they are not the complete review gate.

Review and catalogue detail always render the complete ordered profile. Machine
extraction keeps an absent value as <code>null</code>. During review, that field
remains visibly unresolved and does not count as complete until the operator enters
a value or explicitly chooses <code>NC</code>. Only a finalized human decision and the
resulting catalogue projection display the exact <code>NC</code> marker; the row is
never hidden. Machine proposals marked ambiguous, invalid, or unnormalizable follow the
same rule: they stay visible as suggestions but require an explicit confirmation,
correction, or <code>NC</code> decision.

The server selects the profile from the authenticated portal. The mobile app does
not let an operator choose a tenant or profession for an upload.

## Mobile app

### Platform and build contract

The exact installed versions are authoritative in
[package.json](../../package.json). The current app is pinned to Expo SDK 57 and
uses the SDK 57-compatible React Native packages.

The native configuration in [app.json](../../app.json),
[app.config.js](../../app.config.js), and [eas.json](../../eas.json) defines these
product constraints:

- portrait, phone-oriented experience; iPad support is disabled;
- Android minimum SDK 33;
- camera, internet, and network-state permissions;
- microphone, system-overlay, and legacy external-storage permissions are blocked;
- Android application backup is disabled;
- release minification and resource shrinking are enabled;
- EAS preview and production builds use the HTTPS production API origin and disable
  cleartext traffic; an absent or unknown build profile also fails closed.

Only the explicit `development` profile allows a LAN HTTP endpoint so a physical device
can reach a local server. The signed release manifest/network policy still requires
verification; see [Security register and release verification](#security-register-and-release-verification).

### Local setup

From the repository root:

~~~bash
npm install
EXPO_PUBLIC_API_BASE_URL=http://YOUR-LAN-IP:8000 npm start
~~~

Use a LAN-reachable address for a physical phone. A device cannot reach a server
through the computer's <code>localhost</code>. The API URL must be HTTP or HTTPS,
must not contain embedded credentials, and must use HTTPS outside development.

Useful native commands are:

~~~bash
npm run ios
npm run android
~~~

If <code>EXPO_PUBLIC_API_BASE_URL</code> is missing during development, the client
shows a configuration error instead of silently targeting an unrelated server.
Non-development bundles have the public HTTPS origin as a fallback.

### Authentication and tenant context

Mobile login accepts manager accounts only. After credentials are accepted, the
server returns the authoritative portal and profession context. Mobile access
requires exactly one active business portal; ambiguous or unsupported assignments
are rejected instead of being guessed.

The access token, refresh credential, username, portal identifier, and trade code
are stored with Expo SecureStore using
<code>WHEN_UNLOCKED_THIS_DEVICE_ONLY</code>. On a cold start, the refresh
credential is validated before the app enters the signed-in state. An authenticated
request that receives a 401 gets one refresh attempt; if that fails, local session
state is cleared and the login screen is shown.

The API derives tenant access from the authenticated identity. Portal identifiers
stored locally are used to isolate presentation and queued work; they are not sent
as an authority that the server should trust.

### Navigation and screens

One root stack contains:

| Screen | Current behavior |
| --- | --- |
| Login | Restores or creates the manager session and explains configuration or credential failures |
| Articles | Shows arrivals for the current day, global search, date selection, pending scans, export actions, sign-out, and the capture button |
| Camera | Supports chained captures so the operator can photograph several labels without reviewing each one immediately |
| Review | Shows extraction progress and results, saves drafts, validates edits, and finalizes a complete arrival |
| Article detail | Displays the full saved record and protected photo |

The article-detail module contains dormant edit-related code, but the current UI
does not expose an action that enters edit mode. Saved arrivals are therefore
read-only in the mobile experience. The home screen also does not expose deletion
for saved server arrivals. Pending scans can be discarded with confirmation.

### Capture behavior

The camera is mounted only while its screen is focused. The visible guide frame is
the required capture area:

1. The app takes the photo and normalizes its orientation.
2. It maps the on-screen frame to image coordinates.
3. It crops to that frame, forces a landscape result, limits the longest dimension,
   and writes a compressed JPEG.
4. It attempts to copy the prepared image to durable pending storage, then creates a
   queued ingestion. The current fallback to the original temporary URI when that copy
   fails is an open durability risk described below.
5. The shutter becomes available for the next label while upload and extraction
   continue in the background.

If the frame cannot be mapped or the prepared file is invalid, the app alerts the
operator and does not upload the uncropped original as a fallback.

The camera can recognize EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, and QR
codes. The most recently detected value is attached to the next capture. Barcode
detection does not trigger the shutter automatically.

The screen also provides torch control, haptic feedback, a brief capture flash, and
an explicit permission state.

### Queue, offline work, and synchronization

Each capture has a local scan identifier and one of these visible workflow states:

| State | Meaning |
| --- | --- |
| <code>submitting</code> | The prepared photo is waiting for or performing upload |
| <code>extracting</code> | The server accepted the image and is processing it |
| <code>ready</code> | A final extraction is available for review |
| <code>recapture_required</code> | The server result cannot support a useful review |
| <code>submit_error</code> | Upload reached a non-recoverable state |
| <code>extract_error</code> | Extraction failed or could not be completed in the polling budget |

The scan queue persists its workflow metadata and pending photo URI. Final and
interim extraction responses are kept in memory; after a restart the app refetches
them from the server. Polling is bounded, pauses while the app is in the background,
and resumes when the app returns to the foreground. Server content deduplication is
limited to idempotent replay: reconciliation removes a second local card only when the
same request key returns an ingestion already attached to another card. Each new capture
receives a new idempotency key, so submitting identical image bytes as a separate capture
can create another ingestion and card.

A separate durable outbox stores write operations with stable idempotency and
correlation identifiers. Due work is replayed at app startup, when the app returns
to the foreground, and when network connectivity returns. Retryable network, rate
limit, and server errors use bounded backoff; non-retryable or exhausted operations
become dead letters.

New outbox operations include the local portal and trade owner, and replay requires
those two values to match. The owner record does not include the organization or actor,
so a different manager in the same portal and trade can still inherit queued work.
Historical unowned operations create an additional cross-context risk. Both gaps are
documented in [Open audit findings](#open-audit-findings).

### Review and finalization

The review screen is opened by local scan ID and reads live queue state rather than
copying extraction data into navigation parameters. It can show an early GS1 or
interim preview while extraction is running, then replaces that preview with the
final run.

The operator can:

- edit every field in the active trade profile;
- mark unknown information as <code>NC</code>;
- rotate the photo by half a turn;
- zoom and pan the protected image;
- leave and resume a locally saved draft;
- use selected suggestions from previously saved arrivals.

Client checks provide fast feedback for dates, GTIN values, production methods, and
profile completeness. Seafood allergen suggestions are deterministic and are never
applied automatically. The client does not infer FAO area, origin, or expiry values
that are not supported by the extraction.

If no useful canonical field is available, the screen asks for a new capture rather
than presenting a misleading blank approval flow.

Finalization sends the complete reviewed field set and chosen photo orientation in
one idempotent server operation. The pending card remains visible until that
operation succeeds, so a transient connection failure is not presented as a saved
arrival.

### Catalogue, search, and export

The home screen opens on the device's current local calendar day. Choosing another
day filters saved arrivals, while text search remains global across the loaded
catalogue. Pending work stays visible regardless of the selected day. Pull to
refresh asks the server for current data.

TanStack Query is the primary catalogue source and persists a cache for offline
startup. A legacy local article store remains as a fallback for older data. Opening
a record requests the full server detail and can fall back to the cached summary if
the detail request is unavailable.

Export acts on the catalogue currently loaded by the client:

- JSON writes the complete in-memory article objects;
- CSV writes selected identifiers, dates, status, barcode, photo URL, and structured
  field data.

The system share sheet controls the destination after the file is written. Export
does not mean that LabelScan has uploaded the file to a third-party service. Local
retention and the current JSON credential leak are documented below.

### Mobile state and storage

| Data | Storage | Lifecycle and purpose |
| --- | --- | --- |
| Access and refresh credentials, username, portal, trade | SecureStore | Restored and validated on startup; cleared on sign-out or unrecoverable authentication failure |
| Catalogue query cache | AsyncStorage | Offline catalogue hydration with a configured maximum age |
| Scan queue and review drafts | AsyncStorage | Survive navigation and restarts until a scan is finalized or discarded |
| Outbox operations | AsyncStorage | Survive transient failures until success, dead-letter cleanup, or explicit discard |
| Interim and final extraction snapshots | Memory | Refetched during queue reconciliation after a restart |
| Pending capture JPEGs | Expo document directory | Removed after successful finalization/discard; orphan files are swept during queue initialization |
| Confirmed-photo copies | Expo document directory | Support the optimistic saved card; no explicit lifecycle cleanup is currently implemented |
| JSON and CSV export files | Expo document directory | Fixed filenames are overwritten by the next export of the same format, but are not deleted after sharing or sign-out |

AsyncStorage and the Expo document directory are application-private storage, not a
cryptographic secret store. They can contain business records and label images and
must be treated as sensitive device data.

The installed Android AsyncStorage adapter keeps a 6 MB default limit for its complete
database. Splitting legacy articles into per-record keys avoids one growing JSON entry and
full-list rewrites, but it does not remove that global capacity limit. Catalogue cache,
queues, drafts, outbox entries, and legacy records therefore need bounded retention,
visible quota-error handling, and capacity testing; sustained record storage should move
to a database designed for that workload.

## React back office

### Delivery and local development

The browser application lives in [web](../../web). Its production base path is
<code>/backoffice/</code>. The server image builds the Vite bundle and serves it
alongside the FastAPI application, so browser calls to <code>/v1</code> remain on
the same origin.

For a frontend-only development session:

~~~bash
cd web
npm install
npm run dev
~~~

The Vite development configuration does not proxy <code>/v1</code>. A standalone
Vite page therefore cannot complete real authenticated API calls unless a
same-origin reverse proxy or equivalent local environment is provided. Use the
repository's full-stack container setup for the integrated experience.

### Browser session

Login includes the organization slug, username, and password. The browser keeps the
short-lived access token in React memory only. Session renewal uses a same-origin,
HttpOnly refresh cookie with strict same-site behavior and the Secure flag in
production. Access tokens are not written to localStorage or sessionStorage.

After login or refresh, <code>/v1/me</code> provides the authoritative role, scopes,
active stores, active portals, and profession assignments. The client converts
those scopes into navigation capabilities. The API must still authorize every
request independently.

### Access by role

| Role | Back-office experience |
| --- | --- |
| Manager | Read authorized arrivals for assigned active portals and manage the signed-in account |
| Administrator | Read arrivals and manage stores, profession portals, and manager assignments only within the account’s assigned scope and granted capabilities |
| Super administrator | Organization-wide access plus administrator-account management when the corresponding capabilities are present |

Unknown professions, inactive portals, missing capabilities, and inaccessible
routes are rejected or redirected. The aggregate “all professions” arrivals view
requires the administrator workspace capability and still respects the account’s
server-enforced data scope.

### Arrival workspace

The arrival workspace is an online, read-only view of server records. It provides:

- profession-specific and aggregate workspaces;
- server-backed search, filters, sorting, and pagination;
- card and table presentations;
- URL-backed filters and selected-arrival state;
- a route-backed detail drawer that survives refresh and browser navigation;
- authenticated image loading and a full photo viewer;
- complete field sections for all supported trade profiles.

Empty values and price data are not presented as useful traceability information.
Additional server fields are preserved in the detail view instead of being silently
dropped.

### Identity administration

The administrator workspace can create stores with their profession portals,
soft-deactivate or reactivate stores, enable or disable portals, create managers
with one selected portal, reassign managers, and remove access while preserving
historical records.

The super-administration workspace can create and soft-deactivate administrator
accounts. The account page lets the signed-in user change a password and then signs
the browser session out.

These screens submit requests to the identity API; hiding a button is never the
security control.

## Accessibility and responsive behavior

Both clients include deliberate accessibility work, but neither should currently
be described as formally WCAG-certified.

Mobile controls commonly provide accessibility roles, labels, state, live status
announcements, readable completeness feedback, and safe-area-aware touch layouts.
The login animation respects reduced-motion preference. Known gaps include the
camera shutter's missing explicit accessibility label/role and incomplete
reduced-motion handling outside login.

The back office supports keyboard navigation in its shell, menus, profession
selector, detail drawer, and confirmation dialog. It provides visible focus styles,
responsive card/table layouts, focus restoration, Escape handling, and CSS
reduced-motion rules. The full-screen product photo viewer restores focus and closes
with Escape, but it does not currently trap Tab focus.

The browser end-to-end suite exercises configured desktop and mobile Chromium
viewports. Manual VoiceOver/TalkBack and screen-reader browser checks are still
required for a release.

## Security boundaries

Implemented controls include:

- server-authoritative tenant, role, scope, and profession checks;
- SecureStore for direct mobile credentials and memory-only browser access tokens;
- HttpOnly browser refresh cookies;
- HTTPS-only EAS preview and production configuration;
- no client-side OCR vendor secret;
- Android backup disabled and unnecessary native permissions blocked;
- idempotency keys for replayable writes;
- authenticated catalogue photos;
- server-side validation repeated after client feedback.

The mobile bundle and browser JavaScript are public artifacts. Any value placed in
<code>EXPO_PUBLIC_*</code> or frontend source code must be considered readable by an
end user. Client validation improves usability; it must never replace backend
validation.

### Security register and release verification

The [risk register](../security/THREAT-MODEL.md#confirmed-open-risk-register) owns the full
impact, priority, remediation, and closure evidence. Repository controls now cover the
historical token-bearing catalogue, ownerless replay, cross-account hydration, stale
claims, residual export files, password-form mismatch, incomplete local ownership, and
protected-header override risks. Each remains marked “verify at release” until the signed
application has been exercised on a shared device.

| Area | Risk IDs | Release action |
|---|---|---|
| Account and token isolation | `OR-01`, `OR-02`, `OR-03`, `OR-16`, `OR-21` | Verify logout, token rotation, portal/trade change, and a two-account shared-device sequence against the signed build |
| Crash recovery and photo durability | `OR-04`, `OR-05` | Verify claim recovery on the signed build; add atomic scan-card persistence or outbox reconstruction before production |
| Device storage capacity | `OR-07`, `OR-19` | Verify temporary-export cleanup; define and test storage quotas for retained offline work |
| Android release transport | `OR-06` | Verify the fail-closed source configuration in the generated manifest/network policy and reject any signed release that permits cleartext |
| Browser password experience | `OR-14` | Re-run every role form against the production-equivalent backend policy |

`OR-05` and `OR-19` remain client-side release work. The repository
mitigations for the other client findings do not replace signed-artifact and shared-device
verification.

## Architecture map

### Mobile

| Area | Main source |
| --- | --- |
| Application providers | [App.tsx](../../App.tsx) |
| Authentication state | [src/context/AuthContext.tsx](../../src/context/AuthContext.tsx) |
| Navigation | [src/navigation/RootNavigator.tsx](../../src/navigation/RootNavigator.tsx) |
| API and token refresh | [src/services/api.ts](../../src/services/api.ts), [src/services/auth.ts](../../src/services/auth.ts) |
| Trade profiles | [src/services/businessProfiles.ts](../../src/services/businessProfiles.ts) |
| Capture preparation | [src/screens/CameraScreen.tsx](../../src/screens/CameraScreen.tsx), [src/services/frameCrop.ts](../../src/services/frameCrop.ts) |
| Scan lifecycle | [src/services/scanQueue.ts](../../src/services/scanQueue.ts) |
| Durable writes | [src/services/outbox.ts](../../src/services/outbox.ts), [src/services/outboxDrain.ts](../../src/services/outboxDrain.ts) |
| Review | [src/screens/ReviewScreen.tsx](../../src/screens/ReviewScreen.tsx) |
| Catalogue and protected images | [src/services/catalogApi.ts](../../src/services/catalogApi.ts) |
| Local files and records | [src/services/storage.ts](../../src/services/storage.ts), [src/services/export.ts](../../src/services/export.ts) |

### Back office

| Area | Main source |
| --- | --- |
| Routes and access wrappers | [web/src/router/AppRouter.tsx](../../web/src/router/AppRouter.tsx) |
| Browser session and capabilities | [web/src/auth](../../web/src/auth) |
| API client | [web/src/api.ts](../../web/src/api.ts) |
| Arrival workspace | [web/src/features/arrivals](../../web/src/features/arrivals) |
| Profession presentation | [web/src/portals](../../web/src/portals) |
| Account and identity workspaces | [web/src/features/account](../../web/src/features/account), [web/src/features/identity](../../web/src/features/identity) |
| Responsive application shell | [web/src/layouts/AppShell.tsx](../../web/src/layouts/AppShell.tsx) |

## Verification

Run these checks from the repository root after changing mobile behavior or shared
contracts:

~~~bash
npm run typecheck
npm test -- --runInBand
npm run check:android13
npm run security:tracked-secrets
~~~

The production security probe is a release check, not a local mobile test. It sends
network requests, including a synthetic login attempt and an oversized anonymous upload,
to the URL you provide. Run it only against an explicitly approved target:

~~~bash
npm run security:production -- https://reviewed-target.example
~~~

The helper currently falls back to the public production origin when no URL is supplied.
Always provide the exact approved target; never rely on that fallback.

Run the back-office checks from <code>web</code>:

~~~bash
npm run typecheck
npm test
npm run build
npm run test:e2e
~~~

Dependency audits are also useful before a release:

~~~bash
npm audit --omit=dev
cd web
npm audit
~~~

Automated checks do not replace these focused release exercises:

- login, token refresh, logout, and a second-account sign-in on a shared device;
- several chained captures, including crop failure and denied camera permission;
- offline capture, app termination, foreground recovery, and network recovery;
- extraction failure, recapture, draft restoration, and successful finalization;
- every supported trade profile with values and explicit <code>NC</code> decisions;
- date selection, global search, pull to refresh, detail image, JSON/CSV export, and
  export-file cleanup expectations;
- manager, administrator, and super-administrator browser access;
- profession filters, pagination, route-backed arrival details, and protected images;
- keyboard-only, reduced-motion, VoiceOver/TalkBack, and representative screen sizes;
- an EAS preview or production build on Android API 33 or later and a supported
  iPhone.

Do not record a fixed test total in this document. Test discovery changes as the
product evolves; the command exit status and CI result are the durable evidence.

## Related documentation

- [Documentation index](../README.md)
- [API contracts](../backend/API-CONTRACTS.md)
- [AI extraction pipeline](../ai-pipeline/AI-PIPELINE.md)
- [Prompt and anti-fabrication contract](../extraction/PROMPT-CONTRACT.md)
- [Security architecture](../security/SECURITY-ARCHITECTURE.md)
- [Production security validation](../security/PRODUCTION-VALIDATION.md)
- [Developer guide](../DEVELOPER-GUIDE.md)
