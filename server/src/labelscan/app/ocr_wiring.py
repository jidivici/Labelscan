"""Config-driven OCR provider selection (app-layer composition).

There is NO default provider. Production must opt in explicitly:

    LABELSCAN_OCR_PROVIDER=google
    LABELSCAN_GOOGLE_VISION_API_KEY=<server-side key>   # never EXPO_PUBLIC_*

An unconfigured process raises a clear error rather than silently making a
network call, so dev/test default behavior is safe. Unit tests inject a fake
OCR provider directly (tests/_fakes.FakeOcr) and never call this builder, so no
real Google Vision call is ever made under test.

The production worker composition obtains its provider here, e.g.:

    register_extraction_consumer(worker, ocr_provider=build_ocr_provider(), raw_store=...)
"""

from __future__ import annotations

import os

from labelscan.contexts.ingestion.application.extraction_ports import OcrProvider


def build_ocr_provider() -> OcrProvider:
    provider = (os.environ.get("LABELSCAN_OCR_PROVIDER") or "").strip().lower()
    if provider == "google":
        api_key = os.environ.get("LABELSCAN_GOOGLE_VISION_API_KEY")
        if not api_key:
            raise RuntimeError(
                "LABELSCAN_OCR_PROVIDER=google requires LABELSCAN_GOOGLE_VISION_API_KEY "
                "(server-side only; never EXPO_PUBLIC_*)."
            )
        # Imported lazily so this module loads without the adapter's HTTP client.
        from labelscan.contexts.ingestion.adapters.google_vision_ocr import (
            _FEATURE,
            GoogleVisionOcr,
        )

        # Optional cost/latency lever (backlog P1): TEXT_DETECTION is cheaper and
        # often faster, but the recall trade-off MUST be measured before adoption —
        # the default stays the dense-text model. Invalid values fail loudly at
        # startup (adapter validates), never silently fall back.
        feature = (
            os.environ.get("LABELSCAN_OCR_FEATURE") or _FEATURE
        ).strip().upper()
        return GoogleVisionOcr(api_key=api_key, feature=feature)

    raise RuntimeError(
        "OCR provider not configured. Set LABELSCAN_OCR_PROVIDER=google "
        "(+ LABELSCAN_GOOGLE_VISION_API_KEY) in production; tests inject a fake OCR."
    )
