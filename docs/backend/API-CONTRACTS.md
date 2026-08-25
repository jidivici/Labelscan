# LabelScan — API Contracts (OpenAPI 3.1 fragments + error catalog)

**Status:** Core enterprise flow implemented — see
[`ENTERPRISE-ARCHITECTURE.md`](../ENTERPRISE-ARCHITECTURE.md) for the tenant,
storage and synchronization invariants.
**Date:** 2026-08-20
**Companion to:** [`BACKEND-ARCHITECTURE.md`](./BACKEND-ARCHITECTURE.md) (see §8 endpoint list,
§9 error model, §10 auth, §11 idempotency). Machine-readable skeleton:
[`openapi.v1.yaml`](./openapi.v1.yaml).

**Implementation notes (as of 2026-08-04):**
- Auth: HS256 access JWT plus rotating, server-side refresh sessions. The
  only assignable RBAC roles are `super_admin`, `admin`, and `manager`.
- Data authorization is evaluated independently on the
  `organization × store × business_portal` dimensions.
- Default LLM: `claude-haiku-4-5` (not `claude-opus-4-8`); GS1 handles critical exact fields.
- `extracted_field.source` ∈ `{llm, gs1, human}` (not `{llm, human}`); `field_name` includes `gtin`.
- Implemented identity endpoints include `/o/{organization_slug}/auth/login`,
  `/mobile/auth/login`, `/me`, `/professions`, `/admins`,
  `/managers`, `/stores`, and `/stores/{store_id}/portals`. Generic `/users`
  routes and the former operator-administration routes are not registered.
