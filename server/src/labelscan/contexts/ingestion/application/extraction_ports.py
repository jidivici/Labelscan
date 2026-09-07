"""Provider ports for extraction (application layer).

Framework-free: the OCR and LLM providers are abstractions here; the concrete
SDK adapters (Google Vision, Claude, …) live in the adapters layer. The domain
gate never sees these — it only sees the resulting LlmField values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from labelscan.contexts.ingestion.domain.extraction import LlmField


class PermanentProviderError(RuntimeError):
    """A provider/configuration failure that cannot succeed with the same input.

    The worker records one failed extraction attempt but must not spend the normal
    transient retry budget on rejected parameters, authentication, schema, or refusal.
    """


class RetryableProviderOutputError(RuntimeError):
    """A completed model call whose generated output failed the local contract.

    Unlike an HTTP 4xx or invalid request configuration, a fresh generation with the
    same input can recover.  The consumer therefore retries this category once before
    surfacing a terminal provider failure to the operator.
    """


@dataclass(frozen=True)
class OcrResult:
    raw_json: bytes  # the verbatim provider response (stored immutably)
    full_text: str
    mean_confidence: float
    page: int = 1


@dataclass(frozen=True)
class LlmResult:
    raw_json: bytes  # the verbatim model response (stored immutably)
    fields: tuple[LlmField, ...]
    extractor_version: str
    model: str
    prompt_version: str


class OcrProvider(Protocol):
    """Runs OCR on image bytes. Implementations may call an external service; the
    caller is responsible for dedup/idempotency (see the consumer's raw-store guard)."""

    def run(self, image_bytes: bytes) -> OcrResult: ...

    @property
    def name(self) -> str: ...


class LlmExtractor(Protocol):
    """Turns OCR text into structured fields. Schema-conformance is the adapter's
    job; truth (no fabrication) is the domain gate's job.

    `known_field_names` are fields already resolved deterministically (GS1 or exact
    OCR rules) — a hint so the adapter can focus the prompt and omit them. It is
    advisory only: correctness never depends on it (deterministic reconciliation
    still wins)."""

    def run(
        self,
        ocr_text: str,
        known_field_names: tuple[str, ...] = (),
        *,
        trade_code: str = "poissonnerie",
        trade_profile_version: str = "2",
    ) -> LlmResult: ...

    @property
    def model(self) -> str: ...
