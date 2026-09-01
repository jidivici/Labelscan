# ADR-0002: Hexagonal ports and adapters for OCR/LLM and persistence

## Status

Accepted and implemented

The context and alternatives below preserve the conditions recorded when this decision
was made. The current runtime is summarized at the end.

## Context

At decision time, the Google Cloud Vision OCR provider was hardwired:
`extractTextFromImage` in `src/services/ocr.ts` was imported and called directly from
`src/screens/CameraScreen.tsx`. Persistence was also hardwired to AsyncStorage.
The brief required OCR and LLM providers to be **replaceable** and the **domain layer to
remain independent of** frameworks, databases, HTTP, and provider SDKs. The original
detailed audit and target-architecture source material is retained in Git history; the
archived landing pages no longer reproduce its numbered findings and sections.

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
  problem that existed in the mobile-only application out of the client entirely.
- **Harder:** more indirection and a little boundary-mapping code; developers must resist calling
  SDKs directly from use cases.

## Alternatives considered

1. **Direct SDK calls from application/services (status quo, server-side).** Rejected: it
   violates the framework-independence and provider-replaceability constraints; provider
   change becomes a multi-site edit and tests require a network.
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

## Current implementation note

The decision remains active. Ports live in the context application packages, Google Vision
and Anthropic are adapters, and composition is split across `server/src/labelscan/app/`
rather than one `app/main.py`.

The current Anthropic adapter defaults the primary extractor to `claude-haiku-4-5`. An
optional second `ClaudeLlmExtractor` defaults to `claude-opus-4-8`; it is disabled unless
`LABELSCAN_LLM_ESCALATION_ENABLED` is true. When enabled, it can run once for a required
free-text field that the primary gate leaves unresolved and GS1 cannot supply. The merged
result goes through the same evidence gate and GS1 reconciliation, so escalation does not
relax domain validation. Model IDs remain configurable through `LABELSCAN_LLM_MODEL` and
`LABELSCAN_LLM_ESCALATION_MODEL`.

Prompt caching is an adapter option controlled by `LABELSCAN_LLM_PROMPT_CACHE_ENABLED` and
`LABELSCAN_LLM_PROMPT_CACHE_TTL`. The current adapter marks only the fishmonger profile's
static system block as cacheable; label-specific OCR and GS1 data remain in the dynamic
message. Migration `0010` added nullable model metadata while preserving append-only
extraction runs. Model availability, cache eligibility, pricing, and provider limits can
change independently of this ADR, so the adapter source, runtime configuration, and provider
contract are the operational source of truth.
