# Threat model

This model focuses security testing on the ways LabelScan could expose an account, move
data across an ownership boundary, lose audit evidence, create ungrounded traceability
data, or become unavailable during receiving work. Review it whenever the architecture or
trust boundary changes.

## Assets to protect

- user credentials, access tokens, refresh-session families, and role assignments;
- organization, store, and business-portal separation;
- original label images, OCR/LLM evidence, human reviews, traceability records, and HACCP
  alerts;
- immutable audit history, idempotency records, outbox events, and release identity;
- database, JWT, provider, host, backup, and CI/deployment credentials;
- service availability and provider budget.

## Threat actors and failure sources

- an unauthenticated internet attacker targeting login, uploads, expensive providers, or
  public diagnostics;
- a legitimate manager/admin attempting access outside their assigned portal, store, or
  organization;
- a second user on a shared/lost device inheriting cached data or queued work;
- hostile label text or an intentionally malformed image;
- a compromised dependency, image, repository workflow, self-hosted runner, container, or
  provider account;
- a privileged database/host operator or accidental deployment misconfiguration;
- an ordinary crash, network partition, partial mobile write, backup failure, or provider
  outage that creates silent data loss.

The TLS edge, host/orchestrator, managed PostgreSQL, S3/KMS, provider platforms, backup
system, and alerting platform sit outside the application trust boundary. Repository
configuration is useful evidence, but those systems are trusted only after their live
controls have been verified.

## Confirmed open-risk register

This is the canonical risk and control register. Fixed repository issues retain their IDs
so release evidence and historical incident work remain traceable; rows that retain a
P0–P3 priority are current gaps. A **remediated · verify at release** row has focused regression
coverage in this working tree but still requires evidence from the exact signed artifact
and live environment where applicable. Priorities mean:

- **P0 — release blocker:** do not approve a production release until the gap is fixed and
  retested. An explicit, time-bounded exception requires accountable security and product
  owners, compensating controls, and a rollback plan.
- **P1 — high:** close before production unless the same exception process accepts the
  residual risk.
- **P2 — important:** schedule and own the remediation; verify compensating controls in
  the live environment.
- **P3 — hardening:** a deliberate security improvement, not evidence of a current
  vulnerability on its own.

Use the summary to scan priorities, then open the matching risk for its affected paths,
impact, and closure requirements.

