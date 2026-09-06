# LabelScan

**Turn a food-label photo into a traceable record that a human can trust.**

LabelScan helps fresh-food teams capture incoming product labels, extract the useful
information, review it, and keep an auditable history. The product currently supports
three business profiles—fishmonger, butcher, and prepared-food/catering—so each team sees
the fields and vocabulary that match its work.

The guiding rule is simple: **machine-proposed values must carry evidence from the
label**. Uncertain, inconsistent, missing, or unsupported results go to human review.

## The product at a glance

1. An operator photographs a label in the mobile app. A GS1 barcode is decoded on the
   device when one is available.
2. The server stores the original image before acknowledging the capture, then processes
   it asynchronously with OCR and a structured LLM extraction.
3. Deterministic rules reconcile barcode, OCR, and model results. Barcode-derived values
   take source precedence for the fields they encode; human review still handles an
   incorrect or inconsistent label.
4. The operator reviews the profile-specific record and completes any missing values.
5. LabelScan stores the human-confirmed version as a new, auditable record and publishes
   it to the authorized store catalogue.

| Surface | Who it is for | What it provides |
|---|---|---|
| Expo mobile app | Store operators | Fast capture, a persistent retry queue, guided review, and an offline catalogue cache |
| React back office | Managers and administrators | Arrival search, store administration, and role-based account management |
| FastAPI server | Mobile and web clients | Authentication, ingestion, extraction orchestration, traceability, HACCP alerts, and audit history |
| PostgreSQL and private image storage | The platform | Tenant-scoped records, immutable evidence, and durable projections |

## Why teams can trust it

- **Evidence before interpretation.** The original photo and the normalized OCR/LLM
  artifacts used by the pipeline are retained so extracted values keep provenance. The
  verbatim provider envelopes are not currently preserved.
- **Human review stays in control.** Low-confidence, inconsistent, or incomplete results
  are never silently accepted.
- **History is preserved.** Extractions and reviews are append-only; a correction creates
  a new version instead of rewriting the past.
- **Server retries preserve intent.** Idempotency keys and a transactional outbox prevent
  duplicate business writes. Committed provider artifacts are reused, although a crash
  between an external response and its artifact commit can repeat that provider call.
- **The server enforces organization scope.** Tenant-aware JWTs, store/portal permissions,
  and bound queries protect business records. PostgreSQL row-level security adds another
  boundary when the live runtime role is correctly restricted. The managed-topology
  database credential gap and the mobile ownership gaps remain release blockers below.

## Architecture

```text
Expo mobile app ── HTTPS/JWT ──┐
                               ├── FastAPI API ── PostgreSQL
React back office ─────────────┘                       │
                                              transactional outbox
                                                      │
                                                      ▼
                                      extraction workers ── private image storage
                                               │
                                               └── Google Vision OCR + Anthropic Claude
```

The backend is a modular monolith with hexagonal boundaries. This keeps transactions and
audit guarantees easy to reason about in the current deployment while leaving clear seams
for future service extraction. See the [enterprise architecture](docs/ENTERPRISE-ARCHITECTURE.md) and
[architecture decisions](docs/architecture/adr/README.md) for the reasoning behind the
design.

## Run LabelScan locally

### Prerequisites

- Node.js **22.12 or newer on a supported LTS release** and npm. CI and the container
  build currently use Node 22; Expo SDK 57 targets React Native 0.86 and React 19.2.
- Python 3.11 or newer for backend development outside Docker.
- Docker with Compose for PostgreSQL, the API, demo data, and extraction workers.
- PostgreSQL 16 command-line binaries when running `server/scripts/run_local_proofs.sh`;
  on macOS, the script defaults to the Homebrew `postgresql@16` installation path.
- A Google Vision API key and an Anthropic API key if you want real extraction results.
  These keys stay on the server and are never included in the mobile bundle.
- Android Studio or Xcode when building a native development app.

This repository is pinned to Expo SDK 57. Use the
[versioned Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/) and keep
the package versions already recorded in `package.json`.

### 1. Prepare local configuration

```bash
cp .env.example .env
cp server/.env.example server/.env
cp server/demo/credentials.example.json server/demo/credentials.local.json
```

Then make these local-only changes:

- In `.env`, set `EXPO_PUBLIC_API_BASE_URL` to the API address reachable by the phone.
  Use your computer’s LAN address rather than `localhost` on a physical device.
- In `server/.env`, replace every placeholder secret, including the PostgreSQL password,
  JWT secret, provider keys, and initial administrator password.
- In `server/demo/credentials.local.json`, replace every example password with a unique
  value. This file is mounted as a local secret and is ignored by Git.

Values prefixed with `EXPO_PUBLIC_` are compiled into the mobile bundle. Never place a
private credential in one of them, and restart Metro after changing the mobile API URL.

### 2. Start the backend and demo environment

```bash
docker compose --env-file server/.env up --build
```

Compose starts PostgreSQL, applies migrations, seeds the local demo idempotently, and then
starts the API on port `8000` with the extraction workers declared in `docker-compose.yml`.
The current demo stores, accounts, and sample arrivals are defined in
`server/scripts/seed_demo.py` and use label photos from `server/demo/images/`.

