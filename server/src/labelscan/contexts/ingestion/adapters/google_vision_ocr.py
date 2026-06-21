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

_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
_FEATURE = "DOCUMENT_TEXT_DETECTION"
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
    ) -> None:
        if not api_key:
            raise ValueError("GoogleVisionOcr requires a non-empty api_key")
        self._api_key = api_key
        self._endpoint = endpoint
        self._timeout_s = timeout_s

    @property
    def name(self) -> str:
        return "google-vision"

    def run(self, image_bytes: bytes) -> OcrResult:
        import httpx  # lazy: importing this module never requires httpx

        payload = {
            "requests": [
                {
                    # Image is sent verbatim (raw bytes, base64). No resize/crop/
                    # quality param here, so the server never downsamples — the OCR
                    # sees the full-resolution capture the client uploaded.
                    "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                    "features": [{"type": _FEATURE}],
                    "imageContext": {"languageHints": _LANGUAGE_HINTS},
                }
            ]
        }
        try:
            resp = httpx.post(
                self._endpoint,
                params={
                    "key": self._api_key
                },  # key lives only in the request, never logged
                json=payload,
                timeout=self._timeout_s,
            )
        except httpx.HTTPError as exc:
            # Sanitized: the exception text could otherwise echo the URL (which
            # carries ?key=...). Surface only the failure class.
            raise RuntimeError(
                f"google-vision request failed: {type(exc).__name__}"
            ) from None
        if resp.status_code != 200:
            # Status only — never the key or response body.
            raise RuntimeError(f"google-vision returned HTTP {resp.status_code}")

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
