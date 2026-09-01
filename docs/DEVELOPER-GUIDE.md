# LabelScan developer guide

This guide helps contributors make changes without weakening LabelScan’s evidence,
security, or offline-retry guarantees. Read the [project overview](../README.md) first,
then use the [enterprise architecture](ENTERPRISE-ARCHITECTURE.md) and
[Architecture Decision Records](architecture/adr/README.md) when a change crosses system
boundaries.

## Start with the sources of truth

Documentation explains intent, but executable contracts define current behavior. When you
investigate or change a feature, consult these sources in order:

1. application code, database migrations, schemas, and runtime configuration;
2. automated tests and CI workflows;
3. the OpenAPI, extraction, and business-profile contracts;
4. living architecture and feature documentation;
5. archived plans and audits, which provide history only.

If code and living documentation disagree, fix the documentation in the same change. Do
not copy an archived statement into a new implementation without verifying it first.

## Product invariants

These rules are part of LabelScan’s trust model, not optional style preferences.

### Never fabricate label data

A machine-extracted value needs evidence from the captured label. If the evidence is
missing or inconsistent, keep the value empty and route it to review. The mobile app may
offer clearly identified suggestions, but it must not silently turn a suggestion into a
confirmed value.

### Preserve history

Raw artifacts, extraction runs, reviewed fields, and audit records are append-only. A
correction creates a new version. Mutable tables are allowed only for operational state
whose purpose is explicitly current-state management, such as sessions, outbox delivery,
rate limits, alert state, or catalogue projections.

Before adding an `UPDATE` or `DELETE`, identify which category the table belongs to and
verify the choice against the [database reference](database/DATABASE.md) and migrations.

### Keep retries idempotent

Mobile operations can be replayed after ordinary network loss. Create an idempotency key
once, persist it with the queued operation, and reuse it for every retry. Process-stop
recovery still needs a lease for persisted `in_flight` claims; do not describe that path
as crash-safe until the open risk is fixed and kill-tested.
The server must commit business data, audit context, and any emitted outbox event in the
same transaction where the contract requires atomicity.

### Keep tenant context server-owned

The server derives organization, store, portal, and profession access from the
authenticated principal. A client must not be allowed to select an arbitrary tenant in a
business request body. New queries need both repository-level scoping and the appropriate
PostgreSQL row-level-security coverage.

### Make the interface honest

The mobile and web interfaces use French business labels, while code, identifiers,
comments, and project documentation use English. Display persisted values without silent
normalization. Use color to communicate state, not an unexplained AI score.

## Repository map

| Area | Main location | Primary checks |
|---|---|---|
| Expo mobile app | `App.tsx`, `src/` | `npm run typecheck`, `npm test`, `npm run check:android13` |
| React back office | `web/src/` | `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` from `web/` |
| FastAPI backend | `server/src/labelscan/` | `lint-imports`, `ruff check .`, `pytest` from `server/` |
| PostgreSQL schema | `server/migrations/` | Alembic upgrade/downgrade cycle and database-backed tests |
| API contract | routers plus `docs/backend/openapi.v1.yaml` | `python server/scripts/export_openapi.py --check` from the correct environment |
| Deployment | `deploy/`, `.github/workflows/` | Compose validation, shell syntax, image and security gates |

## Mobile development

