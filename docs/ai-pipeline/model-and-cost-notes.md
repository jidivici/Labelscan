  # LabelScan — Model & Cost Notes (AI Engineer)

**Status:** Implemented (default adapter = `claude-haiku-4-5`; GS1 handles critical exact fields).
**Date:** 2026-06-18 (updated from 2026-06-14 design)
**Author:** AI Engineer
**Scope:** `LabelScan/` only. Companion to [`AI-PIPELINE.md`](./AI-PIPELINE.md) — read that first
for the architecture; this file is the concrete model table + a worked cost/latency estimate.

> **Provider facts are verified.** Every Claude model id, price, context window, and API parameter
> below is taken from the grounding facts supplied to the AI Engineer step (and cross-checked
> against the `claude-api` reference). Anything not on that list is marked **[must verify]** rather
> than asserted. No real FAO/approval/regulatory code appears here.
>
> The **ports stay provider-agnostic** (ADR-0002). This table is the *default adapter*
> recommendation behind `LlmExtractorPort` (and, for the single-pass option, behind `OcrPort`).
> Swapping it is an adapter change, not a contract change.

---

## 1. Model table (LLM extraction adapter — default = Claude)

| Model | Model id | Context | Max output | Input $/1M | Output $/1M | When to use behind `LlmExtractorPort` |
|-------|----------|--------:|-----------:|-----------:|------------:|---------------------------------------|
| **Claude Haiku 4.5** | `claude-haiku-4-5` | 200K | 64K | **$1** | **$5** | **DEFAULT (current production).** The hybrid GS1+LLM architecture means GS1 handles the critical exact fields (lot, DLC, weight, GTIN, packaging_date) with confidence 1.0. Haiku only needs to extract free-text fields (species, designation, origin, allergens…) where its capability is sufficient. Configurable via `LABELSCAN_LLM_MODEL`. |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 64K | $3 | $15 | **De-escalation** for high-volume / clean-label streams once calibrated. |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | 128K | $5 | $25 | **Escalation** for the hardest cases (dense multilingual, severe OCR garble) when Haiku + bounded repair has failed and the alternative is human review. 5× the Haiku cost. |
| Claude Fable 5 | `claude-fable-5` | 1M | 128K | $10 | $50 | **Last resort** for the hardest residual cases. 10× Haiku cost. |

**Model id discipline:** use the exact id strings above — never append a date suffix. The OCR-side
default (Google Vision) is unchanged from the locked design; see [`AI-PIPELINE.md`](./AI-PIPELINE.md)
§2 for the OCR provider table.

### Why Haiku is the default (the GS1 shift)

The original design defaulted to `claude-opus-4-8` for all extractions. The **hybrid GS1+LLM
extraction** (implemented in `ingestion/domain/gs1.py` + `reconciliation.py`) changed the calculus:
GS1 barcode parsing is deterministic and exact (confidence 1.0) for the most critical HACCP fields
(batch_number, expiry_date, weight, gtin, packaging_date). The LLM now only handles free-text
fields where Haiku's instruction-following is sufficient for the extraction.v1 contract. The
anti-fabrication gate (`evaluate()`) still validates every LLM value against the raw OCR text.

### Default escalation / de-escalation policy

- **Default:** `claude-haiku-4-5` for every extraction.
- **De-escalate** to `claude-haiku-4-5` is already the floor; no cheaper tier is used.
- **Escalate to `claude-opus-4-8`** only when the gated Haiku result would force `needs_review` on a
  rule-set-required free-text field GS1 cannot supply, before falling to human review. This is now
  **automatic** behind a *second* `LlmExtractorPort` instance (no longer a `LABELSCAN_LLM_MODEL`
  swap): enable with `LABELSCAN_LLM_ESCALATION_ENABLED=true`; the tier is
  `LABELSCAN_LLM_ESCALATION_MODEL` (default `claude-opus-4-8`). Escalation runs at most once per
  ingestion, is re-gated (no relaxation), and reconciled with GS1 (GS1 wins). A lot/DLC barcode↔print
  conflict is a real anomaly and is **not** escalated. See ADR-0002 notes (2026-06-19).
