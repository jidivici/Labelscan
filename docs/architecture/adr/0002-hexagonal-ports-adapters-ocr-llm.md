# ADR-0002: Hexagonal ports & adapters for OCR/LLM (and persistence)

## Status
Accepted & Implemented

## Context
Today the OCR provider (Google Cloud Vision) is hardwired: `extractTextFromImage` in
`src/services/ocr.ts` is imported and called directly from `src/screens/CameraScreen.tsx`
([initial audit](../../archive/AUDIT.md), A1). Persistence is hardwired to AsyncStorage. The brief requires that OCR and LLM
providers be **replaceable** and that the **domain layer not depend on** frameworks, DB, HTTP, or
OCR/LLM providers (constraints #5, #6).

## Decision
Apply **hexagonal architecture (ports & adapters)** in the contexts where domain rules need
isolation — primarily **Ingestion & Extraction** and **HACCP**. The domain defines **outbound
ports** as interfaces: `OcrPort`, `LlmExtractorPort`, `RawArtifactRepository`,
`IngestionRepository`, `ObjectStore`, `Clock`, `AuditLogPort`, `EventBus`. Concrete adapters
(Google Vision, the chosen LLM, PostgreSQL, S3) implement these ports and are wired only in the
composition root (`app/main.py`). Each provider adapter is an **anti-corruption layer**: it maps
the vendor's response into the domain's own types (e.g. normalized per-token confidence), so no
vendor shape leaks inward.

## Consequences
- **Easier:** swapping OCR or LLM providers (new adapter, no domain change); unit-testing the
  domain and use cases with in-memory fakes (no network, no DB); keeping the bundled API-key
  problem ([initial audit](../../archive/AUDIT.md), A3) out of the client entirely.
- **Harder:** more indirection and a little boundary-mapping code; developers must resist calling
  SDKs directly from use cases.

## Alternatives considered
1. **Direct SDK calls from application/services (status quo, server-side).** Rejected: violates
   #5/#6; provider change becomes a multi-site edit; untestable without the network.
2. **A thin facade/wrapper module without inverted ownership.** Rejected: a facade the domain
   *calls outward* still couples the domain to an outward module; ports owned by the domain keep
   the dependency arrow pointing inward.
3. **Hexagonal everywhere, including CRUD reference data.** Rejected as over-engineering — see
   ADR-0006; layered modules suffice there.

## Trade-offs
We trade *some indirection and mapping code* for *provider independence, testability, and a
framework-free domain*. For simple CRUD this indirection would be waste; it is applied only where
a real coupling/change problem exists.

## Reversibility
**High.** Ports are interfaces; a wrong adapter choice is a localized rewrite of one adapter. If a
port proves to add no value in a given context, that context can drop to a layered design without
affecting others (the boundary is per-context).

## Notes — two-tier extraction & prompt caching (2026-06-19)
Two capabilities ship entirely **behind the existing `LlmExtractorPort`** (and
`platform/observability`), so **no new ADR is required** — both are adapter/config choices this
port was designed to absorb (see *Reversibility* above):

- **Two-tier escalation.** `claude-haiku-4-5` is the primary extractor; `claude-opus-4-8` is the
  escalation tier (SYNTHESIS C12 — supersedes the older `claude-sonnet-4-6` placeholder). The tier
  is a *second* `ClaudeLlmExtractor` instance bound to the stronger model, injected at the
  composition root and called **at most once per ingestion**, only when the gated primary would
  force `needs_review` on a rule-set-required free-text field that GS1 cannot supply. The domain
  gate (`evaluate`) and GS1 precedence are untouched: the escalated output is re-gated (no
  relaxation) and reconciled with GS1 (GS1 still wins). Config: `LABELSCAN_LLM_ESCALATION_ENABLED`
  (default off), `LABELSCAN_LLM_ESCALATION_MODEL` (default `claude-opus-4-8`).
- **Prompt caching.** The large static system prefix carries one `cache_control` breakpoint so
  Anthropic bills it at ~0.1× on a hit; the per-label OCR text + GS1 hint stay in the dynamic user
  message. Haiku 4.5 caches only a ≥4096-token prefix, so the prefix is authored above that floor.
  Config: `LABELSCAN_LLM_PROMPT_CACHE_ENABLED` (default on), `LABELSCAN_LLM_PROMPT_CACHE_TTL`
  (default `1h`).

Persistence is additive/nullable only (migration `0010`: `raw_artifact.model`,
`extraction_run.escalation_model`); `extraction_run` stays append-only and `is_latest` intact.
</content>
