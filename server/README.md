# LabelScan server

The LabelScan server turns a mobile label capture into a durable, reviewable, and auditable
traceability record. It serves the FastAPI API and React back office, coordinates OCR/LLM
workers through a transactional outbox, and stores business state in PostgreSQL.

This guide is for backend developers and operators working on the server itself. For the
shortest full-project setup, start with the [project README](../README.md). For public
environments, use the separate [deployment guide](../deploy/README.md).

## What the server is designed to enforce

- **Raw before acknowledgement.** A capture receives HTTP `202` only after the image and
  ingestion record are durable.
- **No unsupported machine values.** Every non-null machine value needs evidence that
  passes the configured structural checks; uncertain or inconsistent fields are routed to
  human review. Evidence anchoring does not by itself prove semantic truth.
- **Immutable history.** Raw artifacts, extraction runs, reviewed fields, and audit rows
  are append-only. Database triggers reject mutation where immutability is required.
- **Audited writes.** Writes to audited tables and their audit entries commit in the same
  database transaction. Missing audit context causes those writes to fail.
- **Bounded server-side replay.** Idempotent requests, committed provider artifacts, and
  consumer deduplication prevent duplicate business records. A crash after a provider
  responds but before its artifact commits can still repeat that billable call.
- **Tenant-scoped application access.** JWT claims, repository filters, and business-portal
  assignments constrain normal API access by organization and store. PostgreSQL adds
  defense in depth only when the deployment uses a correctly restricted runtime role;
  the managed-profile credential gap is tracked as OR-08 in the threat model.

## From capture to catalogue

```text
POST /v1/ingestions
        │
        ├── store original image and ingestion
        └── append ingestion.raw_stored to the outbox
                         │
                         ▼
                 background worker
        GS1 reconciliation → OCR → quality gate → LLM
                         │
                         ▼
              append extraction run + fields
                         │
               human review when required
                         │
                         ▼
       append reviewed run → update catalogue projection
```

External OCR and LLM calls never happen in the ingestion request. After a normalized
provider artifact commits, later delivery retries reuse it. A crash between a provider
response and that commit can repeat the billable call. A failed provider is retried up to
the configured limit and then recorded as a failed extraction rather than looping forever.

### External API capacity

Every real Google Vision and Anthropic call is measured at the SDK boundary. Each worker
logs an `external_api_metrics` JSON event once per minute with `requests_total`, success /
failure / rate-limited totals, requests in the last second, in-flight calls, latency average
and maximum, and its `configured_rps`. Configure `LABELSCAN_GOOGLE_VISION_RPS` and
`LABELSCAN_ANTHROPIC_RPS` per worker. With four workers, set each value to at most one
quarter of the account quota; these process-local limits deliberately do not pretend to
be a shared multi-worker quota.

## Code organization

The backend is a Python 3.11+ modular monolith. The production image currently uses
Python 3.13. Each business context follows inward-facing
hexagonal dependencies: adapters may depend on application services and the domain, while
the domain remains free of FastAPI, SQLAlchemy, and provider SDKs.

```text
server/
├── src/labelscan/
│   ├── app/                    # application composition and process entry points
│   ├── contexts/               # domain, application, and adapter code by business area
│   │   ├── identity/           # users, sessions, stores, and portal access
│   │   ├── ingestion/          # captures, extraction, and human review
│   │   ├── traceability/       # arrivals, products, suppliers, and batches
│   │   ├── haccp/              # control plans, readings, and alerts
│   │   ├── compliance/         # reserved boundary for future governed rules
│   │   └── audit/              # audit context boundary
│   └── platform/               # database, HTTP, storage, outbox, and observability
├── migrations/                 # Alembic migrations; executable data-model history
├── scripts/                    # local validation, demo seed, calibration, and operations
├── tests/                      # unit, integration, security, and contract tests
└── pyproject.toml              # Python dependencies and lint/test configuration
```

Import Linter enforces both context independence and the
`adapters → application → domain` direction. Cross-context workflows exchange IDs and
outbox events instead of importing another context’s implementation.

## Run the complete local stack

From the repository root:

```bash
cp server/.env.example server/.env
cp server/demo/credentials.example.json server/demo/credentials.local.json
docker compose --env-file server/.env up --build
```