- **Never** silently change the model mid-conversation in a way that breaks prompt caching — each
  tier is a distinct adapter configuration with its own cached prefix.

---

## 2. API parameters for the extraction adapter (verified)

These are the concrete settings the `LlmExtractorPort` Claude adapter uses. The PROMPT-CONTRACT
forbids vendor specifics from appearing in the contract itself; they live **here, in the adapter**.

| Concern | Setting | Note (verified) |
|---------|---------|-----------------|
| **Structured output** | `output_config: {format: {type: "json_schema", schema: <extraction.v1>}}` | Canonical param. (`output_format` is deprecated.) In Python the adapter MAY use `client.messages.parse(..., output_format=PydanticModel)` to validate shape against the schema. Guarantees **shape, not truth** — the backend gate still re-validates (defense in depth, §5 of AI-PIPELINE). |
| **Thinking** | `thinking: {type: "adaptive"}` | Do **not** use `budget_tokens` (removed on Opus 4.7/4.8 → 400). Adaptive lets the model decide depth. |
| **Effort** | `output_config: {effort: "low"|"medium"|"high"}` | Controls depth/spend. Start at `medium` for routine clean labels; `high` for noisy/ambiguous labels and for escalations. Tune per slice against the eval suite. |
| **Determinism** | adaptive thinking + fixed `effort`; **no** `temperature`/`top_p`/`top_k` | Sampling params are removed on Opus 4.7/4.8 (→ 400). The PROMPT-CONTRACT's "deterministic settings" requirement is met by fixing `effort` and prompt; attributable eval runs come from a frozen prompt + frozen `effort`. |
| **Prompt caching** | cache the stable system prompt (the contract) as a prefix; volatile per-label OCR after the breakpoint | ~90% cost cut on the cached portion. Prefix-match invariant: any byte change in the prefix invalidates the cache. See §3. |
| **Token estimates** | the model's `count_tokens` endpoint | **Never** tiktoken (wrong for Claude). Used for the per-run cost ceiling check (BACKEND §10.4) and the estimate in §6. |
| **Batches** | Batches API for non-latency-sensitive re-extraction / backfill | 50% cost reduction, async ≤24h. See §6. |
| **Refusal** | handle `stop_reason: "refusal"` (HTTP 200) | Treat as extraction failure → retain raw → `ExtractionFlaggedForReview` (reason `extractor_refused`). Never fabricate. SDK auto-retry covers 429/5xx; refusals are **not** auto-retried. See AI-PIPELINE §6. |
| **Retry** | rely on SDK auto-retry for 429/408/409/5xx (exp. backoff, `max_retries`); 400/401/403 **not** retried | Aligns with BACKEND §9.1 LLM row (≤2 repair re-asks, circuit breaker separate from OCR). |

---

## 3. Prompt-caching layout (the cost lever)

```
[ tools (none — extraction uses structured output, not tools) ]
[ SYSTEM: the full seafood-label-extraction/v1.1.0 system prompt (+ seafood/HACCP recognition block) ]  ← cache_control breakpoint here (STABLE)
------------------------------------------------------------------- cache prefix ends -------------
[ USER: <<<OCR_START {{ocr_text}} OCR_END>>> + barcode_raw/locale_hint/ocr_mean_confidence ]    ← VOLATILE, after the breakpoint
```

- The system prompt (contract text + schema) is large and **identical for every label** → ideal
  cache prefix. The per-label OCR text is small and changes every call → after the breakpoint.
- **Silent invalidators to avoid in the adapter:** no `datetime.now()`, request id, or per-label
  value in the system prefix; serialize the schema deterministically (stable key order). Verify with
  `usage.cache_read_input_tokens > 0` across repeated calls.
- **Caching is model-scoped.** Each model tier (Opus 4.8 / Sonnet / Haiku / Fable) has its own
  cache; a de-escalation or escalation pays one cold write on that model. This is another reason to
  keep tier-switching to *slices* (warm cache per tier), not per-label flapping.
