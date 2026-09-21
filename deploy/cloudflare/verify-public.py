#!/usr/bin/env python3
"""Check Cloudflare without credentials or successful application mutations.

--exercise-rate-limit briefly rate-limits logins for the calling public IP.
The burst uses GET, rejected before authentication, without password guesses.
"""

import argparse
from datetime import datetime, timezone
import json
import socket
import ssl
import time
import urllib.error
import urllib.request
import warnings

ORIGIN = "https://label-scan.fr"
LOGINS = ["/v1/auth/login", "/v1/o/labelscan/auth/login", "/v1/mobile/auth/login"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(path, method="GET", body=None, origin=ORIGIN):
    headers = {"Accept": "application/json",
               "User-Agent": "LabelScan/1.0 (mobile API client)",
               "X-Correlation-Id": "cloudflare-public-audit"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(origin + path, data=body, headers=headers, method=method)
    try:
        response = urllib.request.build_opener(NoRedirect).open(req, timeout=15)
    except urllib.error.HTTPError as exc:
        response = exc
    except OSError as exc:
        return {"path": path, "method": method, "origin": origin,
                "status": None, "error": str(exc), "json": False,
                "cf_mitigated": None}
    with response:
        raw = response.read(32768)
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        return {"path": path, "method": method, "origin": origin,
                "status": response.status,
                "content_type": response.headers.get("Content-Type", ""),
                "location": response.headers.get("Location"),
                "retry_after": response.headers.get("Retry-After"),
                "cf_mitigated": response.headers.get("cf-mitigated"),
                "cf_ray": response.headers.get("cf-ray"),
                "json": isinstance(parsed, dict),
                "error_code": parsed.get("error_code") if isinstance(parsed, dict) else None}


def check_tls(version):
    ctx = ssl.create_default_context()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        ctx.minimum_version = ctx.maximum_version = version
    # The probe must offer legacy TLS; only an explicit server protocol alert
    # counts as evidence of rejection. Local cipher errors remain failures.
    if ssl.OPENSSL_VERSION.startswith("LibreSSL"):
        ctx.set_ciphers("DEFAULT")
    else:
        ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
    try:
        with socket.create_connection(("label-scan.fr", 443), timeout=10) as raw:
            with ctx.wrap_socket(raw, server_hostname="label-scan.fr") as conn:
                return {"offered": version.name, "negotiated": conn.version(),
                        "passed": version >= ssl.TLSVersion.TLSv1_2}
    except ssl.SSLError as exc:
        return {"offered": version.name, "error": str(exc),
                "passed": version < ssl.TLSVersion.TLSv1_2
                and exc.reason == "TLSV1_ALERT_PROTOCOL_VERSION"}
    except OSError as exc:
        return {"offered": version.name, "error": str(exc), "passed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exercise-rate-limit", action="store_true")
    args = parser.parse_args()
    report = {"captured_at": datetime.now(timezone.utc).isoformat(), "checks": []}

    def record(result, passed):
        result["passed"] = passed
        report["checks"].append(result)

    def api_check(path, status, method="GET", body=None):
        r = request(path, method, body)
        record(r, r["status"] == status and r["json"] and not r["cf_mitigated"])

    for version in (ssl.TLSVersion.TLSv1, ssl.TLSVersion.TLSv1_1,
                    ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
        report["checks"].append(check_tls(version))
    r = request("/v1/health/live?audit=https", origin="http://label-scan.fr")
    record(r, r["status"] in (301, 308)
           and r["location"] == ORIGIN + "/v1/health/live?audit=https")
    r = request("/v1/health/live", origin="https://www.label-scan.fr")
    record(r, r["status"] in (301, 308)
           and r["location"] == ORIGIN + "/v1/health/live")
    r = request("/backoffice/o/labelscan/")
    record(r, r["status"] == 200 and not r["cf_mitigated"])
    api_check("/v1/health/live", 200)
    api_check("/v1/arrivals", 401)
    for path in LOGINS:
        api_check(path, 400, "POST", b"{}")
    api_check("/v1/mobile/auth/refresh", 400, "POST", b"{}")
    # A Free-plan custom WAF block may be HTML even when JSON was requested.
    # The useful mobile contract is a stable HTTP status and no browser challenge;
    # src/services/api.ts safely maps a non-JSON 403 to HTTP_403.
    r = request("/v1/health/live", "PROPFIND")
    record(r, r["status"] == 403 and not r["cf_mitigated"])

    if args.exercise_rate_limit:
        burst = []
        for index in range(20):
            burst.append(request(LOGINS[index % len(LOGINS)]))
            time.sleep(0.1)
        limited = [r for r in burst if r["status"] == 429]
        record({"test": "shared_login_rate_limit", "responses": burst},
               {r["path"] for r in limited} == set(LOGINS)
               and all(r["json"] and not r["cf_mitigated"]
                       and str(r["retry_after"]).isdigit()
                       and int(r["retry_after"]) > 0 for r in limited))
        api_check("/v1/health/live", 200)
        time.sleep(11)
        for path in LOGINS:
            api_check(path, 405)

    report["passed"] = all(r["passed"] for r in report["checks"])
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