Before starting, replace the placeholder passwords, JWT secret, and provider keys in the
two local files. Compose uses `server/.env` for variable substitution and container
configuration, then:

1. starts PostgreSQL 16 on `127.0.0.1:5432`;
2. applies all Alembic migrations;
3. seeds the demo in an idempotent one-shot service;
4. serves the API and compiled back office on port `8000`;
5. runs two extraction workers.

The back office is available at
[http://localhost:8000/backoffice/o/labelscan/](http://localhost:8000/backoffice/o/labelscan/).
The seeded usernames are listed in `server/demo/credentials.example.json`; their real local
passwords come only from the ignored `credentials.local.json` file.

## Work on the backend without the full stack

Create a Python environment using Python 3.11 or newer, then install the server in editable
mode:

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
```

Point `DATABASE_URL` at a PostgreSQL 16 database before applying migrations or running
integration tests:

```bash
export DATABASE_URL="postgresql+psycopg://postgres@127.0.0.1:5432/labelscan_test"
alembic upgrade head
lint-imports
ruff check .
pytest
```

For the repository’s repeatable backend validation, run this command from the project
root instead:

```bash
bash server/scripts/run_local_proofs.sh
```

It creates a temporary PostgreSQL environment, migrates from a clean database, checks the
dependency boundaries, executes the backend test suite, and cleans up afterward. On macOS,
the script expects Homebrew’s PostgreSQL 16 binaries by default; set `PG_BIN` when they live
somewhere else. It also installs editable development dependencies into the active Python
environment and binds PostgreSQL to port `54329` unless `PGPORT` overrides it. Run it from
a disposable virtual environment and choose a free port.

## Back office and account roles

The API serves the authenticated web portal at `/backoffice/o/{organization_slug}/`.
The browser keeps its short-lived access token in memory and restores a session through a
same-origin, `HttpOnly`, `SameSite=Strict` refresh cookie. The server rotates refresh
sessions and validates their active family on authenticated requests.

| Role | Intended access |
|---|---|
| `super_admin` | Organization-wide store, administrator, manager, and arrival management |
| `admin` | Delegated administration within the stores and portals granted to the account |
| `manager` | Browser access to assigned arrivals and the signed-in account, plus mobile capture and catalogue access for the assigned portal |

To provision or reset the initial administrator from `server/.env`, run:

```bash
docker compose --env-file server/.env up -d --build
docker compose --env-file server/.env exec server \
  python -m labelscan.contexts.identity.adapters.cli
```

Open the back office afterward, create stores first, and then assign administrators and
managers. Mobile login intentionally rejects administrator accounts because the app is an
operator workflow rather than an administration surface.

## API guide

The table below is an orientation map, not a substitute for the executable contract. Use
the [API contracts](../docs/backend/API-CONTRACTS.md) and
[OpenAPI specification](../docs/backend/openapi.v1.yaml) for request bodies, response
schemas, scopes, and error codes.

| Area | Representative endpoints | Purpose |
|---|---|---|
| Sessions | `/v1/auth/*`, `/v1/mobile/auth/*` | Browser and mobile login, refresh, and logout |
| Identity | `/v1/stores`, `/v1/admins`, `/v1/managers` | Store and role-based account administration |
| Capture | `POST /v1/ingestions` | Durably accept an authenticated image and queue extraction |
| Review | `/v1/ingestions/{id}/fields/*`, `/confirm`, `/reviews` | Override fields or atomically finalize a complete review |
| Processing status | `/v1/ingestions/{id}`, `/v1/extraction-runs/{id}` | Read extraction progress, fields, provenance, and audit history |
| Catalogue | `/v1/professions`, `/v1/arrivals`, `/v1/arrivals/{id}` | Discover profiles and browse authorized arrivals |
| Traceability and HACCP | `/v1/batches/{id}`, `/v1/alerts` | Read batch lineage and manage alert state |
| Operations | `/v1/health/live`, `/v1/health/ready`, `/v1/version` | Process liveness, dependency readiness, and release identity |

API errors use RFC 9457 `application/problem+json` with a stable `error_code`,
`correlation_id`, and `trace_id`. Authenticated writes require the appropriate scope, and
retryable mutation endpoints use an `Idempotency-Key` where the contract requires one.

## Runtime configuration

Copy [`server/.env.example`](.env.example) rather than building an environment file from
this summary. The example includes defaults, limits, and production alternatives.

| Group | Important variables | Context |
|---|---|---|
| Runtime | `LABELSCAN_ENV`, `LABELSCAN_DEPLOYMENT_TOPOLOGY`, `DATABASE_URL` or `DATABASE_URL_FILE` | Selects development/test/production behavior, the `managed` default or `single-vps` topology, and the PostgreSQL connection |
| Authentication | `LABELSCAN_JWT_SECRET`, issuer, audience, access/refresh TTLs | Defines the token trust boundary; production requires explicit issuer and audience |
| Providers | `LABELSCAN_OCR_PROVIDER`, Google Vision key, `ANTHROPIC_API_KEY`, LLM model options | Used only by workers; secret-file variants are preferred in production |
| Storage | `LABELSCAN_OBJECT_STORE`, filesystem path, or `LABELSCAN_S3_*` | Filesystem is for local use; managed production requires private encrypted object storage |
| Browser and proxy | `LABELSCAN_PUBLIC_ORIGIN`, `LABELSCAN_ALLOWED_HOSTS`, `LABELSCAN_TRUSTED_PROXIES` | Prevents foreign-origin login, host-header abuse, and untrusted forwarding data |
| Abuse controls | `LABELSCAN_*_RATE_*`, ingestion burst/sustained limits, long-poll limits | Bounds login, mutation, upload, and polling traffic for the single-API runtime |
| Extraction policy | OCR quality settings and confidence thresholds | Controls review routing; thresholds must be calibrated on labeled data rather than guessed |
| Observability | `LABELSCAN_LOG_LEVEL`, `LABELSCAN_VERSION` | Configures structured logging and exposes the immutable release identity |

Production startup performs additional validation. It rejects weak or missing secrets,
untrusted host/proxy settings, header authentication, an invalid deployment topology, and
database transport or object-storage settings inconsistent with that topology. Database
role attributes and grants still require explicit live-environment validation before approval.

## Persistence and audit model

PostgreSQL is the business source of truth. Raw images live behind a storage port: the
filesystem adapter supports local development and the explicitly documented single-VPS
profile, while the managed production profile requires S3-compatible storage. Object
checksums link stored bytes to immutable database artifacts.

Business history is append-only where a changed fact must remain explainable. The
processed-event deduplication ledger is insert-only for the runtime role. Mutable
working tables—such as the outbox, sessions, and current catalogue projections—exist
only where state transitions are operationally necessary.
The rate limiter is separate process-local memory, not a PostgreSQL table. The
[database reference](../docs/database/DATABASE.md) and Alembic migrations are authoritative
for the exact schema and trigger behavior.

## Verification strategy

The test suite covers pure domain rules and PostgreSQL-backed guarantees, including:

- append-only enforcement, same-transaction auditing, and rollback behavior;
- ingestion durability, image validation, idempotency, and upload boundaries;
- outbox concurrency, retries, dead letters, and worker liveness;
- GS1 parsing, OCR quality, LLM reconciliation, provenance, and evidence-anchoring gates;
- human review completeness and atomic catalogue publication;
- authentication, session rotation, role permissions, rate limiting, and tenant isolation;
- traceability chains, HACCP control-plan edges, and alert lifecycle transitions;
- health/version endpoints, S3 behavior, and production runtime configuration.

Avoid documenting a fixed test count here: the suite changes frequently, while the command
and the guarantees above are the useful contract.

## Production boundaries

The current compliance ruleset is provisional and needs accountable product/legal
approval. The API topology remains single-process because abuse and long-poll limits are
process-local. The managed deployment profile still shares one database secret between
migration and runtime roles, while the single-VPS profile needs external destination
egress control and off-host backups. These and the mobile release blockers are prioritized
in the [confirmed open-risk register](../docs/security/THREAT-MODEL.md#confirmed-open-risk-register).

## Further reading

- [Backend architecture](../docs/backend/BACKEND-ARCHITECTURE.md)
- [Enterprise architecture](../docs/ENTERPRISE-ARCHITECTURE.md)
- [Database reference](../docs/database/DATABASE.md)
- [Pipeline architecture](../docs/pipeline/PIPELINE-ARCHITECTURE.md)
- [Security architecture](../docs/security/SECURITY-ARCHITECTURE.md)
- [SRE and reliability guide](../docs/operations/SRE-RELIABILITY.md)
