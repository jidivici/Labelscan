"""Composition root + entrypoint for the outbox relay worker (app layer).

Wires all consumers onto the outbox relay:
  ingestion.raw_stored   -> ExtractionConsumer (OCR -> LLM -> domain gate -> persist)
  review.finalized       -> RegistrationConsumer (traceability catalogue publication)
  batch.registered/flagged -> AlertingConsumer (HACCP)

The app layer is the only place producers, the relay, and consumers are wired
together — the relay (platform) imports no context, and no context imports the relay.
"""

from __future__ import annotations

import os
import sys
import time

from labelscan.app.domain_wiring import register_domain_consumers
from labelscan.app.extraction_wiring import register_extraction_consumer
from labelscan.app.ocr_wiring import build_ocr_provider
from labelscan.platform.config import validate_runtime_configuration
from labelscan.platform.db.engine import make_engine
from labelscan.platform.observability import configure_logging
from labelscan.platform.outbox.worker import OutboxWorker
from labelscan.platform.storage_factory import build_raw_store


def build_outbox_worker() -> OutboxWorker:
    configure_logging()
    validate_runtime_configuration("worker")
    worker = OutboxWorker(make_engine())

    raw_store = build_raw_store()

    register_extraction_consumer(
        worker, ocr_provider=build_ocr_provider(), raw_store=raw_store
    )
    register_domain_consumers(worker)

    return worker


# ── Liveness heartbeat ───────────────────────────────────────────────────────
# The worker has no HTTP surface, so liveness is a heartbeat file the poll loop
# refreshes each iteration; the Docker healthcheck (`--health`) checks its freshness.
# This makes a dead/wedged worker VISIBLE (`unhealthy`) instead of silently leaving
# ingestions stuck in `raw_stored`. Staleness allowance is kept above the LLM
# per-request timeout (120 s) so a single slow extraction never flaps the check.
_HEARTBEAT_PATH = os.environ.get(
    "LABELSCAN_WORKER_HEARTBEAT", "/tmp/labelscan_worker.heartbeat"
)  # noqa: S108
_HEARTBEAT_MAX_AGE_S = float(
    os.environ.get("LABELSCAN_WORKER_HEARTBEAT_MAX_AGE", "180")
)


def _beat(path: str = _HEARTBEAT_PATH) -> None:
    """Record 'the poll loop is alive' — best-effort, never crashes the worker."""
    try:
        with open(path, "w") as fh:
            fh.write(str(time.time()))
    except OSError:
        pass


def worker_is_healthy(
    path: str = _HEARTBEAT_PATH, max_age_s: float = _HEARTBEAT_MAX_AGE_S
) -> bool:
    """True iff the heartbeat file exists and was refreshed within `max_age_s`."""
    try:
        return (time.time() - os.path.getmtime(path)) < max_age_s
    except OSError:
        return False  # missing file → never started, or wiped → unhealthy


def poll_forever(
    worker: OutboxWorker, *, interval_seconds: float = 1.0, batch: int = 100
) -> None:
    _beat()  # mark alive immediately at boot (before the first claim)
    while True:
        _beat()  # one heartbeat per poll iteration
        if worker.run_once(max_messages=batch) == 0:
            time.sleep(interval_seconds)


if __name__ == "__main__":  # pragma: no cover
    if "--health" in sys.argv:
        # Docker HEALTHCHECK entrypoint: exit 0 = healthy, 1 = stale/dead.
        raise SystemExit(0 if worker_is_healthy() else 1)
    poll_forever(build_outbox_worker())
