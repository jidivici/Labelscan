"""Exercise the operator's log view with mixed, hostile and stale records."""

import importlib.util
import json
from pathlib import Path

_script = Path(__file__).resolve().parents[2] / "scripts/security-watch.py"
_spec = importlib.util.spec_from_file_location("security_watch", _script)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
SecurityWindow = _module.SecurityWindow


def test_detection_and_expiry_without_exposing_payloads():
    window = SecurityWindow()
    for _ in range(5):
        window.ingest(json.dumps({"ts": 1000, "event_type": "auth_login_failed", "client_ip": "198.51.100.5", "password": "secret", "path": "/token/secret"}), 1000)
    window.ingest('{"ts": 1000, "logger": "http.log.access.log0", "request":{"client_ip":"198.51.100.5"},"status":413}', 1000)
    result = window.snapshot(1000)
    assert result["alerts"] == [{"signal": "auth_login_failed", "ip": "198.51.100.5", "status": 401, "count": 5}]
    assert result["events"]["edge_request"] == 1
    assert result["active_ips"] == ["198.51.100.5"]
    assert "secret" not in json.dumps(result)
    assert not window.snapshot(1061)["alerts"]


def test_malformed_stale_and_future_records_are_ignored():
    window = SecurityWindow()
    for line in ('bad json', '[]', 'null', '{"ts":"bad","event_type":"auth_login_failed"}', '{"ts":2,"event_type":"auth_login_failed"}', '{"ts":9000,"event_type":"auth_login_failed"}'):
        window.ingest(line, 1000)
    assert not window.snapshot(1000)["events"]


def test_out_of_order_entries_expire_and_overflow_is_visible():
    window = SecurityWindow(capacity=2)
    for stamp in [1000, 950, 999]:
        window.ingest(json.dumps({"ts": stamp, "event_type": "http_request", "client_ip":"198.51.100.1", "status":200}), 1000)
    result = window.snapshot(1011)
    assert result["events"] == {"http_request": 1}
    assert result["discarded_due_to_capacity"] == 1