Open the back office at
[http://localhost:8000/backoffice/o/labelscan/](http://localhost:8000/backoffice/o/labelscan/).
Use the password you assigned to `admin` or `super_admin` in the local demo credentials.
The available manager usernames are listed in `server/demo/credentials.example.json`;
their store assignments come from the seed script.

### 3. Start the mobile app

```bash
npm install
npx expo run:android
# or: npx expo run:ios
```

The native development build applies the native project configuration used for local
development. Validate an approved preview or production artifact separately before a
release. If the development build is already installed, start Metro with a clean cache
using `npx expo start --clear`.

Mobile sign-in is reserved for manager accounts. Administrators use the web back office,
where they can create stores and assign managers to the appropriate business portal.

## Everyday commands

| Command | When to use it |
|---|---|
| `npm run typecheck` | Check the strict TypeScript contract without producing a build |
| `npm test` | Run the mobile unit and component tests |
| `npm run check:android13` | Verify the Android API 33 minimum and release-network safeguards |
| `bash server/scripts/run_local_proofs.sh` | Create a temporary PostgreSQL 16 environment and run migrations, dependency-boundary checks, and backend tests |
| `docker compose --env-file server/.env up` | Run the complete local backend stack |

The backend helper installs editable development dependencies into the active Python
environment and uses port `54329` by default. Activate a disposable virtual environment
first, and set `PGPORT` to a free port when `54329` is already in use.

The production security probe is intentionally not an everyday command: it sends active
security requests, including a synthetic login and an oversized anonymous upload. Run it
only during an authorized release validation, against an explicit reviewed target, as
described in the [production validation guide](docs/security/PRODUCTION-VALIDATION.md).
The helper currently falls back to the public production origin when no URL is supplied,
so never run the command without an explicit argument.

## Configuration guide

The example environment files document the common runtime settings and production
alternatives. The table below highlights the values most developers need first.

| Location | Variable | Why it exists |
|---|---|---|
| `.env` | `EXPO_PUBLIC_API_BASE_URL` | Tells the compiled mobile app which API to contact |
| `server/.env` | `DATABASE_URL` | Connects standalone backend commands to PostgreSQL; Compose supplies its own service URL |
| `server/.env` | `LABELSCAN_DEPLOYMENT_TOPOLOGY` | Selects the `managed` default or the explicitly documented `single-vps` production checks |
| `server/.env` | `LABELSCAN_GOOGLE_VISION_API_KEY` | Authorizes server-side OCR |
| `server/.env` | `ANTHROPIC_API_KEY` | Authorizes structured LLM extraction |
| `server/.env` | `LABELSCAN_JWT_SECRET` | Signs local access and refresh sessions |
| `server/.env` | `LABELSCAN_OBJECT_STORE` | Selects local filesystem storage or the production S3 adapter |
| `server/.env` | `LABELSCAN_ADMIN_USERNAME`, `LABELSCAN_ADMIN_PASSWORD` | Provisions or resets the initial administrator through the identity CLI |

For the full runtime contract, read the [server guide](server/README.md). For hardened
environments, follow the [deployment guide](deploy/README.md) instead of copying local
defaults into production.

## Documentation map

| If you want to… | Start here |
|---|---|
| Understand the system | [Documentation home](docs/README.md) and [enterprise architecture](docs/ENTERPRISE-ARCHITECTURE.md) |
| Contribute safely | [Developer guide](docs/DEVELOPER-GUIDE.md) |
| Work on the mobile app | [Mobile application reference](docs/mobile/MOBILE-APP.md) |
| Work on the React back office | [Back-office reference](docs/mobile/MOBILE-APP.md#react-back-office) |
| Integrate with the API | [API contracts](docs/backend/API-CONTRACTS.md) and [OpenAPI specification](docs/backend/openapi.v1.yaml) |
| Change persistence | [Database reference](docs/database/DATABASE.md) and `server/migrations/` |
| Understand extraction | [Pipeline architecture](docs/pipeline/PIPELINE-ARCHITECTURE.md) and [prompt contract](docs/extraction/PROMPT-CONTRACT.md) |
| Review production security | [Confirmed open risks](docs/security/THREAT-MODEL.md#confirmed-open-risk-register), [security rules](docs/security/SECURITY-RULES.md), and [production validation](docs/security/PRODUCTION-VALIDATION.md) |
| Deploy the platform | [Deployment guide](deploy/README.md) and [SRE reliability guide](docs/operations/SRE-RELIABILITY.md) |

## Current boundaries

LabelScan currently uses local username/password roles (`super_admin`, `admin`, and
`manager`); enterprise OIDC/SSO is not implemented. The mobile queue and catalogue cache
support ordinary connection loss, but recovery from a process stop during an active
operation still needs hardening. The mobile catalogue cache and export files also need
stronger account-bound cleanup before production distribution. PostgreSQL and private
image storage remain the sources of truth. Local development uses filesystem image
storage, while the managed production profile requires encrypted S3-compatible storage.
The documented single-VPS profile is an explicit exception with a private persistent
volume and backup procedure. Compliance rules are still provisional and require formal
approval before regulated production use. Review the
[confirmed open-risk register](docs/security/THREAT-MODEL.md#confirmed-open-risk-register)
before approving any release.

## License

LabelScan is licensed under the [MIT License](LICENSE). Copyright © 2026 Brice Fontaine.
