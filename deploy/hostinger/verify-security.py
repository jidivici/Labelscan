"""Bounded post-deployment probes; print checks only, never production log data."""

from __future__ import annotations

import ipaddress
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ORIGIN = "https://label-scan.fr"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)
    print(f"PASS {message}", flush=True)


def request(path, *, body=None, headers=None):
    selected = {"User-Agent": "LabelScan-Deployment-Security-Probe"}
    selected.update(headers or {})
    data = None
    if body is not None:
        selected.update({"Content-Type": "application/json", "Origin": ORIGIN})
        data = json.dumps(body).encode()
    req = urllib.request.Request(ORIGIN + path, data=data, headers=selected)
    try:
        response = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read(65536).decode()


def docker(*args):
    return subprocess.check_output(
        ["docker", *args], text=True, stderr=subprocess.DEVNULL, timeout=30,
    )


def records(lines):
    for line in lines.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict):
            yield entry


def verify(compose_file, revision):
    compose = ("compose", "-f", compose_file)
    status, _, body = request("/v1/version")
    require(status == 200 and json.loads(body).get("version") == revision, "published revision matches release")

    status, _, trace = request("/cdn-cgi/trace")
    trace_fields = dict(line.split("=", 1) for line in trace.splitlines() if "=" in line)
    observed_ip = str(ipaddress.ip_address(trace_fields.get("ip", "")))
    require(status == 200, "Cloudflare client attribution available")

    probe = "security_" + uuid.uuid4().hex
    path = "/v1/" + probe
    sentinel = uuid.uuid4().hex
    headers = {"X-Correlation-Id": probe, "X-Forwarded-For": "198.51.100.77", "CF-Connecting-IP": "198.51.100.78"}
    status, _, _ = request(path + "?token=" + sentinel, headers=headers)
    require(status == 404, "unknown API path rejected")

    statuses = []
    for _ in range(6):
        status, response_headers, _ = request(
            "/v1/auth/login", body={"username": probe, "password": "invalid-deployment-probe-password"},
            headers=headers,
        )
        statuses.append(status)
        if status == 429:
            break
    require(statuses == [401] * 5 + [429], "login blocked after five invalid attempts")
    require(int(response_headers.get("Retry-After", "0")) > 0, "rate-limit retry delay present")
    status, _, _ = request(
        "/v1/auth/login", body={"username": probe + "_other", "password": "invalid-deployment-probe-password"},
        headers={**headers, "X-Forwarded-For": "203.0.113.99"},
    )
    require(status == 429, "forged client IP cannot evade login limit")

    matched = []
    for _ in range(10):
        lines = docker(*compose, "logs", "--no-color", "--no-log-prefix", "--since", "2m", "--tail", "1000", "api", "caddy")
        matched = [r for r in records(lines) if r.get("correlation_id") == probe or (r.get("request") or {}).get("uri", "").startswith(path)]
        if any(r.get("message") == "auth_login_failed" for r in matched) and any(r.get("request") for r in matched):
            break
        time.sleep(1)
    failures = [r for r in matched if r.get("message") == "auth_login_failed"]
    require(len(failures) == 5, "authentication failure events recorded")
    require(all(r.get("client_ip") == observed_ip and r.get("account_key") for r in failures), "authentication logs contain verified client IP and account reference")
    require(any(r.get("event_type") == "http_request" and r.get("status") == 429 for r in matched), "HTTP rate-limit refusal recorded")
    edge = [r for r in matched if r.get("request")]
    require(bool(edge) and all(r["request"].get("client_ip") == observed_ip for r in edge), "Caddy logs contain verified client IP")
    require(all("headers" not in r["request"] and "resp_headers" not in r for r in edge), "Caddy access headers are excluded")
    require(sentinel not in json.dumps(matched) and "invalid-deployment-probe-password" not in json.dumps(matched), "query and password values excluded from probe logs")

    containers = docker(*compose, "ps", "-q", "api", "worker", "caddy", "db").split()
    require(len(containers) == 7, "API, database, proxy and four workers present")
    for container in containers:
        policy = json.loads(docker("inspect", "--format", "{{json .HostConfig.LogConfig}}", container))
        if policy.get("Type") != "json-file" or policy.get("Config", {}).get("max-size") != "20m" or policy.get("Config", {}).get("max-file") != "10":
            raise RuntimeError("container log rotation differs from reviewed policy")
    require(True, "bounded log rotation active on all runtime containers")


if __name__ == "__main__":
    try:
        verify(sys.argv[1], sys.argv[2])
    except RuntimeError as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, IndexError, TypeError, subprocess.SubprocessError) as error:
        # Avoid including request data or raw Docker output in public CI logs.
        print(f"FAIL security verification could not complete ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
