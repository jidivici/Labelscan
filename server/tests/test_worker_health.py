"""Worker liveness heartbeat — pure, NO DB."""

from __future__ import annotations

import os
import time

from labelscan.app.worker_runtime import _beat, worker_is_healthy


def test_missing_heartbeat_is_unhealthy(tmp_path):
    assert worker_is_healthy(str(tmp_path / "hb"), 180.0) is False


def test_fresh_heartbeat_is_healthy(tmp_path):
    p = str(tmp_path / "hb")
    _beat(p)
    assert worker_is_healthy(p, 180.0) is True


def test_stale_heartbeat_is_unhealthy(tmp_path):
    p = str(tmp_path / "hb")
    _beat(p)
    old = time.time() - 1000
    os.utime(p, (old, old))
    assert worker_is_healthy(p, 180.0) is False


def test_beat_is_best_effort_and_never_raises():
    _beat("/nonexistent-dir/labelscan/hb")  # unwritable path → no exception