The application is pinned to Expo SDK 54 and the package versions in `package.json`. Use
the [versioned Expo SDK 54 reference](https://docs.expo.dev/versions/v54.0.0/) rather than
examples for a newer SDK.

### Structure a mobile change

1. Put reusable business or state logic in `src/services/` and keep it independent of
   React Native when platform APIs are not required.
2. Add focused tests under `src/__tests__/`. The Jest configuration executes TypeScript
   tests in a Node environment with explicit mocks for native storage, network, and file
   APIs.
3. Build reusable UI in `src/components/` with explicit props and tokens from
   `src/theme/`.
4. Keep screens in `src/screens/` focused on orchestration, navigation, and presentation.
5. Update `src/types/api.ts` whenever a server response changes, and verify it against the
   OpenAPI contract rather than relying on memory.

For asynchronous capture or review work, test the complete lifecycle: initial persistence,
app restart, offline retry, authentication refresh, success replay, non-retryable failure,
different users in the same portal, and switches across portals or organizations. Durable
work must bind the complete actor and tenant identity and fail closed when it is absent.

### Mobile UI checklist

- Use typed props; do not introduce `any` to avoid modeling a state.
- Use shared color, spacing, radius, and typography tokens.
- Provide meaningful accessibility roles, labels, hints, and state.
- Keep animations short, optional to the workflow, and safe when reduced motion is
  requested.
- Measure dynamic list geometry instead of assuming header or row heights.
- Test the French label at narrow widths and with longer realistic values.
- Keep secrets out of every `EXPO_PUBLIC_*` variable because those values are compiled
  into the application bundle.

## Back-office development

The back office is a separate React 19 and Vite application under `web/`. Feature code is
grouped by domain in `web/src/features/`; profession-specific presentation belongs in
`web/src/portals/`, and workspace/portal access rules belong in the scope and routing
layers rather than individual pages.

When changing the back office:

1. preserve role and portal checks at route and data boundaries;
2. keep server data fetching in the existing feature/API layer;
3. test components with Vitest and Testing Library;
4. add or update Playwright coverage for a user-visible critical path;
5. verify the production build, not only the development server;
6. check narrow, tablet, and desktop layouts for overflow and keyboard access.

The server Docker image builds `web/` and serves the compiled assets. A web change therefore
affects the backend image even when no Python file changes.

## Backend development

The backend is a modular monolith organized into bounded contexts. Dependencies point
inward within each context:

```text
adapters → application → domain
```

Domain modules must not import FastAPI, SQLAlchemy, provider SDKs, or platform code.
Contexts exchange IDs and outbox events rather than importing each other. Import Linter
enforces these boundaries.

### Add or change a backend capability

1. Choose the context that owns the rule or data.
2. Model pure domain behavior first when the change contains a business decision.
3. Add an application use case that coordinates ports without depending on concrete
   infrastructure.
4. Implement HTTP, SQL, storage, or provider adapters at the edge.
5. Add a migration for every schema or permission change.
6. Add tests for the invariant and the failure path, including tenant isolation and
   idempotency when relevant.
7. Update the API, database, architecture, or operations reference affected by the change.

Avoid placing business transitions in routers or SQL repositories. HTTP adapters validate
transport concerns and map errors; domain/application code owns the decision.

### Change an endpoint

- Keep errors in RFC 9457 `application/problem+json` form with a stable `error_code`.
- Decide whether the operation is safe, idempotent, or requires an `Idempotency-Key`.
- Require the narrowest existing scope or introduce a deliberately reviewed new scope.
- Bound path, query, header, and body inputs before they reach provider or database work.
- Update the FastAPI models and router, regenerate/check `docs/backend/openapi.v1.yaml`,
  update `docs/backend/API-CONTRACTS.md`, and then update mobile/web types if they consume
  the response.

### Change the database

Alembic migrations under `server/migrations/` are the executable history. Keep runtime and
migration roles separate, preserve row-level security, and grant only the operations the
runtime needs. Add immutable/audit triggers where the data category requires them.

CI verifies a complete upgrade, downgrade to base, and second upgrade from a clean
PostgreSQL 16 database. A migration that cannot meet that contract needs an explicit design
review before it is merged; do not hide irreversibility in prose.

## Extraction and compliance changes

Provider code lives behind ports and must not bypass deterministic validation. A model’s
structured output guarantees shape, not truth. The current runtime keeps normalized OCR
and model projections alongside field evidence, provenance, validation status, prompt
version, model identifier, and ruleset version. It does not preserve complete verbatim
provider envelopes; closing that audit gap requires bounded immutable artifacts with
explicit encryption, access, retention, and checksum controls.

Business-profile fields are versioned in `server/src/labelscan/business_profiles.py` and
mirrored by the mobile and web presentation contracts. A profile change must account for
immutable historical ingestions that still reference an older version.

Confidence thresholds and HACCP control-plan limits require labeled evidence or compliance
ownership. Do not turn a placeholder or example value into a regulatory claim. Record any
remaining provisional rules clearly in the runtime version response and the relevant
living documentation.

## Verification commands

Run the checks for every area you changed. Before a production release, the release
workflow reruns the complete set against the exact commit.

### Mobile

```bash
npm ci
npm run check:android13
npm run typecheck
npm test -- --runInBand
node scripts/check-npm-audit.mjs
```

### Back office

```bash
cd web
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
npm audit
```

Playwright needs its Chromium runtime. CI installs it with
`npx playwright install --with-deps chromium`.

### Backend

The repeatable local validation script expects PostgreSQL 16 command-line binaries and
creates a temporary database:

```bash
bash server/scripts/run_local_proofs.sh
```

Run this helper from a disposable Python virtual environment: it installs editable
development dependencies into the active environment. Its temporary PostgreSQL instance
uses port `54329` by default; set `PGPORT` when that port is unavailable.

CI additionally audits locked dependencies, runs Ruff, verifies the generated OpenAPI
file, and proves migration reversibility. See `.github/workflows/backend-ci.yml` for the
authoritative command order.

### Cross-cutting security

```bash
npm run security:tracked-secrets
docker compose --env-file server/.env config --quiet
```

Use the [deployment guide](../deploy/README.md) for production-profile validation. Do not
run the Hostinger deployment script manually as a routine development check; the protected
release workflow supplies its reviewed revision, runner, secrets, and environment.

## Documentation rules

- Write living documentation in friendly professional English. Keep French only for
  literal UI labels or domain terms that a user actually sees.
- Explain who a command is for, where to run it, what it changes, and what success means.
- Prefer stable guarantees and named contracts over test counts, line counts, dates, or
  temporary phase labels.
- Link to one authoritative explanation rather than duplicating a long procedure in
  several files.
- Move a completed plan, dated audit, or replaced design note to `docs/archive` only when
  it still explains useful history. Add an archive notice and link its current replacement.
- Do not commit generated validation renders. Keep release evidence in the release record,
  and rely on Git history for retired text with no continuing value.
- Never include real credentials, private infrastructure values, personal data, or a
  production secret in an example.

## Before handing off a change

- The code and types compile for every changed client.
- Relevant unit, integration, browser, and database tests pass.
- Migrations and the OpenAPI export are current when applicable.
- Tenant, audit, idempotency, and offline-retry paths have been considered explicitly.
- Living documentation describes the resulting behavior without a stale date or fixed
  test count.
- Manual checks that cannot be automated are listed honestly for the next reviewer.

For deeper context, use the [documentation home](README.md) rather than an archived plan.
