"""OCR input selection prefers the sanitized derivative over the source image."""

from __future__ import annotations

from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.domain.extraction import RuleSet


class _Result:
    def __init__(self, row: dict) -> None:
        self._row = row

    def mappings(self):
        return self

    def one(self):
        return self._row


class _Connection:
    def __init__(self, row: dict) -> None:
        self.row = row
        self.statements: list[str] = []

    def execute(self, statement, _parameters=None):
        rendered = str(statement)
        self.statements.append(rendered)
        if "set_config" in rendered:
            return None
        return _Result(self.row)


class _Transaction:
    def __init__(self, connection: _Connection) -> None:
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, *_args):
        return False


class _Engine:
    def __init__(self, connection: _Connection) -> None:
        self.connection = connection

    def begin(self):
        return _Transaction(self.connection)


class _RawStore:
    def __init__(self) -> None:
        self.read_args = None

    def read(self, **kwargs):
        self.read_args = kwargs
        return b"sanitized-image"


def test_ocr_query_prefers_sanitized_derivative_and_returns_its_id() -> None:
    connection = _Connection(
        {
            "id": "sanitized-artifact-id",
            "checksum_sha256": "sanitized-sha256",
            "organization_id": "organization-id",
            "barcode_raw": "barcode",
            "trade_code_snapshot": "poissonnerie",
            "trade_profile_version": "2",
        }
    )
    raw_store = _RawStore()
    consumer = ExtractionConsumer(
        engine=_Engine(connection),
        raw_store=raw_store,
        ocr=None,
        llm=None,
        rule_set=RuleSet(version="test", required_fields=frozenset()),
    )

    image, artifact_id, barcode, organization_id, profile = (
        consumer._load_image_meta("ingestion-id", "organization-id")
    )

    selection_sql = next(
        statement for statement in connection.statements if "raw_artifact" in statement
    )
    assert "IN ('sanitized_image', 'image')" in selection_sql
    assert "WHEN 'sanitized_image' THEN 0" in selection_sql
    assert image == b"sanitized-image"
    assert artifact_id == "sanitized-artifact-id"
    assert raw_store.read_args == {
        "checksum": "sanitized-sha256",
        "organization_id": "organization-id",
    }
    assert barcode == "barcode"
    assert organization_id == "organization-id"
    assert (profile.code, profile.version) == ("poissonnerie", "2")
