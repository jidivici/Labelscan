"""Updates the current catalogue view when a human review is finalized."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Connection


class ReviewProjectionConsumer:
    consumer_name = "traceability.review_projection"
    event_type = "review.finalized"

    def __call__(self, msg, conn: Connection) -> None:
        payload = msg.payload
        conn.execute(
            text(
                """
                UPDATE traceability.arrival_projection AS projection
                SET extraction_run_id = :run_id,
                    fields = COALESCE((
                        SELECT jsonb_object_agg(field.field_name, field.value)
                        FROM ingestion.extracted_field AS field
                        WHERE field.extraction_run_id = :run_id
                    ), '{}'::jsonb),
                    revision_no = projection.revision_no + 1,
                    updated_at = clock_timestamp()
                WHERE projection.ingestion_id = :ingestion_id
                  AND projection.organization_id = :organization_id
                """
            ),
            {
                "run_id": payload["run_id"],
                "ingestion_id": payload["ingestion_id"],
                "organization_id": payload["organization_id"],
            },
        )