- **Minimum cacheable prefix:** `claude-haiku-4-5` (the default) and Opus 4.8 cache at ≥4096 tokens;
  the seafood-label system prompt + schema comfortably exceeds that. (Sonnet 4.6 / Fable 5 cache at ≥2048.)
- **Seafood/HACCP specialization (prompt `v1.1.0`):** the cached static prefix carries a
  `SEAFOOD / HACCP DOMAIN CONTEXT` recognition block (allergen families, cold-chain wording,
  FAO-number-only, quality-claim handling, scientific-name shape) — a *recognition aid only*, never a
  fabrication license, so the no-fabrication gate is unaffected. It improves Haiku recall (fewer
  needless `needs_review`/escalations → lower effective cost) and keeps the prefix comfortably above
  the 4096 floor. A prompt change is a MINOR bump (PROMPT-CONTRACT §2, schema unchanged); re-run the
  eval regression gate (SC1/SC3/SC10) before a production rollout, and `scripts/measure_prompt_tokens.py`
  to confirm the 4096 floor.

---

## 4. Claude Fable 5 — escalation-tier caveats (verified)

Only relevant if the escalation tier is wired. Fable 5 has a **different API surface** than the
Opus family:

- **Thinking is always on** — omit the `thinking` param (an explicit `{type:"disabled"}` → 400).
  Control depth with `output_config.effort` (supports up to `max`).
- **Raw chain of thought never returned** — use `display: "summarized"` if reasoning is surfaced;
  otherwise the thinking text is empty.
- **Refusal handling matters more** — safety classifiers may decline (HTTP 200, `stop_reason:
  "refusal"`). Recovery is opt-in via the server-side `fallbacks` parameter
  (`betas: ["server-side-fallback-2026-06-01"]`, `fallbacks: [{"model": "claude-opus-4-8"}]`). For
  the LabelScan extraction adapter the simpler policy is: **treat a Fable refusal as a terminal
  extraction failure → retain raw → review** (we are already past Opus by the time we escalate), so
  the fallback parameter is optional, not required, here.
- **30-day data retention required** — Fable 5 is not available under zero-data-retention; if the
  org's retention config is below 30 days, *every* Fable request 400s. **[must verify]** the org's
  retention config before enabling the escalation tier.
- **Same tokenizer as Opus 4.8** — token counts (and the §6 estimate) carry over unchanged; only
  the per-token price differs (2×).

---

## 5. Single-pass-vision option (Claude vision as OCR-and-extract)

Claude supports **high-resolution vision** (image input via base64 or URL; up to ~2576px long edge
on Opus 4.7+), so a single Claude vision call can do **OCR + structured extraction in one pass**.
This is offered as an **architectural option behind the ports** (see AI-PIPELINE §1, §2), not the
default. Cost note: a full-resolution image costs **image tokens** (up to ~4784 input tokens per
image on Opus 4.7+ at full res) **on top of** the prompt — materially more input tokens than the
two-stage path's short OCR text, and it **loses the cheap OCR-quality gate cost saver** (you pay the
LLM on every garbage image). Reserve it for the escalation/repair path on a hard image, never the
default high-volume path. Downsample client-side or server-side to cut image tokens when the fidelity
isn't needed — but only as a tuned decision, never a blind default.

---

## 6. Worked cost & latency estimate per extraction (two-stage default path)

> **Illustrative, order-of-magnitude.** Real numbers must be re-measured with `count_tokens` on a
> representative golden label and the production `effort` setting. Token counts below are estimates,
> not measurements — treat as **[must verify with `count_tokens`]**. The point is the *shape* of the
> spend, which drives the policy, not a billing figure.

**Assumptions for one typical clean label, two-stage (OCR → LLM), default `claude-haiku-4-5`:**

| Component | Estimate | Basis |
|-----------|---------:|-------|
| System prompt + inlined schema (cached prefix) | ~3,000–5,000 input tokens | the contract system prompt (§3 PROMPT-CONTRACT) + `extraction.v1.schema.json`. **[verify]** |
| Per-label OCR text (volatile, uncached) | ~200–600 input tokens | a single label's OCR text. |
| Output: 16 fields × {value, confidence, evidence, validation_status, warnings} | ~600–1,200 output tokens | `evidence` substrings add output tokens (PROMPT-CONTRACT §5.3 trade-off). |

