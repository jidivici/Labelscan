# LabelScan Security Audit V3 — MVP hardening refresh

> **Archived:** Point-in-time security audit, not the current risk register. See the
> [archive index](README.md) and [open risks](../security/THREAT-MODEL.md#confirmed-open-risk-register).

> Archivé le 20 août 2026 : photographie du 3 août, remplacée par les preuves de sécurité courantes.

**Date:** 3 August 2026  
**Branch:** `mvp/security`  
**Scope:** API, PostgreSQL migrations, Expo SDK 54 mobile client, React/Vite
backoffice, containers, CI, dependencies, and release documentation.  
**Supersedes:** `SECURITY-AUDIT-V2.md` (8 July 2026).

## Executive result

The repository now contains the security controls required for a single-replica
MVP: named RBAC accounts and tenant RLS, revocable rotating sessions, bounded
uploads and strings, process-local abuse controls, hardened mobile/browser token
storage, response headers, locked Python dependencies, split client CI, and
automated dependency review. This is **not** a production accreditation. The
external gates in this document remain release blockers.

The production-shaped topology is now explicit in
`docs/security/SECURITY-ARCHITECTURE.md` and `deploy/compose/production.yml`:
migrations run as a one-shot gate, API and worker have separate secret sets, no API host
port is published, and managed DB/object/edge services remain outside the application
stack. Production startup rejects incomplete DB TLS, KMS object storage, JWT
issuer/audience, HTTPS origin, allowed-host, exact proxy-IP, build-version, or provider
configuration. Runtime Swagger/OpenAPI is disabled; the generated reviewed inventory in
`docs/backend/openapi.v1.yaml` defines the pentest surface.

Verified baseline on 3 August 2026:

- Mobile: the 214 pre-existing Jest tests pass; the security suite now totals 221
  tests after adding session restoration, storage, retry, and release-URL proofs.
  Root TypeScript now excludes `web/` and passes independently.
- Backoffice: clean install, typecheck, and production Vite build pass; the output
  contains no source map. Its npm production tree reports zero advisories.
- Backend: hashed Python locks install on Python 3.12; Ruff (including `S608`),
  import-linter, migration upgrade/downgrade/upgrade, and all 312 PostgreSQL tests pass.
  One billed Anthropic cache test remains intentionally skipped without an API key.
- Supply chain: the root Expo SDK 54 production tree reports 4 high advisory
  groups (and no critical group). Each underlying reviewed GHSA is recorded in
  `security/npm-audit-allowlist.json` with an owner, reachability note, and expiry.
  Unknown high/critical advisories fail CI. Python reports no known vulnerability.
  The two advisories published on 3 August (`GHSA-rgw5-rvv9-x895` and
  `GHSA-fxqj-rqcc-2cmp`) were reviewed as build-only Expo transitives and added to the
  same 2 September expiry; they are not silently treated as resolved.

## V2 finding disposition

Status vocabulary: **Resolved** means proved in this repository; **Partial** means
the repository portion is complete but another material control remains;
**Accepted risk** is an explicit MVP choice; **External action** requires evidence
outside Git; **Open** is unfinished repository work.

| V2 | Status | Current evidence / remaining action |
|---|---|---|
| 1.1 Login rate limiting | Resolved | Failed-IP window, hashed org/user cooldown, reset-on-success, `Retry-After`, safe logging, and HTTP proofs in `test_rate_limiting.py`. Timing equalization remains in `Login` through the dummy hash path. |
| 1.2 Shared account / no RBAC | Resolved | Named admin/operator accounts, lifecycle endpoints, role scopes, store assignment, and regression tests (`0014`, `test_user_admin.py`). |
| 1.3 No refresh/revocation | Resolved | Migration `0024`; 15-minute JWTs with `jti`/`sid`; opaque seven-day rotating tokens; replay-family revocation; logout and security-change revocation. |
| 1.4 Password policy | Resolved | One 12–128 character passphrase policy is used by CLI and administration; example placeholders are rejected. |
| 2.1 Google Vision key rotation | External action | Code no longer exposes the key, but GCP rotation/revocation evidence is still required. |
| 2.2 Compose database credentials | Resolved | Required environment interpolation and loopback-only host binding; no versioned `postgres/postgres`. |
| 2.3 Runtime secret storage | External action | Repository defaults fail closed; production secrets manager and rotation evidence remain required. |
| 3.1 SQL injection review | Resolved | Ruff `S608` runs in CI. Suppressions cover only fixed, code-selected SQL fragments; caller values remain bind parameters. |
| 3.2 OCR prompt injection | Partial | The extraction prompt treats label text as untrusted, structured output/no-fabrication/GS1/HITL gates remain. Adversarial golden-set execution is still required before auto-accept claims. |
| 3.3 API string bounds | Resolved | Username 254, field values 512, notes 2,000, and barcode/idempotency/correlation values 128; the canonical field allow-list remains enforced. |
| 3.4 Image upload validation | Resolved | Incremental 10 MiB stop, JPEG/PNG/WebP magic/dimension parsing, 25 MP/10,000-axis bounds, and rejection before raw persistence. |
| 4.1 TLS absent | Partial | Release mobile builds reject `http://`; TLS redirect, HSTS, and certificate evidence are external gates. |
| 4.2 Closed CORS | Accepted risk | API/backoffice remain same-origin and no permissive CORS middleware is enabled. Reassess before any cross-origin UI. |
| 4.3 Exposed PostgreSQL port | Resolved | Compose publishes only `127.0.0.1:5432`. Production must use a private managed endpoint. |
| 4.4 Dev/header-auth guard | Resolved | Production rejects header auth; forwarded IPs are honored only for explicitly trusted socket peers. |
| 5.1 Append-only enforcement | Resolved | Trigger and same-transaction regression proofs remain green. |
| 5.2 No-fabrication gate | Resolved | Existing extraction and reconciliation proofs remain green. |
| 5.3 Time/export integrity | Partial | DB timestamps and immutable audit evidence exist; trusted-time operations and signed regulatory exports remain release design work. |
| 6.1 No tenant isolation | Resolved | Organization/store ownership, tenant claims, transaction-local tenant context, PostgreSQL RLS, and cross-tenant tests are implemented (`0018` onward). |
| 7.1 Compose hardening | Partial | Non-root images, `no-new-privileges`, dropped capabilities, required DB credentials, and private DB binding are present. Production IaC/runtime policy remains external. |
| 7.2 Backup/PITR | External action | Managed backup configuration and a witnessed restoration exercise are required. |
| 7.3 Monitoring/SLO | External action | Structured safe logs exist; aggregation, paging, dashboards, and measured SLO evidence do not. |
| 7.4 Secrets manager | External action | See 2.3. |
| 7.5 Log allow-list | Resolved | Sensitive values are not allow-listed; rate-limit logs contain class, actor/session where available, and delay—not usernames or tokens. |
| 8.1 Business data in AsyncStorage | Accepted risk | Tokens are never stored there. Local article data remains an explicit device-retention risk pending SQLite/retention work. |
| 8.2 Shared-device app lock | Partial | Named sessions and server revocation are delivered; operator PIN/kiosk/MDM are follow-up work. |
| 8.3 Crash reporting/EAS | Open | Explicitly deferred from MVP security hardening. |
| 9.1 No automated vulnerability scan | Resolved | Root/web npm comparator, `pip-audit`, Dependabot, and weekly ecosystem coverage are in CI/config. |
| 9.2 No Python lock | Resolved | Docker and CI install hashed production/development locks generated on Python 3.12. |
| 10.1 AI processor DPA/residency | External action | Legal/vendor evidence remains a release gate. |
| 10.2 Retention/erasure | External action | Policy, approved periods, and an exercised process remain required. |
| 10.3 Weak attribution | Resolved | Named actor IDs now flow through scan, review, confirmation, and audit. |
| 11.1 Mutation/ingestion abuse | Resolved | Configurable 20/10-minute + 120/hour ingestion limits and 600/hour authenticated mutation limit. Single-process by MVP assumption. |
| 11.2 Long-poll exhaustion | Resolved | Four concurrent holds per actor and 100 globally, configurable. Multi-replica deployment requires an edge/distributed limiter. |
| 11.3 Load testing | External action | Staging load test remains a release gate, not a repository claim. |
| 12.1 No mobile CI | Resolved | Mobile and backoffice have independent install/typecheck/test/build jobs. |
| 12.2 No JS lint | Partial | TypeScript and Jest are enforced; a separate ESLint policy is still open hygiene, not an MVP security blocker. |
| 12.3 Order-dependent backend suite | Resolved | Full suite passes against a freshly migrated PostgreSQL 16 database; CI performs a reversible migration cycle first. |

## New V3 surface review

| Surface | Result |
|---|---|
| React backoffice tokens | Access token exists only in memory; refresh token is an `HttpOnly`, `SameSite=Strict` cookie. No `localStorage`/`sessionStorage` token persistence remains. |
| Browser session bootstrap | `/v1/auth/refresh` restores from the cookie; `/v1/auth/logout` revokes the family and expires the cookie. Production adds `Secure`. |
| Browser hardening | API-served backoffice responses add CSP, `nosniff`, frame denial, no-referrer, and restrictive permissions. Vite production source maps are disabled. |
| Production exposure | Trusted hosts and same-origin browser auth are enforced; API data is `no-store`; readiness does not reveal failed dependency names; Swagger/Redoc/OpenAPI are absent. |
| Token domain separation | JWTs require an explicit issuer and audience in addition to `exp`, `iat`, `jti`, and the active session `sid`. |
| Deployment roles | Schema migration, API and worker are distinct process roles. Only the worker receives OCR/LLM secrets. |
| CI split regression | Root `tsconfig.json` no longer accidentally compiles `web/`; mobile and web dependencies/jobs are isolated. |
| Expo application config | SDK 54 behavior retained; SecureStore uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; Android audio permission removed and backup disabled. |
| Current npm advisories | Root: 4 high groups, reviewed/time-boxed Expo 54 transitives. Web: none. Expo 57 is not forced into an SDK 54 app. |

## External release gates

No row may be changed to complete without linking durable evidence.

| Gate | Owner | Required evidence | Status |
|---|---|---|---|
| Google Vision key rotation | Platform owner | Old key returns 403; new restricted key works; rotation date/ticket | Blocked external |
| Production TLS + HSTS | Platform owner | Deployment config, redirect test, TLS scan | Not started |
| Managed secrets | Platform owner | Secret-manager references, access policy, rotation drill | Not started |
| Non-superuser DB role | DBA/platform | Production grants and failed privilege-escalation proof | Not started |
| PITR restore exercise | DBA/platform | Dated restore record with measured RPO/RTO | Not started |
| Monitoring/on-call | SRE owner | Dashboards, alerts, routing test, runbook links | Not started |
| DPA + data residency | Legal/privacy | Signed DPA/subprocessor register and approved regions | Not started |
| Retention policy | Product/legal | Approved schedule plus deletion/export exercise | Not started |
| Incident response | Security owner | Approved plan and tabletop record | Not started |
| External pentest | Security owner | Report, remediation links, accepted residual risks | Not started |

## Pentest entry checklist

- Deploy the exact reviewed commit in a production-like, same-origin staging environment.
- Complete every external gate above that affects test validity: TLS, secrets, DB role,
  monitoring, and key rotation.
- Provide two organizations, two stores, admin/operator accounts, expired/revoked
  sessions, and representative images including adversarial labels.
- Exercise login/IP/account throttling; refresh race and replay; logout/password/role/
  store/deactivation revocation; tenant/store IDOR; all 17 field names; malformed and
  oversized images; long-poll/mutation exhaustion; CSP/cookie/header behavior.
- Run CI dependency gates on the pentest commit and attach the dated npm exception
  record. Any expired exception or unknown high/critical advisory blocks entry.
- Keep DPA, retention, backup, incident-response, and pentest execution as evidence-backed
  external work; do not represent repository controls as completion of those obligations.
