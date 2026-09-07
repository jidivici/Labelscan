"""HTTP contract for re-running analysis against the existing source photo."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.http.router import get_retry_extraction
from labelscan.contexts.ingestion.application.ports import RetriedExtraction
from labelscan.contexts.ingestion.application.retry_extraction import (
    ExtractionRetryNotAllowed,
)
from tests.conftest import ACTOR_ID, bearer


class _Retry:
    def __init__(self, *, failure_status: str | None = None) -> None:
        self.failure_status = failure_status
        self.command = None

    def __call__(self, command):
        self.command = command
        if self.failure_status:
            raise ExtractionRetryNotAllowed(self.failure_status)
        return RetriedExtraction(command.ingestion_id, "raw_stored", False)


def _client(retry: _Retry) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_retry_extraction] = lambda: retry
    return TestClient(app)


def _headers(organization_id: str) -> dict[str, str]:
    return bearer(
        "ingestion:write",
        actor_id=ACTOR_ID,
        role="super_admin",
        organization_id=organization_id,
    )


def test_retry_queues_analysis_without_uploading_another_photo():
    ingestion_id = str(uuid.uuid4())
    organization_id = str(uuid.uuid4())
    retry = _Retry()

    response = _client(retry).post(
        f"/v1/ingestions/{ingestion_id}/retry",
        headers=_headers(organization_id),
    )

    assert response.status_code == 202
    assert response.json() == {
        "ingestion_id": ingestion_id,
        "status": "raw_stored",
        "replayed": False,
    }
    assert retry.command.ingestion_id == ingestion_id
    assert retry.command.organization_id == organization_id
    assert retry.command.actor_id == ACTOR_ID


def test_retry_rejects_a_review_ready_ingestion():
    response = _client(_Retry(failure_status="extracted")).post(
        f"/v1/ingestions/{uuid.uuid4()}/retry",
        headers=_headers(str(uuid.uuid4())),
    )

    assert response.status_code == 409
    assert response.json()["error_code"] == "INGESTION_NOT_RETRYABLE"
