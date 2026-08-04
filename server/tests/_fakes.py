"""Deterministic test doubles for the OCR/LLM provider ports (no network/spend)."""

from __future__ import annotations

import json

from labelscan.contexts.ingestion.application.extraction_ports import (
    LlmResult,
    OcrResult,
)
from labelscan.contexts.ingestion.domain.extraction import LlmField

# A fixed seafood-label OCR text the "good" evidence substrings are grounded in.
OCR_TEXT = (
    "Atlantic Cod (Gadus morhua) Supplier Nordic Seafood AS Wild caught FAO area 27 "
    "Use by 2026-06-20 Packed on 2026-06-10 Keep below 4C Lot L24-0917 Net weight 320 g"
)


class FakeOcr:
    def __init__(self, full_text: str = OCR_TEXT, confidence: float = 0.95) -> None:
        self._text = full_text
        self._conf = confidence
        self.calls = 0

    def run(self, image_bytes: bytes) -> OcrResult:
        self.calls += 1
        raw = json.dumps(
            {"full_text": self._text, "mean_confidence": self._conf, "page": 1}
        ).encode()
        return OcrResult(
            raw_json=raw, full_text=self._text, mean_confidence=self._conf, page=1
        )

    @property
    def name(self) -> str:
        return "fake-ocr"


class FakeLlm:
    def __init__(
        self, fields: tuple[LlmField, ...], *, model: str = "fake-llm"
    ) -> None:
        self._fields = tuple(fields)
        self._model = model
        self.calls = 0
        self.last_trade_code: str | None = None
        self.last_trade_profile_version: str | None = None

    def run(
        self,
        ocr_text: str,
        known_field_names: tuple[str, ...] = (),
        *,
        trade_code: str = "poissonnerie",
        trade_profile_version: str = "1",
    ) -> LlmResult:
        self.last_trade_code = trade_code
        self.last_trade_profile_version = trade_profile_version
        self.calls += 1
        raw = json.dumps({"fields": [f.name for f in self._fields]}).encode()
        return LlmResult(
            raw_json=raw,
            fields=self._fields,
            extractor_version="fake/v1",
            model=self._model,
            prompt_version="v1",
        )

    @property
    def model(self) -> str:
        return self._model


def field(name, value, conf=0.95, evidence=None, status="present", warnings=()):
    return LlmField(
        name=name,
        value=value,
        llm_confidence=conf,
        evidence=tuple(evidence or ()),
        validation_status=status,
        warnings=tuple(warnings),
    )


def good_fields() -> tuple[LlmField, ...]:
    # all required fields present, evidence grounded in OCR_TEXT, high confidence
    return (
        field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
        field("expiry_date", "2026-06-20", 0.95, ["2026-06-20"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
    )


def traceable_fields(
    *,
    lot="L24-0917",
    supplier="Nordic Seafood AS",
    use_by="2026-06-20",
    packaging="2026-06-10",
) -> tuple[LlmField, ...]:
    # a richer "extracted" set for building a batch (all evidence must be grounded
    # in the OCR text passed to FakeOcr in the same test).
    return (
        field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
        field("product_name", "Atlantic Cod", 0.95, ["Atlantic Cod"]),
        field("commercial_designation", "Atlantic Cod", 0.95, ["Atlantic Cod"]),
        field("batch_number", lot, 0.95, [lot]),
        field("supplier_name", supplier, 0.95, [supplier]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
        field("FAO_area", "27", 0.90, ["27"]),
        field("expiry_date", use_by, 0.95, [use_by]),
        field("packaging_date", packaging, 0.95, [packaging]),
    )


class RaisingLlm:
    """An LLM provider that always fails — to exercise the retry-limit -> FAILED run."""

    def __init__(self) -> None:
        self.calls = 0

    def run(
        self,
        ocr_text: str,
        known_field_names: tuple[str, ...] = (),
        *,
        trade_code: str = "poissonnerie",
        trade_profile_version: str = "1",
    ):
        del trade_code, trade_profile_version
        self.calls += 1
        raise RuntimeError("LLM provider unavailable")

    @property
    def model(self) -> str:
        return "fake-llm-broken"
