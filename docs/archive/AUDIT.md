# LabelScan — Architecture & Data-Integrity Audit

> **Archived:** Point-in-time audit, not a current risk or implementation guide. See the
> [archive index](README.md) and [living documentation](../README.md).

**Date:** 2026-06-14
**Scope:** `LabelScan/` only.
**Reviewed at commit:** `0235ab6` (Initial commit).
**Target system:** HACCP-oriented seafood traceability for large-scale retail fishmongery.

---

## 1. What the codebase is today

A **frontend-only Expo / React Native app** (Expo SDK 54, TypeScript `strict`). It has no
backend, no database, no domain layer, and no seafood/HACCP data model. The end-to-end flow:

1. **`src/screens/CameraScreen.tsx`** — opens the camera (`expo-camera`), scans a barcode,
   auto-captures after a 1.5 s lock, crops a fixed screen band "below the barcode," and sends
   that crop to **Google Cloud Vision `TEXT_DETECTION`** (`src/services/ocr.ts`).
2. **`src/screens/ReviewScreen.tsx`** — shows the photo + raw OCR text; binary Save / Retake.
3. **`src/services/storage.ts`** — saves an `Article { id, photoUri, ocrText, barcodeValue?, capturedAt }`
   into a single AsyncStorage JSON array; the photo file goes to the device document directory.
4. **`src/screens/ArticleListScreen.tsx`** — lists, deletes, and exports (JSON / CSV via the
   native share sheet, `src/services/export.ts`).

**Headline finding:** measured against the brief, this is a generic *"photograph a label →
OCR to a string → save a blob"* MVP. It implements **none** of the required architecture
(modular monolith, hexagonal core, PostgreSQL, APIs) and **none** of the required domain model
(products, batches, suppliers, HACCP controls, temperature logs, alerts, immutable audit log).

The capture UI itself is reasonable and is salvageable — in the target design it becomes a thin
*ingestion client* in front of a real backend.

---

## 2. Data-integrity weaknesses

Each maps to a stated constraint.

| ID | Finding | Constraint violated | Evidence |
|----|---------|--------------------|----------|
| **D1** | OCR result is a single opaque string. No structured seafood fields (species, scientific name, wild/farmed, FAO catch area, gear type, lot/batch, supplier approval / CE number, use-by date, storage temperature). | "Extract structured seafood label information" | `src/types/Article.ts`; `ocr.ts` returns `string` |
| **D2** | **No confidence scores.** Cloud Vision returns per-block/word confidence in `fullTextAnnotation`; the code reads only `.text` and discards the rest. | "Every extracted field must have a confidence score" | `ocr.ts` — `json?.responses?.[0]?.fullTextAnnotation?.text` |
| **D3** | **Raw label data is never stored.** Even the raw OCR JSON (bounding boxes, confidence) is thrown away — only `.text` survives. There is no raw→normalized separation. | "Raw label data must be stored before normalization" | `ocr.ts` return value; `Article` shape |
| **D4** | History is **mutable and destructive.** `deleteArticle` physically removes the record and the photo file; `saveArticle` rewrites the entire JSON array (non-atomic read-modify-write → lost-update / corruption risk). | "Historical traceability data must be immutable"; "all business-critical changes must be auditable" | `storage.ts` — `deleteArticle`, `saveArticle` |
| **D5** | **No audit log** — nothing records who/what/when for any change. | "All business-critical changes must be auditable" | absent |
| **D6** | **No required-field validation** — an article with empty OCR text saves successfully. | "Validate required fields" | `ReviewScreen.tsx` — `handleSave` |
| **D7** | **Crop geometry is wrong on most devices.** It maps screen px → photo px via `photo.width / SCREEN_WIDTH` and `ZONE_TOP = SCREEN_HEIGHT * 0.52`, while the camera preview is cover-cropped (preview aspect ratio ≠ photo aspect ratio), plus a magic `* 2.5` height. OCR frequently reads the wrong region of the label. | data correctness | `CameraScreen.tsx` — `handleCapture` crop region |
| **D8** | Barcode value is stored raw with **no GTIN/EAN checksum validation** and no link to a product identity. | data correctness | `CameraScreen.tsx`; `Article.barcodeValue` |
| **D9** | Capture timestamp is the **untrusted device clock** (`new Date().toISOString()`), with no server time and no timezone capture. | audit reliability | `CameraScreen.tsx` — `capturedAt` |

---

## 3. Architectural weaknesses

- **A1 — No domain isolation / no ports & adapters.** The OCR provider (Google Vision) is
  hardwired in `services/ocr.ts` and called directly from `CameraScreen`; persistence is
  hardwired to AsyncStorage. Replacing the OCR/LLM provider means editing call sites.
  Violates: "the domain layer must not depend on frameworks, databases, HTTP, OCR providers,
  or LLM providers."
- **A2 — No persistence tier.** All data lives in AsyncStorage on a single device. No
  PostgreSQL, no APIs (ingestion / traceability lookup / alert management), no multi-user, no
  durability or backup → cannot be "audit-ready historical records."
- **A3 — Secret leak.** `EXPO_PUBLIC_GOOGLE_VISION_KEY` is embedded in the client JS bundle and
  visible in network logs (the source comment acknowledges this). OCR calls must move
  server-side.
- **A4 — Mixed concerns + silent data loss.** `handleCapture` performs camera capture, image
  crop, OCR HTTP, and navigation in one function, swallowing errors into a 2.5 s "error" state.
  Hard to test; **on OCR failure the photo and barcode are lost** (no retry, no durable queue).
- **A5 — No tests, no CI.** Single "Initial commit"; no test infrastructure.
- **A6 — Non-portable export.** JSON/CSV export embeds the device-local `photoUri`, which is
  meaningless off-device; not a real data-exchange format.
- **A7 — Doc/version drift.** `AGENTS.md` instructs reading Expo **v56** docs, while
  `app.json` / `package.json` pin Expo SDK **54**.

---

## 4. Proposed progressive redesign (for later — not yet started)

Modular monolith with a framework-free hexagonal core. **Backend stack decided: Python / FastAPI**
(Pydantic for boundary validation); accepted trade-off: no type sharing with the TypeScript
mobile app. Increments, each independently valuable — no big-bang rewrite:

- **Phase 0 — Foundations.** `server/` modular monolith, PostgreSQL, framework-free `domain/`
  package, ports defined (`OcrPort`, `LlmExtractorPort`, `LabelRepository`, `AuditLog`).
  *Trade-off:* adds a service to run — but the brief requires it.
- **Phase 1 — Immutable ingestion.** `POST /ingestions` stores **raw** (image reference + raw
  OCR JSON incl. confidence) append-only **before** any normalization; server-stamped time;
  audit entry. Addresses D3, D4, D5, D9.
- **Phase 2 — Structured extraction with confidence.** OCR → LLM extraction behind ports →
  typed seafood fields, each with a confidence score and provenance; unknown fields remain
  `null` (no hallucination, no invented fields). Addresses D1, D2, and "don't invent."
- **Phase 3 — Domain model & validation.** Products, Batches, Suppliers, HACCP controls,
  TemperatureLogs, Alerts, AuditLog; required-field validation at the boundary; GTIN checksum.
  Addresses D6, D8.
- **Phase 4 — Traceability & alerts APIs.** Lookup by lot / product / supplier; expiry and
  temperature alerting.
- **Phase 5 — Mobile app → thin ingestion client.** Posts image / raw OCR to the backend; drops
  the bundled API key (A3); adds a durable offline queue (A4).

Each phase ships with tests and a short trade-off note.
