# LabelScan API contracts

This guide explains how the implemented HTTP API behaves. It is written for
client developers, integrators, and reviewers who need more context than a raw
schema provides.

The generated [`openapi.v1.yaml`](./openapi.v1.yaml) file is the complete inventory
of schema-published routes and transport models. It is produced by
`server/scripts/export_openapi.py`; do not edit it by hand. The FastAPI route is
the executable source of truth. One legacy catalogue alias is deliberately
hidden from OpenAPI and is called out below.

## At a glance

- All API routes use the `/v1` prefix.
- JSON is the default body format. Image submission uses `multipart/form-data`.
- Protected routes require `Authorization: Bearer <access-token>`.
- Errors use `application/problem+json` with a stable `error_code`.
- `X-Correlation-Id` is optional on requests and is always returned. Invalid
  caller-supplied values are replaced with a server-generated value.
- A valid W3C `traceparent` can supply the trace identifier used internally. The
  current middleware does not return a `traceparent` response header.
- Production disables `/docs`, `/redoc`, and `/openapi.json`. The checked-in
  OpenAPI file remains the review and integration artifact.

## Authentication and sessions

### Browser sessions

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/o/{organization_slug}/auth/login` | Preferred organization-aware browser login |
| `POST` | `/v1/auth/login` | Compatibility login for the default `labelscan` organization |
| `POST` | `/v1/auth/refresh` | Rotate the browser refresh token from its HTTP-only cookie |
| `POST` | `/v1/auth/logout` | Revoke the browser token family and clear the cookie |

Browser login accepts active `super_admin`, `admin`, and `manager` accounts.
The access token is an HS256 JWT with issuer, audience, expiry, token ID, session
family, organization, role, scopes, stores, portals, trade, and client type.
The default access-token lifetime is fifteen minutes and configuration cannot
raise it above one hour.

Browser refresh tokens are opaque, stored as hashes, rotated on every refresh,
and sent only in the `labelscan_refresh` HTTP-only cookie. In production the
cookie is secure and browser login, refresh, and logout require the configured
same-origin `Origin` header.

### Mobile sessions

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/mobile/auth/login` | Login to the default organization |
| `POST` | `/v1/mobile/auth/refresh` | Rotate the refresh token supplied in the JSON body |
| `POST` | `/v1/mobile/auth/logout` | Revoke the supplied mobile refresh token |

Mobile login is intentionally narrower: the account must be an active
`manager` with exactly one active portal and one derived store. Mobile refresh
tokens are returned to the client for secure device storage. A refresh token is
bound to `browser` or `mobile`; it cannot cross between the two surfaces.

Refresh-token reuse, expiry, revocation, an inactive account, or a surface
mismatch produces `UNAUTHENTICATED`. Password changes, account activation or
deactivation, manager assignment replacement, and portal deactivation revoke
the affected session families.

## Roles, scopes, and data boundaries

Scopes answer “may this actor perform the operation?” Persisted tenant, store,
and portal assignments separately answer “on which rows?”. A broad scope never
makes a scoped actor organization-wide.

| Role | Data visibility | Identity administration |
|---|---|---|
| `super_admin` | Its entire organization | Admins, managers, stores, and portals |
| `admin` | Stores it owns and their portals | Managers, owned stores, and their portals |
| `manager` | Its single active portal and derived store | None |

The retired `operator` role is not assignable and cannot start a new session.
Cross-organization or invisible resource identifiers are generally returned as
`404 NOT_FOUND`, which avoids exposing whether another tenant owns the ID.

## Implemented endpoint inventory

### Current identity and access context

| Method | Path | Access |
|---|---|---|
| `GET` | `/v1/me` | Any authenticated user |
| `POST` | `/v1/me/password` | Any authenticated user; current password required |
| `GET` | `/v1/professions` | `catalog:read` |
| `GET` | `/v1/stores/current` | `catalog:read` |

`GET /v1/me` returns the safe user record, canonical scopes, visible stores,
and detailed visible portals. Passwords and password hashes are never returned.

The active extraction contract contains three profession codes:

| Code | Display name | Active fields | Required operational fields |
|---|---|---:|---|
| `poissonnerie` | Poissonnerie | 16 | `scientific_name`, `expiry_date`, `production_method` |
| `boucherie` | Boucherie | 21 | `animal_species`, `cut_name`, `expiry_date` |
| `charcuterie_traiteur` | Charcuterie / Traiteur | 21 | `commercial_designation`, `expiry_date`, `ingredients` |

These required fields are the current application profile, not a legal opinion
or a complete regulatory checklist.

### Account, store, and portal administration

