"""Batch 3 — OCR config boundary + Google Vision adapter (no network calls).

Verifies selection is config-driven, the default is safe (no provider, no
network), construction/import perform no I/O, and the response parser is correct.
The worker tests continue to inject tests/_fakes.FakeOcr, so no real Vision call
is ever made under test.
"""

from __future__ import annotations

import pytest

from labelscan.app.ocr_wiring import build_ocr_provider
from labelscan.contexts.ingestion.adapters.google_vision_ocr import (
    _FEATURE,
    _LANGUAGE_HINTS,
    GoogleVisionOcr,
    _parse_annotate_response,
)


def test_default_unconfigured_raises_no_network(monkeypatch):
    monkeypatch.delenv("LABELSCAN_OCR_PROVIDER", raising=False)
    monkeypatch.delenv("LABELSCAN_GOOGLE_VISION_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        build_ocr_provider()


def test_google_provider_without_key_raises(monkeypatch):
    monkeypatch.setenv("LABELSCAN_OCR_PROVIDER", "google")
    monkeypatch.delenv("LABELSCAN_GOOGLE_VISION_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        build_ocr_provider()


def test_google_provider_with_key_builds_adapter_without_network(monkeypatch):
    monkeypatch.setenv("LABELSCAN_OCR_PROVIDER", "google")
    monkeypatch.setenv("LABELSCAN_GOOGLE_VISION_API_KEY", "test-key-not-used")
    provider = build_ocr_provider()
    assert isinstance(provider, GoogleVisionOcr)
    assert provider.name == "google-vision"


def test_adapter_module_imports_httpx_lazily():
    import labelscan.contexts.ingestion.adapters.google_vision_ocr as m

    # httpx is imported inside run(), never at module load — so it is not bound
    # in the module namespace and importing the package needs no HTTP client.
    assert not hasattr(m, "httpx")


def test_construction_requires_key_and_does_no_io():
    assert GoogleVisionOcr(api_key="x").name == "google-vision"
    with pytest.raises(ValueError):
        GoogleVisionOcr(api_key="")


def test_parse_extracts_text_and_mean_confidence():
    data = {
        "responses": [
            {
                "fullTextAnnotation": {
                    "text": "Atlantic Cod\nGadus morhua",
                    "pages": [{"confidence": 0.9}, {"confidence": 0.8}],
                }
            }
        ]
    }
    text, confidence = _parse_annotate_response(data)
    assert text == "Atlantic Cod\nGadus morhua"
    assert confidence == pytest.approx(0.85)


def test_parse_missing_text_and_confidence_fails_closed():
    text, confidence = _parse_annotate_response({"responses": [{}]})
    assert text == ""
    assert confidence == 0.0  # no confidence -> 0.0 so the validation gate fails closed


def test_parse_falls_back_to_text_annotations():
    data = {"responses": [{"textAnnotations": [{"description": "Lot L24-0917"}]}]}
    text, confidence = _parse_annotate_response(data)
    assert text == "Lot L24-0917"
    assert confidence == 0.0


def test_parse_provider_error_raises():
    data = {"responses": [{"error": {"message": "API key not valid"}}]}
    with pytest.raises(RuntimeError):
        _parse_annotate_response(data)


class _CapturingResponse:
    status_code = 200
    # A minimal valid annotate response so run() parses without error.
    content = (
        b'{"responses":[{"fullTextAnnotation":'
        b'{"text":"Cabillaud","pages":[{"confidence":0.9}]}}]}'
    )


def test_run_request_sends_language_hints_and_full_image(monkeypatch):
    """Task D: the request carries DOCUMENT_TEXT_DETECTION + fr/en language hints,
    and the image is sent verbatim (no resize/quality param that would downsample).
    The API key never appears in the payload (it rides in the query params only)."""
    captured: dict = {}

    def fake_post(url, *, params, json, timeout):
        captured["params"] = params
        captured["json"] = json
        return _CapturingResponse()

    import httpx

    monkeypatch.setattr(httpx, "post", fake_post)

    GoogleVisionOcr(api_key="secret-key").run(b"\x89PNG fake-bytes")

    req = captured["json"]["requests"][0]
    assert req["features"] == [{"type": _FEATURE}]
    assert _FEATURE == "DOCUMENT_TEXT_DETECTION"
    assert req["imageContext"]["languageHints"] == _LANGUAGE_HINTS
    assert _LANGUAGE_HINTS == ["fr", "en"]
    # Image is base64 of the raw bytes — no width/height/quality knob present.
    assert set(req["image"].keys()) == {"content"}
    # Sanitized boundary: the key is only in query params, never in the body.
    assert captured["params"] == {"key": "secret-key"}
    assert "secret-key" not in str(req)
