# Models and cost control

This note explains the provider choices implemented in the current code and how to
estimate their cost while keeping the runtime's allow-listed price registry auditable. It is a
companion to [`AI-PIPELINE.md`](./AI-PIPELINE.md).

Provider prices, model availability, regional terms, and caching rules can change.
Always check the official [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[Anthropic prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
and [Google Cloud Vision pricing](https://cloud.google.com/vision/pricing) pages
before approving a budget or changing production configuration.

## What the application uses

The worker has two separate provider adapters:

- Google Cloud Vision REST for OCR. Production must explicitly set
  `LABELSCAN_OCR_PROVIDER=google`; there is no silent provider fallback.
- Anthropic Claude for structured extraction. The code default is
  `claude-haiku-4-5`, overridable with `LABELSCAN_LLM_MODEL`.

The OCR adapter defaults to `DOCUMENT_TEXT_DETECTION`. Operators may select
`TEXT_DETECTION` with `LABELSCAN_OCR_FEATURE`, but the quality and cost trade-off
must be measured on representative labels before rollout.

The primary LLM request has a 120-second timeout and a 4,096-token output limit.
The current adapter sends adaptive thinking and high effort only when its simple
model feature check considers the selected model compatible. Haiku requests omit
those options.

### Optional escalation

Escalation is disabled by default. When
`LABELSCAN_LLM_ESCALATION_ENABLED=true`, a second extractor uses
`LABELSCAN_LLM_ESCALATION_MODEL`; the code default is `claude-opus-4-8`.

The second call is considered only when a required free-text field is missing or
weak after the primary gate. It runs at most once, uses the same output contract,
and passes through the same evidence gate. Barcode-owned fields are not repaired
by escalation. If the second provider call fails, the primary review decision is
kept.

These identifiers describe the current code defaults, not a claim that a model is
the newest or best option. Confirm availability in the target Anthropic account
before deployment.

## Prompt caching

Prompt caching is enabled by default only for the detailed Poissonnerie V2
system prompt. The static system block is the cached prefix; OCR text and barcode
hints remain outside it. Historical and compact profiles remain uncached.

| Variable | Code default | Purpose |
|---|---|---|
| `LABELSCAN_LLM_PROMPT_CACHE_ENABLED` | enabled | Add the cache breakpoint |
| `LABELSCAN_LLM_PROMPT_CACHE_TTL` | `5m` | Request the cache lifetime; `1h` is opt-in |
| `LABELSCAN_LLM_PROMPT_CACHE_1H_VERIFIED` | disabled | Acknowledge a measured one-hour reuse window |

Compact prompts for Boucherie and Charcuterie/Traiteur are not given a cache
breakpoint.

The worker logs allow-listed input/output/cache token counters, TTL, model,
versions, hashes, stop reason, latency and an estimated USD cost. It never logs
OCR, prompt text, images or provider bodies. Cache eligibility is checked at
runtime with `count_tokens` against the explicit model floor plus a safety margin;
optional provider-backed tooling repeats the proof before release.

## Build a current cost estimate

Use real usage measurements and the prices that apply to the deployment account.
For one accounting period, collect:

- the number of images sent to each OCR feature;
- uncached LLM input tokens;
- cache-write input tokens, separated by requested TTL where pricing differs;
- cache-read input tokens;
- output tokens;
- the same token categories for escalation calls;
- retries, failed calls, free tiers, committed-use discounts, taxes, and regional
  adjustments that apply to the account.

A provider-neutral estimate is:

```text
OCR cost
  = billable OCR units × applicable OCR unit rate

Primary LLM cost
  = uncached input tokens × input rate
  + cache-write tokens × cache-write rate
  + cache-read tokens × cache-read rate
  + output tokens × output rate

Escalation cost
  = the same token calculation for the escalation model

Estimated total
  = OCR cost + primary LLM cost + escalation cost
```

Do not derive a financial forecast from the current application logs alone. Use
the provider billing export or usage API as the accounting source, then reconcile
it with LabelScan request and cache counters. Preserve the model, prompt version,
OCR feature, trade profile, and outcome as analysis dimensions; otherwise a
cheaper configuration can appear better simply because it handled easier labels.

## Cost and quality levers already implemented

| Lever | Current behavior | Trade-off to measure |
|---|---|---|
| Native GS1 parsing | Resolves supported barcode fields before the LLM | Printed/barcode conflicts still need review |
| OCR quality gate | Skips the LLM for clearly unusable OCR | False skips increase recapture and review work |
| Prompt caching | Reuses the stable Poissonnerie system prefix | Cache misses and cold writes still cost tokens |
| Configurable OCR feature | Allows dense-document or text detection | Recall, latency, and billing may differ |
| Optional LLM escalation | Gives weak required free-text fields one stronger attempt | Adds latency and provider spend |
| Human review | Prevents machine output from becoming a published arrival | Adds operational workload |

The code does not implement a provider Batch API, a single-pass vision-model path,
automatic model routing by label complexity, a per-request cost ceiling, or a
currency budget breaker. Those ideas should be described as future work until
they exist.

## Safe change process

For a model, OCR feature, prompt, cache, or threshold change:

1. Freeze the candidate configuration and record its exact identifiers.
2. Evaluate it on a representative, human-verified dataset for every supported
   trade profile.
3. Compare field quality, review rate, provider failures, latency, and measured
   billable usage with the current configuration.
4. Keep the existing evidence gate and complete-review publication rule.
5. Roll out gradually, monitor the provider billing source, and retain an easy
   configuration rollback.

The repository does not yet contain the production-grade labelled dataset or
mandatory live-provider release gate needed to make that process automatic. See
[`../pipeline/eval-suite.md`](../pipeline/eval-suite.md) for the current test
coverage and the missing release-evaluation layer.