| Method | Path | Access and behavior |
|---|---|---|
| `GET`, `POST` | `/v1/admins` | `identity:admins:manage`; super-admin only |
| `DELETE` | `/v1/admins/{user_id}` | Soft-deactivate an admin |
| `GET`, `POST` | `/v1/managers` | `identity:managers:manage` |
| `PATCH`, `DELETE` | `/v1/managers/{user_id}` | Toggle activity or soft-delete a manager |
| `PATCH` | `/v1/managers/{user_id}/portals` | Replace the manager’s single portal assignment |
| `GET`, `POST` | `/v1/stores` | `identity:admin`; list visible stores or create one |
| `PATCH` | `/v1/stores/{code}` | Rename, disable, or reactivate a visible store |
| `GET` | `/v1/stores/{store_id}/portals` | Any authenticated user, filtered by persisted visibility |
| `PUT` | `/v1/stores/{store_id}/portals` | `identity:portals:manage`; idempotent soft activation |

New accounts require a direct password and start active. Manager passwords may contain
any non-empty value up to the 128-character technical cap. Administrator and
super-administrator passwords require 12–128 characters, including an uppercase letter,
a lowercase letter, a digit, and a non-alphanumeric character; the server remains
authoritative.
Creating a store creates all three canonical portal rows and activates only the
requested professions. Runtime account and portal deletion is a soft state
change; historical identities and business records remain addressable.

### Ingestion and review

| Method | Path | Scope | Idempotency |
|---|---|---|---|
| `POST` | `/v1/ingestions` | `ingestion:write` | Header required |
| `GET` | `/v1/ingestions/{ingestion_id}` | `ingestion:read` | Read-only |
| `GET` | `/v1/extraction-runs/{run_id}` | `ingestion:read` | Read-only |
| `PATCH` | `/v1/ingestions/{ingestion_id}/fields/{field_name}` | `extraction:review` | Header optional |
| `POST` | `/v1/ingestions/{ingestion_id}/reviews` | `extraction:review` | Header required |
| `POST` | `/v1/ingestions/{ingestion_id}/confirm` | `extraction:review` | Naturally replayable, no key |

#### Submit a capture

`POST /v1/ingestions` accepts these multipart fields:

| Field | Required | Contract |
|---|---|---|
| `image` | Yes | Valid JPEG, PNG, or WebP; non-empty; at most 10 MiB |
| `barcode_raw` | No | At most 128 characters; the GS1 group separator is allowed |
| `client_captured_at` | No | ISO 8601 timestamp with a timezone |

`Idempotency-Key` must contain 1–128 safe ASCII characters. It is scoped by
organization, actor, portal or store, and route, and is bound to the image
SHA-256. Reusing the key for different bytes returns
`IDEMPOTENCY_KEY_CONFLICT`. Replaying the same request still returns `202` with
`replayed: true` and `Idempotency-Replayed: true`.

The submission ledger currently writes an `expires_at` value but does not ignore
or purge expired rows when claiming a key. Treat a key as permanently reserved for
its original request unless that implementation changes; do not recycle it after
the timestamp.

Acceptance means the image is durably stored and the ingestion, image artifact,
audit row, idempotency result, and outbox event have committed. It does not mean
OCR or extraction has completed.

#### Read progress

`GET /v1/ingestions/{id}` returns the ingestion, raw artifact metadata, every
append-only extraction run, the latest fields, and audit entries. Before a run
exists, it may return non-authoritative interim OCR fields.

Long polling is optional:

```text
GET /v1/ingestions/{id}?wait=25&last_status=ocr_done
```

`wait` is clamped to 25 seconds and only takes effect with `last_status`. The
request returns when the status changes or the hold expires. Process-local
concurrency limits can return `RATE_LIMITED` with `Retry-After`.

The active flow normally exposes `raw_stored`, `ocr_done`, `extracted`,
`needs_review`, `ocr_skipped_garbage`, `extraction_failed`, and `confirmed`.
Other values remain in the database state constraint for compatibility and
guarded workflows; clients should render unknown values safely instead of
assuming a fixed client-side enum.

When a review-ready run has no usable value, the read model sets
`recapture_required: true` and supplies a machine-readable reason.

#### Finalize a review

`POST /v1/ingestions/{id}/reviews` is the preferred publication operation. It
requires the exact field set for the ingestion’s snapshotted profession and
profile version. Every value must be non-empty; `NC` is the explicit audited
“not communicated” value. Dates must be complete `YYYY-MM-DD` values,
`production_method` accepts `wild_caught`, `farmed`, or `NC`, and GTIN accepts
a checksum-valid 8, 12, 13, or 14 digit value, or `NC`.

The operation appends a fully human-sourced run, confirms the ingestion, stores
the photo orientation, records idempotency, and emits `review.finalized` in one
transaction. Photo rotation is limited to `0` or `180`; base rotation is `-90`
or `0`.