**Per-label LLM cost on the default `claude-haiku-4-5` ($1 in / $5 out), with prompt caching on the prefix:**

- Cached prefix read (~4,500 tokens at ~0.1× the $1 input rate): ~4,500 × $1/1M × 0.1 ≈ **$0.00045**
- Volatile input (~400 tokens at full $1 rate): ~400 × $1/1M ≈ **$0.0004**
- Output (~900 tokens at $5 rate): ~900 × $5/1M ≈ **$0.0045**
- **≈ $0.005 per label** on the LLM stage (output-dominated — the `evidence` arrays are the cost
  driver, accepted for provenance) — **~5× cheaper than the off-by-default Opus escalation tier**
  (a hard case escalated to `claude-opus-4-8` at $5/$25 costs ≈ $0.027/label). **First call** of a warm
  window also pays the prefix **write** (~1.25× the $1 rate on ~4,500 tokens ≈ **$0.0056 one-time**,
  amortized across the window).
- **OCR stage (Google Vision):** a per-image fee on top, governed by the OCR provider's pricing.
  **[must verify against the OCR provider's current price.]**

**Where the cost goes / the levers (cross-ref AI-PIPELINE §1, §9):**

| Lever | Effect | Trade-off |
|-------|--------|-----------|
| **OCR-quality gate skips garbage** | avoids the entire LLM call on unreadable/non-food images | the single biggest saver on a noisy capture stream; small false-skip risk, mitigated by biasing borderline → review (never silent drop). |
| **Prompt caching** | ~90% off the large stable prefix | only on exact prefix match; model-scoped. |
| **De-escalate clean slices to Sonnet/Haiku** | Sonnet $3/$15 (≈40% cheaper out), Haiku $1/$5 (≈80% cheaper) | only where the eval suite proves the deploy gate holds; re-run cross-model eval first. |
| **Batches API for re-extraction/backfill** | 50% off, async ≤24h | not for the live request path (≤24h latency); ideal for E25 additive re-extraction over historical raw. |
| **Lower `effort` on clean labels** | fewer thinking tokens | only where calibration/eval shows no quality loss. |
| **Single-pass vision** | one call, but more input (image) tokens **and** loses the gate saver | reserve for escalation/repair on a hard image; never the default. |

**Latency shape (cross-ref BACKEND §10.4 SLOs):**

- Extraction runs **off the request path** in the async worker (BACKEND §1.1) — the ingestion
  `POST /v1/ingestions` p95 < 1.5s SLO is unaffected by LLM latency.
- LLM call is the largest single latency in the worker (seconds, generation-bound). The freshness
  SLO is p95 submit→extraction-available < 60s (BACKEND §10.4) — comfortably above one Opus call
  plus OCR. A bounded ≤2 repair re-ask worst case is ~3× the LLM latency for that one label, still
  within budget. Escalation to Fable adds one more call; capped per run.
- Throughput scales **across** labels (worker concurrency, bulkheaded pools — BACKEND §9.3), never
  *within* one label's dependent chain (PIPELINE §1).

---

## 7. Cross-references

- Architecture & policy: [`AI-PIPELINE.md`](./AI-PIPELINE.md) (§1 inference architecture, §3 LLM
  port, §4 confidence, §7 metrics, §9 monitoring).
- Prompt/schema contract: [`../extraction/PROMPT-CONTRACT.md`](../extraction/PROMPT-CONTRACT.md),
  [`../extraction/schema/extraction.v1.schema.json`](../extraction/schema/extraction.v1.schema.json).
- Backend gate / retry / observability: [`../backend/BACKEND-ARCHITECTURE.md`](../backend/BACKEND-ARCHITECTURE.md)
  §8, §9, §10.
- Pipeline topology / evals: [`../pipeline/PIPELINE-ARCHITECTURE.md`](../pipeline/PIPELINE-ARCHITECTURE.md),
  [`../pipeline/eval-suite.md`](../pipeline/eval-suite.md).
