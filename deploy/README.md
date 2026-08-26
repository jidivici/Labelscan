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

## Hostinger single-VPS profile

`compose/single-vps.yml` is the hardened contract for the existing Hostinger VPS.
PostgreSQL and the raw-image volume remain on the private Docker network and are never
published. This profile is accepted only with
`LABELSCAN_DEPLOYMENT_TOPOLOGY=single-vps`; runtime validation then requires the
database hostname `db` and the exact mounted image path `/app/data/raw`.

The Hostinger deployment script backs up both PostgreSQL and the raw-image volume before
installing this contract. Demo seed data and images are preserved during normal updates;
they are replaced only when the separately guarded `--reset-demo` option is used.
That one-shot reset service receives the migration-owner database secret because it must
recreate projections and seed identities after the database replacement; API and worker
containers continue to receive only the restricted runtime secret.

Before the first hardened release, the script separates the historical PostgreSQL role.
When `labelscan_app` is PostgreSQL's immutable bootstrap superuser, that internal role is
renamed to `labelscan_db_admin` and a fresh `labelscan_app` runtime login is created as a
non-owner without superuser or RLS-bypass privileges. Their passwords and
URLs are distinct root-only files. Legacy provider keys are split into worker-only secret
files, the JWT signing key is rotated once, and known demo-account passwords are replaced
once without reseeding or deleting the demo images/arrivals. Rotation details are in
`docs/security/SECRET-ROTATION.md`.

The single-VPS profile now uses three distinct Docker networks: Caddy can reach only the
API on `edge`, PostgreSQL remains on the internal `backend` network, and workers obtain
outbound provider access through `egress`. Caddy's reviewed configuration lives in
`deploy/caddy/Caddyfile`; the deployment installs it verbatim, validates it under the
same reduced capabilities as production, rejects unknown HTTP hosts, and enforces an
11 MiB multipart envelope limit for the application's 10 MiB image limit.

Application images are tagged with the exact 40-character Git commit and carry the same
revision as an OCI label. The deployment refuses a dirty checkout, a mismatching image
label, a downgraded backoffice redirect, duplicate security headers, or an oversized
anonymous upload. The production workflow reruns mobile, web, browser, backend,
migration, dependency-audit, image-build, Compose and Caddy gates before the VPS runner
is allowed to deploy that revision.

The SSH and fail2ban policies applied to the VPS are versioned in
`deploy/hostinger/sshd-hardening.conf` and
`deploy/hostinger/fail2ban-labelscan.conf`. SSH accepts public keys only; root
password login, forwarding, tunnelling, and X11 forwarding are disabled.