Review and catalogue clients render every field in the selected versioned profile.
Machine absence remains JSON `null`. Human review keeps that field visibly unresolved
until the operator explicitly supplies a value or chooses `NC`; an unresolved field does
not count toward completion. Ambiguous, invalid, and unnormalizable machine proposals also
require explicit human confirmation or correction. The finalized catalogue renders an
audited absence as the exact marker `NC` and never hides the row.

The per-field override route appends a new run instead of mutating the old one.
GS1-owned fields (`batch_number`, `expiry_date`, `packaging_date`, `weight`, and
`gtin`) require `force_gs1: true`. The `/confirm` route is retained for the older
override-then-confirm workflow; it changes status but does not publish the
complete atomic review event.

### Arrivals, batches, and alerts

| Method | Path | Scope |
|---|---|---|
| `GET` | `/v1/arrivals` | `catalog:read` |
| `GET` | `/v1/arrivals/{batch_id}` | `catalog:read` |
| `GET` | `/v1/arrivals/{batch_id}/image` | `catalog:read` |
| `GET` | `/v1/catalog/products` | `catalog:read`; legacy alias of `/v1/arrivals`, hidden from OpenAPI |
| `GET` | `/v1/batches/{batch_id}` | `traceability:read` |
| `GET` | `/v1/alerts` | `haccp:read` |
| `POST` | `/v1/alerts/{alert_id}/acknowledge` | `alert:ack` |
| `POST` | `/v1/alerts/{alert_id}/resolve` | `alert:resolve` |

The arrivals feed is created only after a complete human review is finalized.
It supports text search, tenant-aware store and portal filters, profession,
status, alert state, completeness, supplier, lot, GTIN, capture actor, recorded
and expiry date ranges, repeated `field_filter=field:value`, sorting, limit, and
offset. The response is `{items, total, limit, offset}`; the complete parameter
constraints are in the generated OpenAPI file.

`GET /v1/catalog/products` invokes the same feed handler but is registered with
`include_in_schema=False`. It is retained for compatibility, not offered as a
new integration target; clients should use `/v1/arrivals`.

Arrival photos are authenticated immutable responses with a private one-day
cache policy and an ETag. `GET /v1/batches/{id}` exposes the registered or
flagged traceability row, linked alerts, and audit entries.

Alert lifecycle transitions are domain-guarded. An invalid transition returns
`ALERT_INVALID_TRANSITION`; missing and invisible alerts both return
`NOT_FOUND`.

### Operations

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/v1/health/live` | Confirms that the API process is serving |
| `GET` | `/v1/health/ready` | Checks database and object-store access; details are hidden in production |
| `GET` | `/v1/version` | Returns the build version and active extraction rule-set identifier |

These routes do not require a bearer token. Worker health is exposed through
its container heartbeat check, not through the API.

## Error contract

Clients should branch on `error_code`, never on the human-readable `detail`.
Every handled error uses this shape:

```json
{
  "type": "https://errors.labelscan/VALIDATION_ERROR",
  "title": "Malformed request",
  "status": 400,
  "detail": "Request failed validation",
  "error_code": "VALIDATION_ERROR",
  "correlation_id": "corr_...",
  "trace_id": "...",
  "timestamp": "...",
  "retriable": false,
  "errors": []
}
```

`errors` is present only when structured field errors are available.

| Error code | HTTP | Retriable |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | No |
| `STORE_NOT_FOUND` | 400 | No |
| `STORE_REQUIRED` | 400 | No |
| `UNAUTHENTICATED` | 401 | No |
| `INVALID_CURRENT_PASSWORD` | 401 | No |
| `FORBIDDEN` | 403 | No |
| `NOT_FOUND` | 404 | No |
| `USER_ALREADY_EXISTS` | 409 | No |
| `STORE_ALREADY_EXISTS` | 409 | No |
| `STORE_IN_USE` | 409 | No |
| `STORE_INACTIVE` | 409 | No |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | No |
| `INGESTION_NOT_CONFIRMABLE` | 409 | No |
| `ALERT_INVALID_TRANSITION` | 409 | No |
| `FIELD_NOT_EDITABLE` | 409 | No |
| `PAYLOAD_TOO_LARGE` | 413 | No |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | No |
| `RATE_LIMITED` | 429 | Yes |
| `INTERNAL_ERROR` | 500 | Yes |
| `DEPENDENCY_UNAVAILABLE` | 503 | Yes |

The generated OpenAPI inventory describes the registered success and validation
models. This catalog documents runtime errors raised by shared middleware and
application services, including errors that FastAPI cannot infer automatically.

## Deliberately absent routes

There is no generic `/v1/users` API, supplier CRUD API, batch creation API,
temperature-log HTTP API, audit-search API, or generic trace endpoint. Those
capabilities may have appeared in earlier design material, but they are not
registered in the current application and must not be treated as available.
