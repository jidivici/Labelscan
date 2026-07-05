# LabelScan — API Contracts (OpenAPI 3.1 fragments + error catalog)

**Status:** Partially implemented — see [`BACKEND-ARCHITECTURE.md`](./BACKEND-ARCHITECTURE.md) §8
for the list of implemented vs planned endpoints. This document describes the target API contract.
**Date:** 2026-06-18 (updated from 2026-06-14 design)
**Companion to:** [`BACKEND-ARCHITECTURE.md`](./BACKEND-ARCHITECTURE.md) (see §8 endpoint list,
§9 error model, §10 auth, §11 idempotency). Machine-readable skeleton:
[`openapi.v1.yaml`](./openapi.v1.yaml).

**Implementation notes (as of 2026-06-18):**
- Auth: HS256 JWT (not RS256/OIDC yet); single `admin` role grants all scopes.
- Default LLM: `claude-haiku-4-5` (not `claude-opus-4-8`); GS1 handles critical exact fields.
- `extracted_field.source` ∈ `{llm, gs1, human}` (not `{llm, human}`); `field_name` includes `gtin`.
- Implemented endpoints: POST /auth/login, POST /ingestions, GET /ingestions/{id},
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

## 3. Confirm + override — `POST /v1/ingestions/{id}/confirm`, `PATCH .../fields/{name}`  (Capability 4)

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
                      storage_temperature, allergens, health_mark, weight, price, gtin,
                      product_name, supplier_name] } }   # D1: v2 names (prompt v2.0.0) + legacy (migration 0011 superset)
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
