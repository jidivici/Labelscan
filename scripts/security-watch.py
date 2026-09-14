#!/usr/bin/env python3
"""Summarize a live Docker JSON log stream; never emit source payloads.

docker compose ... logs -f --no-log-prefix --no-color --since 2m api caddy |
    python3 scripts/security-watch.py

Console alerts only. This is an operator's view, not a durable log collector.
"""

from __future__ import annotations

import json
import select
import sys
import time
from collections import Counter, deque
from datetime import datetime, timezone


class SecurityWindow:
    def __init__(self, seconds=60, capacity=50000):
        self.seconds = seconds
        self.events = deque(maxlen=capacity)
        self.discarded = 0

    def ingest(self, line, now):
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict):
                return
            kind = entry.get("event_type") or entry.get("message")
            edge = str(entry.get("logger", "")).startswith("http.log.access")
            if not edge and kind not in {
                "http_request", "auth_login_failed", "auth_login_succeeded",
                "auth_refresh_failed", "auth_refresh_succeeded", "rate_limited",
            }:
                return
            stamp = entry.get("ts")
            stamp = float(stamp) if isinstance(stamp, (int, float)) else datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
            if not now - self.seconds <= stamp <= now + 5:
                return
            request = entry.get("request") or {}
            ip = str((request.get("client_ip") or request.get("remote_ip")) if edge else entry.get("client_ip") or "unknown")[:64]
            status = int(entry.get("status") or 0)
            if len(self.events) == self.events.maxlen:
                self.discarded += 1
            self.events.append((stamp, "edge_request" if edge else kind, ip, status))
        except (ValueError, TypeError, AttributeError, OverflowError):
            return

    def snapshot(self, now):
        # Logs from multiple containers may arrive out of timestamp order.
        self.events = deque((e for e in self.events if e[0] >= now - self.seconds), maxlen=self.events.maxlen)
        totals = Counter(e[1] for e in self.events)
        requests = Counter()
        failures = Counter()
        alerts = []
        for _, kind, ip, status in self.events:
            if kind in {"http_request", "edge_request"}:
                requests[(kind, ip)] += 1
                if status in {401, 403, 404, 413, 429} or status >= 500:
                    failures[(kind, ip, status)] += 1
            if kind == "auth_login_failed":
                failures[(kind, ip, 401)] += 1
            if kind == "auth_refresh_failed":
                failures[(kind, ip, 401)] += 1
        for (kind, ip, status), count in sorted(failures.items()):
            threshold = 5 if kind.startswith("auth_") or status >= 500 else 10
            if count >= threshold:
                alerts.append({"signal": kind, "ip": ip, "status": status, "count": count})
        for (kind, ip), count in sorted(requests.items()):
            if count >= 300:
                alerts.append({"signal": "request_burst", "layer": kind, "ip": ip, "count": count})
        return {
            "ts": datetime.fromtimestamp(now, timezone.utc).isoformat(),
            "window_seconds": self.seconds,
            "events": dict(totals),
            "active_ips": sorted({e[2] for e in self.events}),
            "alerts": alerts,
            "discarded_due_to_capacity": self.discarded,
        }


def main():
    window = SecurityWindow()
    deadline = time.monotonic() + 10
    pending = b""
    oversized = False
    while True:
        readable, _, _ = select.select([sys.stdin.buffer], [], [], max(0, deadline - time.monotonic()))
        if readable:
            chunk = sys.stdin.buffer.read1(65536)
            if not chunk:
                if pending and not oversized:
                    window.ingest(pending, time.time())
                print(json.dumps(window.snapshot(time.time())), flush=True)
                return
            for i, part in enumerate(chunk.split(b"\n")):
                if i:
                    if not oversized:
                        window.ingest(pending, time.time())
                    pending = b""
                    oversized = False
                if not oversized:
                    pending += part
                    if len(pending) > 65536:
                        pending = b""
                        oversized = True
        if time.monotonic() >= deadline:
            print(json.dumps(window.snapshot(time.time())), flush=True)
            deadline = time.monotonic() + 10


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
