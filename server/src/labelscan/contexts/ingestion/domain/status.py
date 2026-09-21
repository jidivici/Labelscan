"""Ingestion status — a pure value (no behaviour, no dependencies).

Lives in the domain layer; imports nothing (enforced by G-ARCH domain-purity).
Mirrors the authoritative 12-state machine (SYNTHESIS §4.3 / schema.sql CHECK).
"""

from __future__ import annotations

from enum import StrEnum


class IngestionStatus(StrEnum):
    RAW_STORED = "raw_stored"
    OCR_RUNNING = "ocr_running"
    OCR_DONE = "ocr_done"
    OCR_FAILED = "ocr_failed"
    OCR_SKIPPED_GARBAGE = "ocr_skipped_garbage"
    EXTRACTION_RUNNING = "extraction_running"
    EXTRACTED = "extracted"
    EXTRACTION_FAILED = "extraction_failed"
    NEEDS_REVIEW = "needs_review"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    HALTED_MISSING_CONTEXT = "halted_missing_context"
