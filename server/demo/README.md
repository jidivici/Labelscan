# Demo labels and extraction truth

The nine catalogue examples are backed by real label photographs, but the
photographs are not permission to complete missing regulatory data.

`manifest.v2.json` is the versioned, photo-only truth set. Every active
Poissonnerie V2 field has exactly one record per image with:

- `raw_value` and `normalized_value`;
- a `printed_text` or `printed_barcode` source;
- a `present`, `absent`, or `ambiguous` status;
- exact evidence, unit, and precision metadata;
- `excluded_observations`: tempting but invalid mappings, such as treating a
  dispatch, production, or slaughter date as a packaging date.

The extraction truth remains `null` for absent and ambiguous values. The catalogue
renders those fields as `NC` so every field in the mandatory profile stays visible;
`NC` is a presentation value, never a fact extracted from the photo. The demo does
not calculate shelf life, invent GTINs, infer allergens from the species, or infer
product origin from a health mark.

## Image privacy

The checked-in JPEGs are losslessly transcoded with:

```sh
jpegtran -copy none -optimize -outfile sanitized.jpg source.jpg
```

This removes EXIF, device, timestamp, and GPS metadata while preserving the visible
label pixels. Before replacement, local originals are copied to
`.local-archive/demo-originals/`; that directory is ignored and must never be
committed or copied into a container image.

The manifest pins the SHA-256 digest of every sanitized image. Tests also reject
Exif, GPS, and Apple metadata markers.

## Updating a demo label

1. Inspect the label itself; do not copy an old catalogue row as truth.
2. Back up the source under the ignored local archive and strip all metadata.
3. Classify all 16 profile fields in the manifest.
4. Use `NC` in `scripts/seed_demo.py` for every absent or ambiguous field.
5. Update the sanitized SHA-256 digest.
6. Run:

```sh
pytest -q tests/test_demo_arrivals.py
```

Two independent reviewers should approve changes to visible values and evidence
before this set is used for extraction evaluation.

## Anthropic extraction contract

The detailed seafood prompt is
`seafood-label-extraction/v3.1.0`. Absent fields use `value: null`,
`confidence: 0`, `evidence: []`, and status `missing` or `ambiguous`.
Provider-native structured output guarantees the supported JSON shape; the adapter
then enforces local bounds and value/confidence/evidence/status invariants before
the domain evidence gate.

Only these model IDs are accepted:

| Model | Cache floor | Thinking | Maximum response budget |
|---|---:|---|---:|
| `claude-haiku-4-5` | 4096 tokens | none | 4096 |
| `claude-opus-4-8` | 1024 tokens | adaptive, high effort | 8192 |

An unknown model fails at startup. Prompt caching applies only to the detailed
Poissonnerie V2 static system block. It is requested by default with a `5m` TTL,
then enabled only if a runtime `count_tokens` probe clears the model floor with a
safety margin. A `1h` TTL additionally requires
`LABELSCAN_LLM_PROMPT_CACHE_1H_VERIFIED=1`. OCR text and GS1 hints stay in the
dynamic user message.

Run `scripts/measure_prompt_tokens.py` with provider credentials for every enabled
model before release. Runtime metrics contain only model/config identifiers,
hashes, stop reason, latency, estimated cost, and token counters—never OCR text,
prompts, images, or secrets.
The cache fingerprint covers model capabilities, trade/profile version, prompt
version, schema SHA-256, and TTL so configuration changes are observable.

Current provider references:

- <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>
- <https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking>
