"""HTTP request/response schemas for ingestion (adapter; Pydantic allowed here)."""

from __future__ import annotations

from pydantic import BaseModel, Field

# The request is multipart/form-data:
#   image:               the label image file (required)
#   barcode_raw:         optional form field
#   client_captured_at:  optional form field (ISO 8601)
# Headers: Idempotency-Key (required), X-Correlation-Id (optional),
#          X-Actor-Id / X-Principal / X-Scopes (identity seam, BACKEND §6).


class IngestionAcceptedResponse(BaseModel):
    ingestion_id: str = Field(
        ..., description="Server id of the durably-stored ingestion"
    )
    status: str = Field(..., description="Always 'raw_stored' on accept")
    replayed: bool = Field(..., description="True when this was an idempotent replay")
    correlation_id: str
