"""Composition root for the traceability + HACCP consumers.

Registers the event-driven chain onto the relay worker:
    extraction.completed -> traceability (RegistrationConsumer)
    batch.registered / batch.flagged -> haccp (AlertingConsumer)
Each consumer imports only its own context; integration is via events.
"""

from __future__ import annotations

from datetime import date

from labelscan.contexts.haccp.adapters.alerting_consumer import AlertingConsumer
from labelscan.contexts.traceability.adapters.registration_consumer import (
    RegistrationConsumer,
)
from labelscan.platform.db.engine import make_engine
from labelscan.platform.outbox.worker import OutboxWorker


def register_domain_consumers(
    worker: OutboxWorker, *, engine=None, today=date.today
) -> None:
    engine = engine or make_engine()

    registration = RegistrationConsumer(engine=engine)
    worker.register(registration.event_type, registration.consumer_name, registration)

    alerting = AlertingConsumer(engine=engine, today=today)
    for event_type in alerting.event_types:
        worker.register(event_type, alerting.consumer_name, alerting)