| ID | Status / priority | Risk |
|---|---|---|
| [OR-01](#or-01) | **remediated · verify at release** | Token-bearing catalogue data |
| [OR-02](#or-02) | **remediated · verify at release** | Ownerless legacy outbox replay |
| [OR-03](#or-03) | **remediated · verify at release** | Cross-account catalogue hydration |
| [OR-04](#or-04) | **remediated · verify at release** | Stale mobile claim |
| [OR-05](#or-05) | **P1 · reliability blocker** | Incomplete local durability |
| [OR-06](#or-06) | **remediated · verify at release** | Profile-dependent Android cleartext setting |
| [OR-07](#or-07) | **remediated · verify at release** | Residual export files |
| [OR-08](#or-08) | **P0 · managed-topology release blocker** | Shared database credential |
| [OR-09](#or-09) | **P1 · high** | Unrestricted VPS worker destinations |
| [OR-10](#or-10) | **P1 · high** | Same-host VPS backups |
| [OR-11](#or-11) | **P2 · important** | Filesystem store is not tenant-keyed |
| [OR-12](#or-12) | **P2 · important** | Incomplete operational detection and redaction |
| [OR-13](#or-13) | **P3 · hardening** | Password-hash evolution |
| [OR-14](#or-14) | **remediated · verify at release** | Password-form policy mismatch |
| [OR-15](#or-15) | **P1 · high** | Filesystem reads do not verify content hashes |
| [OR-16](#or-16) | **remediated · verify at release** | Local work ownership omits the actor |
| [OR-17](#or-17) | **P1 · data-integrity blocker** | Provider envelopes are not retained verbatim |
| [OR-18](#or-18) | **P1 · audit-integrity blocker** | No before/after snapshot references |
| [OR-19](#or-19) | **P1 · reliability and capacity blocker** | Unbounded shared AsyncStorage usage |
| [OR-20](#or-20) | **remediated · verify at release** | Unvalidated model override features |
| [OR-21](#or-21) | **remediated · verify at release** | Reserved request headers are overrideable |

<a id="or-01"></a>

### OR-01 — Token-bearing catalogue data

**Repository status:** **Remediated · verify at release**

**Affected paths:** `src/services/catalogApi.ts`, `src/services/queryClient.ts`,
`src/services/export.ts`

**Historical impact:** `photo_headers.Authorization` could move a live access token from
SecureStore into AsyncStorage and a shared JSON export.

**Implemented control and proof:** `Article` and export DTOs contain no request headers.
The authenticated-image hook derives the Bearer only in memory for URLs below the exact API
base path. The previous query cache is version-purged, and tests inspect storage, URL
rejection, token rotation, and both export formats. Revoke sessions exposed by older builds.

<a id="or-02"></a>

### OR-02 — Ownerless legacy outbox replay

**Repository status:** **Remediated · verify at release**

**Affected paths:** `src/services/outbox.ts`, `src/services/outboxDrain.ts`,
`src/services/ingestionSubmit.ts`

**Historical impact:** A queued `create_ingestion` created by an earlier user could be sent
with a later user's JWT and attributed to the later tenant.

**Implemented control and proof:** The v2 queue schema requires organization, actor,
portal, and trade ownership. Ownerless or mismatched legacy operations are quarantined,
and replay rechecks the active owner plus session generation. Shared-device tests cover
logout, actor mismatch, and scope change.

<a id="or-03"></a>

### OR-03 — Cross-account catalogue hydration

**Repository status:** **Remediated · verify at release**

**Affected paths:** `src/services/queryClient.ts`, `src/context/AuthContext.tsx`, `App.tsx`,
`src/services/catalogApi.ts`

**Historical impact:** A global persisted query cache could hydrate data from a previous
account before the new authenticated portal context was established.

**Implemented control and proof:** The global persistent React Query cache was removed.
Catalogue keys include organization, actor, portal, and trade; session data is purged before
another context is installed, and requests are gated on the complete resolved identity.

<a id="or-04"></a>

### OR-04 — Stale mobile claim

**Repository status:** **Remediated · verify at release**

**Affected paths:** `src/services/outbox.ts`, `src/services/outboxDrain.ts`,
`src/services/ingestionSubmit.ts`, `src/services/fieldOverrideSubmit.ts`,
`src/screens/ReviewScreen.tsx`

**Historical impact:** A process kill after an operation became `in_flight` could strand
capture, review, or override work indefinitely.

**Implemented control and proof:** Every live request owns a process-local lease. Startup
recovery resets only `in_flight` rows whose live lease disappeared and reuses the same
idempotency/correlation keys, so a server-side success is replay-safe. Tests simulate a
process death while proving that concurrent live work is not stolen. Repeat kill tests on
the signed application at each request boundary.

<a id="or-05"></a>

### OR-05 — Incomplete local durability

**Priority and decision:** **P1 · reliability blocker**

**Affected paths:** `src/services/scanQueue.ts`, `src/services/ingestionSubmit.ts`,
`src/services/storage.ts`

**Impact:** Durable photo/outbox work can exist without its visible scan card if the process
is killed before the fire-and-forget scan-card write completes.

**Implemented partial control:** A failed durable photo copy now fails before the outbox is
created; a temporary cache URI is never queued. Complete the remaining mitigation by
awaiting a single durable journal/transaction or reconstructing the card from the outbox at
startup, then kill-test every persistence boundary.

<a id="or-06"></a>

### OR-06 — Profile-dependent Android cleartext setting

**Repository status:** **Remediated · verify at release**

**Affected paths:** `app.config.js`, `eas.json`, `scripts/check-android-13.mjs`

**Historical impact:** A release variant built without the approved profile could permit
cleartext transport.

**Implemented control and proof:** The source configuration permits cleartext only for the
explicit `development` profile; preview, production, missing, and unknown profiles all fail
closed. The static Android contract tests each branch. Inspect the generated manifest and
network policy in the signed artifact and reject any release that permits cleartext.

<a id="or-07"></a>

### OR-07 — Residual export files

**Repository status:** **Remediated · verify at release**

**Affected paths:** `src/services/export.ts`

**Historical impact:** JSON/CSV files could remain in the document directory after sharing,
and JSON could contain authorization metadata under OR-01.

**Implemented control and proof:** Exports use an allow-listed DTO and temporary cache
location, delete in `finally` on success/cancellation/error, and age interrupted artifacts
at startup. Tests inspect cleanup and ensure authorization data is absent.

<a id="or-08"></a>

### OR-08 — Shared database credential

**Priority and decision:** **P0 · managed-topology release blocker**

**Affected paths:** `deploy/compose/production.yml`

**Impact:** API and worker receive the same database secret as migrations, defeating the
promised owner/runtime privilege split.

**Required mitigation and proof:** Provide separate external owner and runtime secrets;
query live role attributes, ownership, grants, and RLS behavior before approval.

<a id="or-09"></a>

### OR-09 — Unrestricted VPS worker destinations

**Priority and decision:** **P1 · high**

**Affected paths:** `deploy/compose/single-vps.yml`, host/upstream network policy

**Impact:** A compromised worker or provider key can exfiltrate data or spend provider
budget through arbitrary destinations.

**Required mitigation and proof:** Enforce and test a destination allow-list outside or
alongside Compose; alert on denied and unusual egress.

<a id="or-10"></a>

### OR-10 — Same-host VPS backups

**Priority and decision:** **P1 · high**

**Affected paths:** `deploy/hostinger/deploy.sh`, external backup system

**Impact:** Host loss, compromise, or storage failure can remove production data and its
release backups together.

**Required mitigation and proof:** Create encrypted off-host copies with independent
credentials; restore a matched database/raw-image set in isolation and validate
checksums/application reads.

<a id="or-11"></a>

### OR-11 — Filesystem store is not tenant-keyed

**Priority and decision:** **P2 · important**

**Affected paths:** `server/src/labelscan/platform/storage/filesystem_raw_store.py`,
`deploy/compose/single-vps.yml`

**Impact:** API/DB checks still scope normal access, but a compromised process or known
checksum crosses the storage-level tenant boundary.

**Required mitigation and proof:** Move to tenant-prefixed keys or isolated tenant roots;
define a safe migration/deduplication policy; retest reads with colliding checksums across
organizations.

<a id="or-12"></a>

### OR-12 — Incomplete operational detection and redaction

**Priority and decision:** **P2 · important**

**Affected paths:** `server/src/labelscan/platform/observability.py`,
`server/src/labelscan/platform/outbox/worker.py`, external telemetry

**Impact:** Healthy probes can hide backlog; tracebacks or allowed error strings can retain
secrets or personal data.

**Required mitigation and proof:** Add backlog/DLQ/stuck-work metrics and alerts; introduce
tested redaction and retention; verify incident routing in the live environment.

<a id="or-13"></a>

### OR-13 — Password-hash evolution

**Priority and decision:** **P3 · hardening**

**Affected paths:** `server/src/labelscan/contexts/identity/domain/password.py`

**Impact:** Current salted PBKDF2-HMAC-SHA256 at 600,000 iterations is not treated as a
vulnerability, but the format has no rehash-on-login migration and no pepper.

**Required mitigation and proof:** Benchmark Argon2id for the deployment, version
algorithms, rehash after successful login, and decide whether independently stored pepper
adds value without harming recovery.

<a id="or-14"></a>

### OR-14 — Password-form policy mismatch

**Repository status:** **Remediated · verify at release**

**Affected paths:** `web/src/features/account/AccountPage.tsx`,
`web/src/features/identity/AdminPage.tsx`, `web/src/features/identity/SuperAdminPage.tsx`,
`server/src/labelscan/contexts/identity/application/access_management.py`

**Historical impact:** The server rejected passwords that some forms presented as valid,
creating avoidable failed submissions and inconsistent security guidance.

**Implemented control and proof:** All forms mirror the 12-character server rule and the
same uppercase/lowercase/digit/special checks. Unicode letters and digits are not mistaken
for punctuation. The server remains authoritative and every role flow has regression tests.

<a id="or-15"></a>

### OR-15 — Filesystem reads do not verify content hashes

**Priority and decision:** **P1 · high**

**Affected paths:** `server/src/labelscan/platform/storage/filesystem_raw_store.py`,
`server/src/labelscan/platform/raw_images.py`

**Impact:** The database/path checksum is not recomputed when the VPS store is read, so disk
corruption or unauthorized byte changes can reach extraction or an authorized catalogue
response without an integrity failure.

**Required mitigation and proof:** Verify SHA-256 on every filesystem read and fail closed;
add a sampled/full durability verifier, alert on mismatch, and prove restore from the
matched database/raw backup.

<a id="or-16"></a>

### OR-16 — Local work ownership omits the actor

**Repository status:** **Remediated · verify at release**

**Affected paths:** `src/services/auth.ts`, `src/services/authStorage.ts`,
`src/services/outbox.ts`, `src/services/outboxDrain.ts`, `src/services/scanQueue.ts`,
`src/screens/ArticleListScreen.tsx`

**Historical impact:** Operations and visible scan cards were bound only to portal/trade.
Manager B could therefore render or replay manager A's work in the same portal using B's
JWT.

**Implemented control and proof:** Every operation and scan card carries organization,
actor, portal, and trade. Reads, rendering, and replay compare the complete owner; ambiguous
legacy records are quarantined. Tests exercise two actors in the same portal, logout,
refresh, hydration, and replay boundaries.

<a id="or-17"></a>

### OR-17 — Provider envelopes are not retained verbatim

**Priority and decision:** **P1 · data-integrity blocker**

**Affected paths:**
`server/src/labelscan/contexts/ingestion/adapters/google_vision_ocr.py`,
`server/src/labelscan/contexts/ingestion/adapters/claude_llm_provider.py`,
`server/src/labelscan/contexts/ingestion/adapters/extraction_consumer.py`

**Impact:** Storage keeps reduced OCR/LLM projections, not the complete provider responses
promised by ADR-0003; OCR geometry and per-token confidence cannot be reconstructed for
audit or reprocessing.

**Required mitigation and proof:** Persist bounded verbatim responses as separately
classified immutable artifacts, with encryption/access/retention controls; link normalized
runs to them and prove byte-for-byte retrieval/checksums.

<a id="or-18"></a>

### OR-18 — No before/after snapshot references

**Priority and decision:** **P1 · audit-integrity blocker**

**Affected paths:** `server/migrations/versions/0033_schema_baseline.sql`,
`server/src/labelscan/platform/db/audit_context.py`

**Impact:** Audit rows identify who acted on which record and when, but cannot by themselves
reconstruct the prior and resulting values of mutable business/IAM changes as ADR-0004
planned.

**Required mitigation and proof:** Add secret-safe before/after references or immutable
change records, define per-table sensitive-field rules, and test same-transaction
completeness plus authorized reconstruction.

<a id="or-19"></a>

### OR-19 — Unbounded shared AsyncStorage usage

**Priority and decision:** **P1 · reliability and capacity blocker**

**Affected paths:** `src/services/articleStoreAsyncStorage.ts`,
`src/services/queryClient.ts`, `src/services/scanQueue.ts`, `src/services/outbox.ts`

**Impact:** The installed Android adapter defaults to a 6 MB database shared by catalogue
cache, queues, drafts, outbox entries, articles, and legacy records. Per-record article keys
avoid one large value but do not remove the global limit, so writes can fail as local state
grows.

**Required mitigation and proof:** Bound and age every retained data set; surface and
recover from quota failures; capacity-test the worst supported offline workload; move
sustained record storage to SQLite or deliberately configure and verify a justified
capacity.

<a id="or-20"></a>

### OR-20 — Unvalidated model override features

**Repository status:** **Remediated · verify at release**

**Affected paths:**
`server/src/labelscan/contexts/ingestion/adapters/claude_llm_provider.py`,
`server/.env.example`

**Historical impact:** A permissive model override could receive unsupported thinking or
structured-output parameters and fail extraction.

**Implemented control and proof:** An explicit capability registry covers Haiku 4.5 and
Opus 4.8, drives request options and cache floors, and rejects unknown model IDs during
configuration. Each supported profile has configuration and token-count coverage; paid
provider probes remain an explicit release action.

<a id="or-21"></a>

### OR-21 — Reserved request headers are overrideable

**Repository status:** **Remediated · verify at release**

**Affected paths:** `src/services/api.ts`

**Historical impact:** Internal `RequestOptions.headers` could replace authorization,
correlation, idempotency, or content-type headers case-insensitively.

**Implemented control and proof:** The request layer ignores caller-supplied reserved
header names case-insensitively, then applies its own security values. Mobile and web tests
attempt authorization and content-type replacement and verify that neither reaches the
wire.

Closing an item requires a focused regression test and live-environment evidence where the
control lives outside the repository. Keep the ID and record the evidence in the release
decision; do not delete a risk simply because a mitigation is planned.

## Priority scenarios

| ID | Threat and impact | Controls present | Important gap or pentest focus |
|---|---|---|---|
| TM-01 | Credential stuffing or account enumeration leads to takeover | Generic failures, dummy PBKDF2 check, IP window and account cooldown | Limits are process-local and reset on restart; test proxy IP handling and distributed sources |
| TM-02 | Stolen/replayed refresh token maintains access | Opaque hashed token, atomic rotation, consumed-token family revoke, client-type binding | Test concurrent replay, logout, role/password/assignment revocation, and incident-wide family revoke |
| TM-03 | Forged, stale, or wrong-service JWT widens access | HS256 signature, required claims, issuer/audience, expiry, `sid`, active-session check | Single symmetric key has no key IDs; refresh sessions survive signing-key rotation unless separately revoked |
| TM-04 | CSRF or login/session confusion on browser auth | Exact production Origin and strict scoped refresh cookie | Test absent/null/foreign origins, redirects, and every cookie-auth route through the real edge |
| TM-05 | IDOR crosses organization, store, or portal | Scopes plus access context, bound SQL predicates, composite ownership, RLS, hidden-resource `404` | Use the real restricted DB role and guessed IDs across every read/write/image/filter route |
| TM-06 | Stale privileged JWT claims authorize an IAM change | Active session plus persisted role/assignment re-read on privileged operations | Verify every privileged route and session revocation after access changes |
| TM-07 | Upload bomb, spoofed type, malformed/polyglot image consumes resources or reaches providers | 10 MiB file cap, Hostinger 11 MiB envelope, format-header and dimension/pixel checks | Parsers do not fully decode, scan malware, or disarm content; fuzz CPU/memory and parser edge cases |
| TM-08 | Prompt injection or model fabrication creates false traceability data | Closed schema/field set, evidence/confidence gate, GS1 precedence, human review | Use adversarial labels and labeled evaluation; evidence matching is not proof of semantic correctness |
| TM-09 | API/provider exhaustion creates denial of service or unexpected cost | Process-local ingestion/mutation/long-poll limits, provider timeouts/retries, OCR quality gate | VPS egress is unrestricted; no repository cost alerts or distributed edge limiter |
| TM-10 | Proxy/host spoofing changes client IP or routing | Trusted proxy list, allowed hosts, foreign-origin check, Caddy unknown-host handling | VPS trusts a broad private CIDR; test untrusted containers/peers and complete forwarded chains |
| TM-11 | SQL injection or dynamic-query mistake escapes tenant scope | SQLAlchemy bind parameters, code-selected fragments, Ruff S608 review, RLS | Fuzz every filter/sort/ID and inspect deliberate S608 exceptions |
| TM-12 | XSS or framing steals an admin session | Same-origin CSP, frame denial, nosniff, memory-only web access token, HttpOnly refresh cookie | Test stored/reflected/DOM sinks with label, supplier, store, and identity values |
| TM-13 | Container escape or lateral movement exposes secrets/data | Non-root app/worker, read-only roots, cap drop, no-new-privileges, private networks, no Docker socket | PostgreSQL is writable; Caddy retains bind capability; test host metadata, mounts, network membership, and egress |
| TM-14 | Supply-chain or runner compromise ships attacker code | Locks, pinned Actions/base images, audits, Hostinger Trivy scans, revision labels | Hostinger workflow has no SBOM/image signing; self-hosted runner and root wrapper are high-trust external assets |
| TM-15 | Evidence is altered or deleted | Raw-before-normalized model, append-only grants/triggers, same-transaction audit, restricted runtime role | Managed Compose shares migration/runtime DB secret; test live grants/ownership and privileged-operator path |
| TM-16 | Logs or dead-letter errors leak sensitive data | Structured-field allow-list, sanitized HTTP errors, production docs disabled | Tracebacks and allowed error strings are not automatically redacted; `outbox.last_error` stores full tracebacks |
| TM-17 | Mobile catalogue leaks a live access token | Catalogue/export DTOs are header-free; image Bearer exists only in volatile state for the exact API base path | Inspect signed builds and revoke sessions exposed by historical artifacts |
| TM-18 | Shared-device cache reveals a previous portal's catalogue | No persisted React Query cache; keys and local state are partitioned by organization, actor, portal, and trade; old scope is purged first | Repeat cold-start tests offline/online on the signed build |
| TM-19 | Legacy queued capture is replayed under a different account/tenant | Owner is mandatory; ownerless/mismatched rows are quarantined; replay rechecks owner and session generation | Repeat two-account kill/logout/revocation tests on device |
| TM-20 | Mobile crash silently strands, hides, or loses pending work | Persistent outbox, stable idempotency key, live-claim recovery, and mandatory durable pending-photo copy before enqueue | Scan-card persistence remains fire-and-forget and is not reconstructed from the outbox after a kill |
| TM-21 | Local export remains recoverable after sharing | Credential-free DTO, temporary cache file, `finally` cleanup, startup ageing | A recipient or OS-managed share destination remains outside app control; inspect crash artifacts |
| TM-22 | Local Android release permits cleartext interception | Only the explicit development profile permits cleartext; preview, production, missing and unknown profiles fail closed and are statically checked | Inspect the signed native artifact because repository configuration cannot prove the final manifest |
| TM-23 | Filesystem raw store loses defense-in-depth tenant separation | API/DB authorize by organization; DB artifact records carry organization and checksum | VPS filesystem path uses only content hash and ignores `organization_id`; a compromised process/checksum can cross the storage boundary |
| TM-24 | Host loss removes production and backups together | VPS deploy creates DB/raw backup pairs before release | Backups remain on the same VPS unless an external off-host process copies and tests them |
| TM-25 | Healthy probes hide a stopped business pipeline | API dependency readiness and worker heartbeat | No automatic backlog/DLQ/stuck-ingestion alert; heartbeat proves loop activity, not useful progress |
| TM-26 | Corrupted VPS raw bytes are trusted because their filename looks correct | Database stores the expected SHA-256; S3 reads recompute it | Filesystem worker/catalogue reads do not recompute the checksum; test corruption, fail-closed behavior, alerting, and restore |
| TM-27 | One manager sees or submits another manager's queued work in the same portal | Operations/cards record organization, actor, portal, and trade; render/replay require an exact owner match | Repeat same-portal, different-actor tests across refresh and process death |
| TM-28 | Reduced provider projections prevent forensic reconstruction | Append-only artifact references and normalized evidence exist | Verbatim OCR/LLM envelopes, geometry, and token confidence are discarded before raw storage |
| TM-29 | An immutable audit row exists but cannot explain what changed | Triggered same-transaction actor/action/subject metadata | Audit schema has no before/after snapshot references; mutable-state reconstruction depends on other history that may not exist |
| TM-30 | Shared mobile storage reaches capacity and silently stops persisting work | Per-record article keys and application-private AsyncStorage | All AsyncStorage-backed state shares the installed adapter's default global database limit; test quota errors, bounded retention, restart recovery, and the supported worst-case offline workload |

## Mobile cross-account test sequence

Because several open risks interact on a shared device, test them as one sequence:

1. sign in as manager A, hydrate the catalogue, create pending and `in_flight` operations,
   and generate both export formats;
2. kill the process at each local persistence boundary;
3. sign out or revoke A, then sign in as manager B from another portal/organization;
   repeat with manager B assigned to the same portal as A;
4. cold-start offline and online;
5. verify that A's catalogue, any legacy token-bearing artifact, exports, pending photos,
   and ownerless or actor-mismatched operations are neither visible nor replayed under B;
6. inspect AsyncStorage, SecureStore, document-directory files, server writes, and access
   logs.

The repository regression suite covers these boundaries, but only this sequence on the
exact signed artifact can supply release evidence for device storage and lifecycle behavior.

## When to update this model

Re-model before adding or changing:

- a second API process, shared limiter, broker, or microservice;
- cross-origin browser access, webhooks, signed object URLs, or public file sharing;
- SSO/OIDC, MFA, support impersonation, or cross-organization support tools;
- business professions, file types, OCR/LLM provider, model policy, or automated approval;
- mobile account switching, cache/outbox migration, export format, or background sync;
- storage topology, backup/retention policy, database role contract, or deployment runner;
- telemetry that contains new fields or leaves the current trust region.

Every pentest finding should feed back into this model with a testable scenario, not only
a generic risk label.