- Implemented business endpoints include
  GET /arrivals, GET /arrivals/{batch_id}, GET /arrivals/{batch_id}/image,
  POST /ingestions, GET /ingestions/{id},
  POST /ingestions/{id}/reviews,
  GET /extraction-runs/{id}, GET /batches/{id}, GET /alerts, POST /alerts/{id}/acknowledge,
  POST /alerts/{id}/resolve, GET /health/*, GET /version.

These are **illustrative OpenAPI 3.1 fragments**, not a full specification. They make the most
important endpoints concrete. Field names, statuses, headers, and error codes are authoritative and
must stay in sync with the main document and the YAML skeleton.

Common conventions (all operations):

- Base path `/v1`. Security: `bearerAuth` (OAuth2 JWT) unless noted.
- Request headers: `Authorization: Bearer <jwt>`; `X-Correlation-Id` (optional in, always echoed
  out); `Idempotency-Key` (required on unsafe writes — see each op).
- Response headers (always): `X-Correlation-Id`, `traceparent`. On idempotent replay:
  `Idempotency-Replayed: true`.
- Error bodies: `application/problem+json` per [§5](#error-code-catalog).

---

## 0. Back-office identity and access management

The canonical login route is
`POST /v1/o/{organization_slug}/auth/login`. The organization is resolved from
the route. The access token is signed with `organization_id`, `organization_slug`, `store_ids`,
`business_portal_ids`, the primary `business_portal_id`, and `trade_code`. The
legacy `POST /v1/auth/login` route remains a temporary compatibility alias for
the default `labelscan` organization.
Tenant-protected operations never accept an arbitrary organization from the
request body or query string.

### 0.1 Professions and business portals

`GET /v1/professions` returns the three supported, versioned profiles and their
common, specific, and required extraction fields:

| Code | Display name |
|---|---|
| `poissonnerie` | Poissonnerie |
| `boucherie` | Boucherie |
| `charcuterie_traiteur` | Charcuterie / Traiteur |

`charcuterie_traiteur` is one profession and one portal; it must never be split
into separate `charcuterie` and `traiteur` identifiers. A business portal is the
unique `(organization_id, store_id, profession_code)` access and ownership unit.
It is soft-activated with `active`; it is never physically deleted at runtime.

### 0.2 Role matrix

Scopes decide *what* an actor may do; persisted organization and portal
assignments decide *where* they may do it. The database role and assignments are
authoritative even if a JWT contains a broader, stale, or forged scope.

| Role | Client surface | Visibility | Identity administration |
|---|---|---|---|
| `super_admin` | Browser | Entire organization | Create/list/soft-delete admins; all admin powers |
| `admin` | Browser | Stores it owns and their portals | Create/disable stores and choose their professions; create/list/disable managers; assign one manager portal |
| `manager` | Browser and mobile | Its single assigned active portal and derived store | No identity-administration access |

`super_admin` is organization-scoped, not platform-global. Only it may add or
soft-delete an `admin`. An `admin` cannot set, read, move, or reset credentials.

### 0.3 Identity endpoints and credentials

All user responses omit passwords and password hashes. Every generic
`/v1/users` is not registered; callers use these bounded routes
instead:

| Method | Path | Contract |
|---|---|---|
| `GET` | `/v1/me` | Current user, canonical capabilities/scopes, authorized stores, and detailed authorized portals (`id`, store id/code/name, profession code/name, portal name, `active`) |
| `POST` | `/v1/me/password` | Authenticated user supplies the current password and changes only their own password; all their sessions are revoked |
| `GET`, `POST` | `/v1/admins` | Super-admin lists or creates active admins with a direct password |
| `DELETE` | `/v1/admins/{user_id}` | Super-admin-only reversible soft-deactivation |
| `GET`, `POST` | `/v1/managers` | Admin/super-admin lists or creates active managers with a direct password |
| `PATCH` | `/v1/managers/{user_id}` | Admin/super-admin toggles manager activity |
| `DELETE` | `/v1/managers/{user_id}` | Removes the manager from active administration and revokes access; the historical identity remains available to labels and the username becomes reusable |
| `PATCH` | `/v1/managers/{user_id}/portals` | Replaces active manager assignments without deleting history |
| `POST` | `/v1/stores` | Admin/super-admin creates a store and chooses at least one profession |
| `PATCH` | `/v1/stores/{store_code}` | Admin/super-admin renames, disables, or reactivates a store |
| `GET` | `/v1/stores/{store_id}/portals` | Super-admin sees organization portals; admin sees owned-store portals; manager sees its active assignment; invisible stores return `404` |
| `PUT` | `/v1/stores/{store_id}/portals` | Admin/super-admin idempotently sets `{portal_id, active}`; no physical delete; deactivation revokes affected sessions |

Creating a store provisions the three canonical portal ownership rows in the
same transaction and activates only the professions selected by the admin.
Creating an admin or manager requires a direct password of at least twelve
characters and creates an immediately active account. Role, assignment,
password, account, or portal changes revoke affected refresh sessions.

The database retains the historical `operator` value solely so immutable rows
and old migrations remain interpretable. It is not assignable, receives no new
session, and has no current HTTP administration route.

Account, assignment, store, and portal-state transitions are audited in the
same database transaction. Assignment and account deletion are soft state
changes; runtime IAM code has no physical delete path.

---

### 0.4 Browser and mobile sessions

`POST /v1/mobile/auth/login` accepts the same identifier/password pair as the
web login but issues tokens only for an active `manager` assigned to exactly one
active portal and store. Browser login accepts `manager`, `admin`, or
`super_admin`.

Browser refresh tokens are opaque rotating cookies; mobile refresh tokens are
returned to the client for secure device storage. Each server session records
`client_type = browser|mobile`. Login and refresh both reject crossing the
surface boundary; a browser refresh cannot be replayed on `/mobile/auth/refresh`
while manager accounts may use the browser and mobile surfaces.

---

### 0.5 Portal-scoped arrivals — `GET /v1/arrivals`

The arrivals feed exposes registered traceability batches as product occurrences.
It requires `catalog:read`.

- Super-admin is organization-wide. Admins are restricted to portals of stores
  they own, and managers to their assigned portal and derived store;
  requesting another portal returns `403 FORBIDDEN`.
- `store_code` is repeatable. `business_portal_id` and `profession` select one
  access dimension; `profession` accepts only `poissonnerie`, `boucherie`, or
  `charcuterie_traiteur`.
- `q` searches product/common name, scientific name, lot, GTIN, and supplier.
- Structured filters are `status`, `alert_state`, `completeness_min`,
  `supplier`, `lot_code`, `gtin`, `captured_by_user_id`, `date_from`, `date_to`,
  `expiry_from`, `expiry_to`, and repeatable `field_filter=field_name:value`.
- Sorting supports `recorded_at`, `expiry_date`, `product_name`, `supplier`,
  `lot_code`, `completeness`, or `status`, with `sort_direction=asc|desc`.
- Results use `{items,total,limit,offset}` and contain no mutable client-owned
  data. Each item carries its store, portal, profession and trade-profile
  snapshot, capturing user, completeness, and alert summary.
- Text prefilters use PostgreSQL trigram indexes over the projection and common
  supplier/lot expressions. Exact totals are counted separately so the limited
  page query can use the portal/date or selected expression sort index.

The organization, store, portal, profession code, profile version, and capture
actor are snapshotted through ingestion, batch, and arrival projection. Historical
products therefore do not move or change trade if a user is later reassigned.

`GET /v1/arrivals/{batch_id}/image` returns the persisted source photo. It uses
the same `catalog:read` scope and store isolation as the arrivals feed.

`GET /v1/arrivals/{batch_id}` returns the current append-only projection:
the profile-specific field set (17 Poissonnerie, 22 Boucherie, or 22
Charcuterie–Traiteur fields), validation metadata, revision date and
`photo_available`. Unknown and invisible identifiers both return `404`,
preventing IDOR probing across organizations, stores, and portals. `403` is
reserved for an authenticated actor attempting a known operation outside its
role or requested portal perimeter.

---

## 1. Ingestion submit — `POST /v1/ingestions`  (Capability 1)

```yaml
paths:
  /v1/ingestions:
    post:
      operationId: submitCapture
      summary: Submit a label capture (raw stored before OCR; extraction enqueued)
      security: [{ bearerAuth: [ingestion:write] }]
      parameters:
        - { name: Idempotency-Key, in: header, required: true,  schema: { type: string, format: uuid } }
        - { name: X-Correlation-Id, in: header, required: false, schema: { type: string } }
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [image]
              properties:
                image: { type: string, format: binary, description: "JPEG/PNG/HEIC, server-enforced max size" }
                meta:
                  type: object
                  properties:
                    barcode_raw:        { type: string, nullable: true, example: "3017620422003" }
                    client_captured_at: { type: string, format: date-time, nullable: true,
                                          description: "Claimed client time; stored as metadata only, NOT authoritative" }
                    client_meta:
                      type: object
                      additionalProperties: true
                      example: { device_id: "kiosk-12", app_version: "1.4.0" }
      responses:
        '202':
          description: Raw artifact stored append-only; extraction enqueued.
          headers:
            Location: { schema: { type: string }, description: "/v1/ingestions/{id}" }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/IngestionAccepted' }
              example:
                ingestion_id: "ing_01J9Z3..."
                status: "raw_stored"
                image_ref: "obj://labelscan/raw/sha256-ab12.../image.jpg"
                checksum: "sha256:ab12..."
                server_received_at: "2026-06-14T09:12:04Z"
                correlation_id: "corr_01J9Z3..."
        '200':
          description: Idempotent replay of a prior identical submit.
          headers: { Idempotency-Replayed: { schema: { type: boolean } } }
          content: { application/json: { schema: { $ref: '#/components/schemas/IngestionAccepted' } } }
        '401': { $ref: '#/components/responses/Unauthenticated' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '409': { $ref: '#/components/responses/IdempotencyConflict' }
        '413': { $ref: '#/components/responses/PayloadTooLarge' }
        '415': { $ref: '#/components/responses/UnsupportedMediaType' }
        '422': { $ref: '#/components/responses/ValidationFailed' }
        '429': { $ref: '#/components/responses/RateLimited' }
        '503': { $ref: '#/components/responses/DependencyUnavailable' }
```

---

## 2. Extraction status — `GET /v1/ingestions/{id}/extraction`  (Capabilities 2, 3)

```yaml
  /v1/ingestions/{id}/extraction:
    get:
      operationId: getExtraction
      summary: Current extraction run with per-field value/confidence/provenance
      security: [{ bearerAuth: [ingestion:read] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ExtractionView' }
              example:
                ingestion_id: "ing_01J9Z3..."
                status: "needs_review"
                extractor_version: "llm-extract@2026-06-01"
                fields:
                  - name: species
                    value: "Gadus morhua"
                    confidence: { score: 0.94, band: high }
                    provenance: { source: llm, extractor_version: "llm-extract@2026-06-01",
                                  source_ref: "raw_ocr_01J.../span:12-19" }
                  - name: use_by
                    value: null
                    confidence: { score: 0.0, band: low }
                    provenance: { source: llm, source_ref: null }
                    reason: not_found
                missing_required_fields: [use_by]
                low_confidence_fields: [fao_area]
        '404': { $ref: '#/components/responses/NotFound' }
        '409': { $ref: '#/components/responses/ExtractionNotReady' }
```

---

## 3. Atomic review — `POST /v1/ingestions/{id}/reviews` (Capability 4)

The mobile production flow submits the final review in one transaction. The
request contains `fields`, whose keys must match the ingestion's versioned trade profile
(16 fields for poissonnerie V2, 21 for the other V2 profiles),
and requires a durable `Idempotency-Key`.

The transaction:

1. locks the ingestion and validates tenant/store ownership;
2. appends a human extraction revision with the complete versioned profile;
3. confirms the ingestion;
4. records the idempotency response and request hash;
5. publishes `catalog.review_finalized` through the transactional outbox.

Replaying the same key and body returns the original result without duplicate.
Reusing the key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
The projection consumer updates `arrival_projection`; prior extraction runs and
human revisions remain immutable.

The former per-field override and confirm endpoints remain temporarily
compatible during the mobile rollout, but new clients use only the atomic
review operation.

### Legacy confirm + override endpoints

```yaml
  /v1/ingestions/{id}/fields/{field_name}:
    patch:
      operationId: overrideField
      summary: Human override of one extracted field (records new human provenance; original retained)
      security: [{ bearerAuth: [extraction:review] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: field_name, in: path, required: true,
            schema: { type: string, enum: [commercial_designation, scientific_name, producer_name,
                      reseller_brand, batch_number, origin_country, FAO_area, production_method,
                      fishing_gear_or_farming_method, expiry_date, packaging_date,
                      storage_temperature, allergens, health_mark, weight, gtin,
                      product_name, supplier_name, price] } }   # active V2 names + historical V1 compatibility
        - { name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [value]
              properties:
                value: { description: "Corrected value (type depends on field); null to clear" }
                note:  { type: string, nullable: true }
                force_gs1:
                  type: boolean
                  default: false
                  description: >
                    Explicit acknowledgement required to override a GS1-owned
                    (barcode-derived) field: batch_number, expiry_date, weight, gtin,
                    packaging_date. Without it those fields return 409
                    FIELD_NOT_EDITABLE (historical contract unchanged). With it, the
                    override is append-only (source='human') and recorded in the audit
                    trail under the dedicated action `ingestion.gs1_field_overridden`.
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/ExtractedField' } } } }
        '404': { $ref: '#/components/responses/NotFound' }
        '409': { $ref: '#/components/responses/IngestionInvalidState' }   # GS1-owned sans force_gs1 (FIELD_NOT_EDITABLE), ou état invalide

  /v1/ingestions/{id}/confirm:
    post:
      operationId: confirmExtraction
      summary: Confirm extraction after review; validates required fields; emits ExtractionConfirmed
      security: [{ bearerAuth: [extraction:confirm] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: false
        content: { application/json: { schema: { type: object, properties: { note: { type: string } } } } }
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  ingestion_id: { type: string }
                  status: { type: string, enum: [confirmed] }
                  batch_id: { type: string, nullable: true, description: "Linked once the batch is registered (async)" }
        '404': { $ref: '#/components/responses/NotFound' }
        '409': { $ref: '#/components/responses/IngestionInvalidState' }
        '422':
          description: A rule-set-required field is still missing/low-confidence.
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
              example:
                type: "https://errors.labelscan/REQUIRED_FIELD_MISSING"
                title: "A required label field is missing or unverified"
                status: 422
                error_code: REQUIRED_FIELD_MISSING
                detail: "Field 'use_by' is required by rule-set v7 but not extracted with sufficient confidence."
                retriable: false
                correlation_id: "corr_01J..."
                errors: [{ field: use_by, code: REQUIRED_FIELD_MISSING, message: "required by rule-set v7" }]
```

---

## 4. Batch create — `POST /v1/batches`  (Capability 5)

```yaml
  /v1/batches:
    post:
      operationId: createBatch
      summary: Create a batch/lot (GTIN checksum enforced; links source ingestion)
      security: [{ bearerAuth: [batch:write] }]
      parameters:
        - { name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/BatchCreate' }
            example:
              lot_code: "L24-0917"
              gtin: "3017620422003"
              species: "Cod"
              scientific_name: "Gadus morhua"
              fao_area: "27"
              production_method: "wild_caught"   # D5: matches batch CHECK (wild_caught|farmed)
              use_by: "2026-06-20"
              supplier_id: "sup_01J..."
              source_ingestion_id: "ing_01J..."
      responses:
        '201':
          headers: { Location: { schema: { type: string } } }
          content: { application/json: { schema: { $ref: '#/components/schemas/Batch' } } }
        '409': { $ref: '#/components/responses/IdempotencyConflict' }
        '422':
          description: GTIN checksum invalid or duplicate lot code.
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
              example: { error_code: GTIN_CHECKSUM_INVALID, status: 422, title: "GTIN fails check-digit", retriable: false }
```

---

## 5. Supplier CRUD — `/v1/suppliers`  (Capability 6)

```yaml
  /v1/suppliers:
    post:
      operationId: createSupplier
      security: [{ bearerAuth: [supplier:write] }]
      parameters:
        - { name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:            { type: string }
                approval_number: { type: string, nullable: true, example: "FR 12.345.678 CE" }
      responses:
        '201': { content: { application/json: { schema: { $ref: '#/components/schemas/Supplier' } } } }
    get:
      operationId: listSuppliers
      security: [{ bearerAuth: [traceability:read] }]
      parameters:
        - { name: q,      in: query, schema: { type: string } }
        - { name: limit,  in: query, schema: { type: integer, default: 50, maximum: 200 } }
        - { name: cursor, in: query, schema: { type: string } }
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/SupplierPage' } } } }

  /v1/suppliers/{id}:
    patch:
      operationId: updateSupplier
      security: [{ bearerAuth: [supplier:write] }]
      parameters:
        - { name: id,       in: path,   required: true, schema: { type: string } }
        - { name: If-Match, in: header, required: true, schema: { type: string }, description: "ETag for optimistic concurrency" }
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/Supplier' } } } }
        '412': { $ref: '#/components/responses/PreconditionFailed' }
    delete:
      operationId: deactivateSupplier
      summary: Soft-deactivate only (never hard-delete; referenced by immutable batches)
      security: [{ bearerAuth: [supplier:admin] }]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { '204': { description: Deactivated } }
```

---

## 6. Traceability lookup — `GET /v1/trace`  (Capability 7)

```yaml
  /v1/trace:
    get:
      operationId: traceLookup
      summary: Lookup chain lot -> product -> supplier -> source ingestion
      security: [{ bearerAuth: [traceability:read] }]
      parameters:
        - { name: lot_code,    in: query, schema: { type: string } }
        - { name: gtin,        in: query, schema: { type: string } }
        - { name: supplier_id, in: query, schema: { type: string } }
        - { name: limit,       in: query, schema: { type: integer, default: 50, maximum: 200 } }
        - { name: cursor,      in: query, schema: { type: string } }
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/TracePage' }
              example:
                items:
                  - batch_id: "bat_01J..."
                    lot_code: "L24-0917"
                    gtin: "3017620422003"
                    species: "Gadus morhua"
                    fao_area: "27"
                    use_by: "2026-06-20"
                    supplier: { id: "sup_01J...", name: "Atlantic Catch Ltd", approval_number: "FR 12.345.678 CE" }
                    source_ingestion_id: "ing_01J..."
                    alerts: [{ alert_id: "alr_01J...", type: expiry, severity: medium, state: open }]
                next_cursor: null
        '400':
          description: No lookup key supplied.
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' },
                     example: { error_code: VALIDATION_ERROR, status: 400, retriable: false } } }
```

---

## 7. Temperature log — `POST /v1/temperature-logs`  (Capability 8)

```yaml
  /v1/temperature-logs:
    post:
      operationId: logTemperature
      summary: Append a temperature reading (append-only; triggers control evaluation)
      security: [{ bearerAuth: [temperature:write] }]
      parameters:
        - { name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [location, temp_c, measured_at]
              properties:
                location:    { type: string, example: "cold-room-3" }
                temp_c:      { type: number, minimum: -50, maximum: 60 }
                measured_at: { type: string, format: date-time }
                batch_id:    { type: string, nullable: true }
                source:      { type: string, enum: [manual, sensor], default: manual }
      responses:
        '201': { content: { application/json: { schema: { $ref: '#/components/schemas/TemperatureLog' } } } }
        '422': { $ref: '#/components/responses/ValidationFailed' }
```

---

## 8. Alerts — `GET /v1/alerts`, `POST /v1/alerts/{id}/acknowledge`  (Capability 9)

```yaml
  /v1/alerts:
    get:
      operationId: listAlerts
      security: [{ bearerAuth: [haccp:read] }]
      parameters:
        - { name: state,    in: query, schema: { type: string, enum: [open, acknowledged, resolved] } }
        - { name: severity, in: query, schema: { type: string, enum: [low, medium, high, critical] } }
        - { name: type,     in: query, schema: { type: string, enum: [expiry, temperature, required_field] } }
        - { name: batch_id, in: query, schema: { type: string } }
        - { name: limit,    in: query, schema: { type: integer, default: 50, maximum: 200 } }
        - { name: cursor,   in: query, schema: { type: string } }
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/AlertPage' } } } }

  /v1/alerts/{id}/acknowledge:
    post:
      operationId: acknowledgeAlert
      security: [{ bearerAuth: [alert:ack] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: false
        content: { application/json: { schema: { type: object, properties: { note: { type: string } } } } }
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/Alert' } } } }
        '409':
          description: Invalid lifecycle transition (alert not in 'open').
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' },
                     example: { error_code: ALERT_INVALID_TRANSITION, status: 409, retriable: false } } }
```

---

## 9. Audit query — `GET /v1/audit`  (Capability 10)

```yaml
  /v1/audit:
    get:
      operationId: queryAudit
      summary: Read-only query of the append-only audit log (no write path exists)
      security: [{ bearerAuth: [audit:read] }]
      parameters:
        - { name: actor_id,       in: query, schema: { type: string } }
        - { name: action,         in: query, schema: { type: string } }
        - { name: subject_ref,    in: query, schema: { type: string } }
        - { name: correlation_id, in: query, schema: { type: string } }
        - { name: from,           in: query, schema: { type: string, format: date-time } }
        - { name: to,             in: query, schema: { type: string, format: date-time } }
        - { name: limit,          in: query, schema: { type: integer, default: 50, maximum: 200 } }
        - { name: cursor,         in: query, schema: { type: string } }
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AuditPage' }
              example:
                items:
                  - entry_id: "aud_01J..."
                    action: "ExtractionConfirmed"
                    actor: { id: "usr_01J...", role: supervisor }
                    subject_ref: "ing_01J..."
                    before_ref: "snap_01J...a"
                    after_ref:  "snap_01J...b"
                    occurred_at: "2026-06-14T09:14:10Z"
                    correlation_id: "corr_01J..."
                    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736"
                next_cursor: null
    # No post/put/patch/delete -> any such request returns 405 METHOD_NOT_ALLOWED.
```

---

## Error-code catalog

Authoritative, **append-only**, never renumbered or repurposed. `Retriable?` = may a well-behaved
client retry (with backoff + jitter, reusing the same `Idempotency-Key` for unsafe ops)?

| `error_code` | HTTP | Meaning | Retriable? |
|--------------|------|---------|-----------|
| `VALIDATION_ERROR` | 400 | Malformed query/path/body. | No |
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired token. | No (re-auth) |
| `FORBIDDEN` | 403 | Lacks required scope/role. | No |
| `NOT_FOUND` | 404 | Resource absent or not visible. | No |
| `METHOD_NOT_ALLOWED` | 405 | e.g. write attempt on audit log. | No |
| `STORE_NOT_FOUND` | 400 | Referenced store code does not exist. | No |
| `STORE_REQUIRED` | 400 | The account has no attributable store assignment. | No |
| `USER_ALREADY_EXISTS` | 409 | Username is already assigned. | No |
| `STORE_ALREADY_EXISTS` | 409 | Store code is already assigned. | No |
| `STORE_INACTIVE` | 409 | Disabled store cannot receive an assignment. | No |
| `STORE_IN_USE` | 409 | Store still has active users or active portal assignments. | No |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Key reused with a different payload. | No (new key) |
| `RESOURCE_CONFLICT` | 409 | Generic conflict (e.g. in-progress idempotent op, duplicate). | Sometimes (poll) |
| `ALERT_INVALID_TRANSITION` | 409 | Alert lifecycle move not allowed. | No |
| `INGESTION_INVALID_STATE` | 409 | Action invalid for ingestion status. | No |
| `EXTRACTION_NOT_READY` | 409 | Extraction not yet complete. | Yes (poll) |
| `PRECONDITION_FAILED` | 412 | `If-Match` ETag mismatch. | Yes (re-read) |
| `PAYLOAD_TOO_LARGE` | 413 | Body/image over limit. | No |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Image type not accepted. | No |
| `REQUIRED_FIELD_MISSING` | 422 | Confirm blocked: required field null/low-confidence. | No (review) |
| `LOW_CONFIDENCE_FIELD` | 422 | Field below confirm threshold. | No (review) |
| `GTIN_CHECKSUM_INVALID` | 422 | GTIN/EAN check digit fails. | No |
| `LOT_CODE_DUPLICATE` | 422 | Lot code already exists for supplier+product. | No |
| `BUSINESS_RULE_VIOLATION` | 422 | Generic domain-invariant breach. | No |
| `RATE_LIMITED` | 429 | Too many requests (see `Retry-After`). | Yes (delay) |
| `INTERNAL_ERROR` | 500 | Unexpected fault (details logged only). | Yes (cautious) |
| `EXTRACTION_PROVIDER_ERROR` | 502 | OCR/LLM provider error (sync trigger). | Yes |
| `DEPENDENCY_UNAVAILABLE` | 503 | DB/object-store/provider down or circuit open. | Yes (`Retry-After`) |
| `GATEWAY_TIMEOUT` | 504 | Upstream provider exceeded timeout. | Yes |

### Problem schema (shared)

```yaml
components:
  schemas:
    Problem:
      type: object
      required: [type, title, status, error_code, correlation_id, timestamp, retriable]
      properties:
        type:           { type: string, format: uri }
        title:          { type: string }
        status:         { type: integer }
        detail:         { type: string }
        error_code:     { type: string }
        correlation_id: { type: string }
        trace_id:       { type: string }
        timestamp:      { type: string, format: date-time }
        retriable:      { type: boolean }
        errors:
          type: array
          items:
            type: object
            properties:
              field:   { type: string }
              code:    { type: string }
              message: { type: string }
```
