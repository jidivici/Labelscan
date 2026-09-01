"""Google Cloud Vision OCR adapter — implements the OcrProvider port.

Server-side only: the API key is read from the SERVER environment by the app-layer
composition (see app/ocr_wiring.py) and passed in here. It carries no
EXPO_PUBLIC_* prefix, so it is never bundled into the mobile client.

This module does no network I/O at import or construction — httpx is imported
lazily inside run() (same discipline as the Claude adapter), so importing the
package never requires the HTTP client to be installed.

Failure handling: a bounded request timeout; transport/HTTP failures raise a
SANITIZED RuntimeError (never the API key or the request URL, which carries the
key as a query param) that the extraction consumer treats as a retryable provider
error. No secrets are logged.
"""

from __future__ import annotations

import base64
import json

from labelscan.contexts.ingestion.application.extraction_ports import OcrResult
from labelscan.platform.external_api import external_api_monitor

_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
# DOCUMENT_TEXT_DETECTION is the safe default (dense-text model, best recall on
# busy labels). TEXT_DETECTION is ~cheaper/faster but MUST NOT become the default
# without an eval pass (SC1/SC3/SC10) — it is exposed as config so a prod A/B can
# measure the recall trade-off without a code change (backlog P1).
_FEATURE = "DOCUMENT_TEXT_DETECTION"
_ALLOWED_FEATURES = frozenset({"DOCUMENT_TEXT_DETECTION", "TEXT_DETECTION"})
_REQUEST_TIMEOUT_S = 30.0
# French fishmonger labels are predominantly fr, with some en (species/commercial
# terms, supplier names). Vision auto-detects language, but an explicit hint
# improves recall on mixed/accented fr+en text (Cabillaud, décongelé, pêche) where
# auto-detection can mis-segment — strictly a recall aid, never a content change.
# Order is a priority hint, not a restriction; other scripts are still detected.
_LANGUAGE_HINTS = ["fr", "en"]


class GoogleVisionOcr:
    """OcrProvider backed by Google Cloud Vision REST (images:annotate)."""

    def __init__(
        self,
        *,
        api_key: str,
        endpoint: str = _ENDPOINT,
        timeout_s: float = _REQUEST_TIMEOUT_S,
        feature: str = _FEATURE,
    ) -> None:
        if not api_key:
            raise ValueError("GoogleVisionOcr requires a non-empty api_key")
        if feature not in _ALLOWED_FEATURES:
            raise ValueError(
                f"GoogleVisionOcr feature must be one of {sorted(_ALLOWED_FEATURES)}"
            )
        self._api_key = api_key
        self._endpoint = endpoint
        self._timeout_s = timeout_s
        self._feature = feature
        # Shared HTTP client, created lazily on the FIRST run() (construction stays
        # I/O-free). Reusing one client keeps the TCP+TLS connection alive across
        # calls — the per-call handshake was ~600 ms on the measured egress
        # (docs/LATENCY-REVIEW.md Tier 7 "reste"). The worker holds one adapter
        # instance for its whole life, so the pool lives as long as the process.
        self._client = None

    @property
    def name(self) -> str:
        return "google-vision"

    def _http_client(self):
        import httpx  # lazy: importing this module never requires httpx

        if self._client is None:
            self._client = httpx.Client(timeout=self._timeout_s)
        return self._client

    def run(self, image_bytes: bytes) -> OcrResult:
        import httpx  # lazy: importing this module never requires httpx

        payload = {
            "requests": [
                {
                    # Image is sent verbatim (raw bytes, base64). No resize/crop/
                    # quality param here, so the server never downsamples — the OCR
                    # sees the full-resolution capture the client uploaded.
                    "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                    "features": [{"type": self._feature}],
                    "imageContext": {"languageHints": _LANGUAGE_HINTS},
                }
            ]
        }
        try:
            with external_api_monitor.call("google_vision"):
                resp = self._http_client().post(
                    self._endpoint,
                    params={
                        "key": self._api_key
                    },  # key lives only in the request, never logged
                    json=payload,
                )
                if resp.status_code != 200:
                    # Status only — never the key or response body.
                    raise RuntimeError(
                        f"google-vision returned HTTP {resp.status_code}"
                    )
        except httpx.HTTPError as exc:
            # Sanitized: the exception text could otherwise echo the URL (which
            # carries ?key=...). Surface only the failure class.
            raise RuntimeError(
                f"google-vision request failed: {type(exc).__name__}"
            ) from None
        raw = resp.content
        full_text, mean_confidence = _parse_annotate_response(json.loads(raw))
        return OcrResult(
            raw_json=raw, full_text=full_text, mean_confidence=mean_confidence, page=1
        )


def _parse_annotate_response(data: dict) -> tuple[str, float]:
    """Extract (full_text, mean_confidence) from a Vision images:annotate response.

    Vision reports confidence per page in fullTextAnnotation; when absent we
    return 0.0 so the downstream validation gate fails closed rather than trusting
    an unscored read (never fabricate a confidence). A per-request `error` block is
    raised as a provider failure.
    """
    responses = data.get("responses") or []
    first = responses[0] if responses else {}

    error = first.get("error")
    if error:
        raise RuntimeError(
            f"google-vision annotate error: {error.get('message', 'unknown')}"
        )

    fta = first.get("fullTextAnnotation") or {}
    full_text = fta.get("text") or ""
    if not full_text:
        annotations = first.get("textAnnotations") or []
        if annotations:
            full_text = annotations[0].get("description", "") or ""

    pages = fta.get("pages") or []
    confidences = [
        p.get("confidence")
        for p in pages
        if isinstance(p.get("confidence"), (int, float))
    ]
    mean_confidence = float(sum(confidences) / len(confidences)) if confidences else 0.0

    return full_text, mean_confidence
