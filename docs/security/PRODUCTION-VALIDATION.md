# Production validation guide

Use this guide to decide whether one exact LabelScan revision is ready for one exact
environment. It deliberately contains no permanent “approved” badge, commit hash, test
count, demo-data count, or dated infrastructure claim. Those values become stale as soon
as a new release or environment change occurs.

Store the completed evidence in the release record, not by rewriting this guide. A valid
record identifies the commit, image IDs/digests, mobile/web artifacts, topology, target,
operator, timestamps, results, and links to raw reports.

Start with the [confirmed open-risk register](THREAT-MODEL.md#confirmed-open-risk-register).
It is the single prioritized source for blockers; this guide describes how to retest them.

## 1. Define the release under test

Record before testing:

- full Git commit and protected branch;
- managed or Hostinger single-VPS topology;
- application, Caddy, and PostgreSQL image identity as applicable;
- Android/iOS artifact identifiers and build profile;
- public origin and test window;
- migration head and rollback-compatible application revision;
- owner for release, security, database, mobile, and incident decisions.

Do not mix evidence from different commits or environments.

## 2. Pass the repository gates

The authoritative CI workflows are in `.github/workflows/`. For the exact release commit,
require successful runs of:

- backend dependency audits, import boundaries, lint, OpenAPI inventory, migration
  up/down/up, tests, application image build, and both Compose renders;
- mobile Android-configuration check, TypeScript, tests, and npm audit;
- back-office TypeScript, tests, build, browser tests, and npm audit;
- high-signal tracked-secret scan;
- for Hostinger: PostgreSQL compatibility, application/Caddy/PostgreSQL image scans,
  deployment configuration scan, Caddy validation, and deploy-script syntax.

The repeatable local backend validation can be run from the repository root when
PostgreSQL 16 tools are available:

```bash
bash server/scripts/run_local_proofs.sh
```

Use a disposable Python virtual environment because the helper installs editable
development dependencies. It binds its temporary PostgreSQL instance to port `54329` by
default; set `PGPORT` to a free port when necessary.

A local success supports diagnosis. The protected CI result for the exact commit remains
the release evidence.

Current workflow limits must be recorded rather than hidden: the Hostinger gate does not
produce an SBOM, sign its locally built images, or build a signed Android/iOS artifact.

## 3. Validate the selected topology

### Managed infrastructure

Confirm all external systems before starting the app:

- only the approved TLS edge is public;
- external edge/backend networks have the intended membership and egress policy;
- PostgreSQL is private, presents the expected certificate, and requires
  `sslmode=verify-full`;
- the S3-compatible bucket blocks public access, uses the approved KMS key, and has the
  required versioning/retention policy;
- external secrets are readable only by their intended services;
- backup, restore, monitoring, and rollback automation exists outside this repository.

The current managed Compose profile shares one database URL secret between migration,
API, and worker. This fails the owner/runtime separation gate and blocks least-privilege
production until the deployment contract changes.

### Hostinger single VPS

Confirm the live host, not only the repository files:

- Caddy alone publishes ports; API, workers, PostgreSQL, Docker, and raw volumes are not
  externally reachable;
- SSH, UFW, and fail2ban policy is installed and tested. The release script installs only
  the Caddyfile, not the host-policy snippets;
- the API uses the restricted `labelscan_app` connection and migrations use the separate
  owner connection;
- worker egress is destination-restricted outside Compose;
- database/raw-image backups have an encrypted off-host copy;
- a restore has been completed in isolation and measured against the agreed recovery
  objectives;
- the self-hosted runner and root-owned deploy wrapper are access-controlled and audited.

## 4. Run public smoke checks

From a machine outside the production network, run:

```bash
npm run security:production -- https://your-labelscan-origin.example
```

The script checks public liveness/readiness shape, anti-cache and HSTS presence, hidden API
documentation, anonymous/forged-header rejection, foreign browser origin, back-office
redirect behavior, and an oversized unauthenticated upload.

Also verify manually or with an approved scanner:

- certificate chain, protocol/cipher policy, HTTP redirect, HSTS, and renewal;
- unknown HTTP/HTTPS hosts and forwarded-header behavior from trusted/untrusted peers;
- CSP, framing, content sniffing, referrer, and permissions headers on API and back office;
- authenticated upload at exactly the supported boundaries and malformed image corpus;
- response sanitization for validation, dependency, and unexpected server failures;
- one successful real capture/review/catalogue flow without using personal data.

The public script does not test tenant isolation, providers, backups, mobile storage, or
incident alerting.

The helper currently falls back to the public production origin when the URL is omitted.
Always supply the exact approved target; do not rely on that fallback.

## 5. Prove identity and tenant isolation

Use synthetic accounts in at least two organizations, with more than one store/portal.
Test all active roles and both client types.

Required cases include:

- valid, expired, forged, wrong-issuer, wrong-audience, revoked, and wrong-client JWTs;
- refresh rotation, concurrent replay, logout, expiry, and family revocation;
- login/account cooldown and IP limits through the real proxy chain;
- role, password, assignment, account, store, and portal changes followed by attempts with
  old access and refresh tokens;
- cross-organization, cross-store, and cross-portal access using guessed IDs, filters,
  images, arrivals, ingestions, batches, alerts, and identity routes;
- browser auth with missing, null, exact, and foreign origins;
- privileged identity actions with stale or widened JWT claims.

Inspect the production database connection directly. Prove that the runtime role is
non-owner, non-superuser, cannot create roles/databases, has no privileged membership, and
cannot bypass RLS. Attempt cross-tenant reads and immutable UPDATE/DELETE with that exact
role. A test owner or superuser is not valid evidence.

## 6. Validate upload, extraction, and audit safety

- Test valid JPEG/PNG/WebP plus empty, truncated, falsely labelled, polyglot,
  over-dimensioned, over-pixel, and over-size inputs.
- Confirm a rejected upload leaves no business row; account separately for a possible
  content-addressed object written before a failed database transaction.
- Alter a synthetic raw object in an isolated filesystem deployment and confirm every read
  fails closed on the recorded SHA-256. The current VPS filesystem path does not perform
  that verification and remains open as OR-15.
- Run adversarial labels that contain prompt instructions, unexpected field names, false
  evidence, conflicting barcode/print values, and ambiguous dates/quantities.
- Confirm unsupported values remain null or require review, and that provider failures end
  visibly rather than looping silently.
- Capture representative provider responses and prove that a bounded immutable artifact can
  be retrieved byte-for-byte with its access, encryption, retention, and checksum controls.
  The current runtime stores reduced OCR/LLM projections instead of complete envelopes, so
  this remains open as OR-17.
- For representative business writes, prove the audit row is in the same transaction and
  that missing audit context rolls back the write.
- For a representative mutable business or identity change, reconstruct the values before
  and after the operation without relying on mutable current state. Current audit rows have
  no snapshot references, so this remains open as OR-18.
- Inspect outbox pending age, retries, dead letters, and full-traceback access controls.

Passing functional tests does not approve confidence thresholds or regulatory field
requirements. Keep labeled-data calibration and product/legal approval with the release
evidence.

## 7. Validate mobile artifacts and local data boundaries

Test the actual signed artifact, not only TypeScript or resolved Expo configuration.

- Confirm the Android artifact uses API 33 as its minimum, disables cleartext traffic and
  backup, blocks unneeded sensitive permissions, and enables the intended release
  minification/shrinking. Local release builds must use the approved preview/production
  profile; inspect the generated manifest/network security configuration.
- Confirm no provider, database, JWT signing, or other server secret appears in the native
  bundle or `EXPO_PUBLIC_*` configuration.
- Inspect AsyncStorage, logs, screenshots, and JSON/CSV exports for access/refresh
  tokens. Catalogue DTOs contain no authorization header; image Bearers are derived
  only in volatile state for the configured API origin.
- Verify the backend export allowlist and deletion of the temporary mobile share file with
  success, cancellation, app-kill, and sharing tests.
- Sign out, kill the app at each lifecycle boundary, sign in as a different portal/user,
  and prove that no prior catalogue data hydrates or renders. Query keys and offline
  state are partitioned by organization, actor, portal, and trade.
- Seed legacy outbox operations without owner metadata, switch accounts, and prove that
  they are quarantined rather than replayed with the new JWT.
- Queue capture/review work as manager A, then sign in as manager B assigned to the same
  portal. Prove A's scan card/photo never renders and the operation is rejected by actor
  ownership.
- Kill the app immediately after an operation becomes `in_flight`; prove startup returns it
  safely to a retryable state without duplicating a committed server write.
- Kill the app between durable upload enqueue/photo persistence and scan-card persistence;
  prove the UI reconciles the work. Current scan-queue persistence is not atomic with the
  outbox.
- Force the pending-photo copy to fail and prove the app does not claim a durable capture
  whose outbox points to an operating-system temporary URI. The current fallback still
  enqueues that URI.
- Fill the catalogue cache, scan queue, drafts, outbox, article records, and legacy
  migration data to the largest supported offline workload. Prove writes fail visibly and
  recover safely at quota boundaries. The installed Android AsyncStorage adapter defaults
  to a shared 6 MB database, so per-record article keys alone are not capacity evidence.
- Exercise loss/revocation of a device and confirm the session can be invalidated from the
  server.

## 8. Validate the browser surface

- Confirm access tokens stay in memory and refresh tokens remain in the scoped HttpOnly
  cookie.
- Test stored/reflected/DOM XSS with representative label and identity fields, CSP
  enforcement, framing, and back-office route fallback.
- Verify every role's navigation and API authorization independently; hidden UI is not an
  authorization control.
- Test manager/admin creation and password changes against the server's actual policy.
  Client forms currently apply inconsistent rules, so record rejected submissions and do
  not treat client acceptance as proof.

## 9. Prove recovery and alert delivery

Create or identify a matched database/raw-image backup, restore both into an isolated
environment, apply the intended release, and validate counts, checksums, authentication,
tenant isolation, and a representative image read. Record measured recovery time and data
gap.

Trigger and route alerts for at least:

- API readiness/liveness transition;
- stale worker heartbeat and old pending work;
- new dead-letter row and repeated provider failure;
- database/raw-store saturation or unavailability;
- authentication abuse;
- backup failure and certificate-renewal failure;
- suspected audit/raw-image mismatch.

The repository does not ship Prometheus, OpenTelemetry, an alert manager, or on-call
routing. Screenshots of a dashboard without a tested notification path are not sufficient.

## 10. Record the decision

The release record should end with one of: `approved`, `rejected`, or `approved with
time-bounded risk acceptance`. Include every open finding, owner, due date, compensating
control, and retest link.

Do not replace evidence with an undated “validated” statement. Resolve and retest every
P0 item in the [open-risk register](THREAT-MODEL.md#confirmed-open-risk-register), or attach
the explicitly approved, time-bounded exception described there. P1 reliability and
retention blockers also need remediation or the same exception process before production.
