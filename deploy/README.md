# Production deployment contract

`compose/production.yml` is the repository's production-shaped runtime contract,
not a claim that production infrastructure exists. It deliberately excludes
PostgreSQL, object storage, secret creation, and the public TLS proxy: those must be
managed services or independently controlled infrastructure.

The edge proxy is the only public component. It joins `LABELSCAN_EDGE_NETWORK`,
terminates TLS, adds HSTS, caps request bodies before multipart parsing, normalizes
forwarded headers, and connects to `api:8000`. The API has no published host port.
API and worker also join the externally managed `LABELSCAN_BACKEND_NETWORK`; its
firewall policy must allow only PostgreSQL, object storage, and approved OCR/LLM
egress destinations. Neither application role receives Docker socket access.

Deploy in this order:

1. Build, scan, sign, and push the image; set `LABELSCAN_IMAGE` to its digest.
2. Create the four external secrets and the external edge network.
3. Run `migrate` once and require a successful exit.
4. Start exactly one API replica (the MVP limiter is process-local), then workers.
5. Execute the smoke checks and pentest checklist in `docs/security/`.

The database URL secret must use `sslmode=verify-full`. Runtime containers use a
read-only root filesystem, explicit UID/GID 10001, no Linux capabilities, no new
privileges, bounded PIDs/CPU/memory, and writable `noexec` tmpfs only at `/tmp`.
