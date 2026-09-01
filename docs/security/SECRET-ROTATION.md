# Secret and credential rotation

This runbook explains rotation order and impact without containing real secret values.
Treat any value copied into a chat, ticket, screenshot, shell history, build log, shared
export, or unapproved local file as exposed and replace it.

For the historical mobile token-persistence exposure and its release-regression proof,
see OR-01 and OR-07 in the
[risk register](THREAT-MODEL.md#confirmed-open-risk-register).

The exact storage mechanism depends on the topology:

- managed infrastructure uses external Docker secret objects and should use workload
  identity or an approved secret manager around them;
- the Hostinger profile reads root-owned files under `/opt/labelscan/secrets`;
- mobile users receive session tokens only. Provider, database, and signing credentials
  must never enter the app bundle or an `EXPO_PUBLIC_*` value.

## Safe rotation pattern

1. Name an operator, reviewer, change window, rollback point, and incident contact.
2. Confirm a current database/raw-image backup and its off-host copy. A local VPS archive
   alone is not disaster recovery.
3. Identify every consumer and every copy of the old value before changing it.
4. Create the replacement in the approved secret system. Generate random values with a
   cryptographic generator; do not invent memorable infrastructure passwords.
5. Rotate one credential at a time. Update the upstream service and mounted secret in the
   order described below.
6. Restart or recreate only the consumers that need the value, then test health,
   authentication/authorization, and a representative business flow.
7. Revoke the old value after the new path is proven. Do not leave an indefinite overlap.
8. Search logs and deployment metadata for accidental disclosure without printing the
   secret itself.
9. Record evidence: credential identifier, operator, timestamps, affected components,
   validation, old-value revocation, and any user impact. Never record the value or a
   recognizable prefix.

## Current secret inventory

| Credential | Intended consumer | Rotation impact |
|---|---|---|
| PostgreSQL owner/admin password and URL | PostgreSQL bootstrap plus migration, demo-reset, and credential-maintenance jobs | Blocks maintenance/migrations if files drift; long-running API/worker should be unaffected |
| PostgreSQL runtime password and URL | API and workers | Existing pooled connections may survive briefly; new connections fail until both DB and mounted URL agree |
| JWT HS256 signing secret | API | Existing access tokens fail signature verification after replacement; refresh sessions require separate revocation if forced logout is intended |
| Google Vision key | Workers | OCR fails during a bad cutover; API remains available |
| Anthropic key | Workers | LLM extraction fails during a bad cutover; API remains available |
| Demo credential file | One-shot demo/credential-maintenance jobs | Changes synthetic account passwords when the job is deliberately run |
| User password | Identity service | Revokes that user's sessions when changed through the application flow |
| VPS root password / SSH keys | Host access, outside LabelScan containers | Can lock out operators; independent of application and database credentials |
| S3 workload identity or access key | Components using managed object storage | Can block image writes/reads; not mounted by the single-VPS profile |

## Hostinger secret files

The deployment script creates or validates these files:

- `db_runtime_password`: `root:root`, mode `0600`; it is retained for controlled
  credential maintenance and is not mounted into a long-running service;
- `db_admin_password`: `root:70`, mode `0640`, so the PostgreSQL container can read its
  Compose secret through the database-user group;
- `database_admin_url`, `database_url`, `jwt_secret`, provider keys, and
  `demo_credentials.json`: `root:10001`, mode `0640`, then mounted only into the services
  named by Compose.

Write a replacement to a temporary file with restrictive permissions and atomically
rename it into place. Never edit a mounted secret in place where a reader can observe a
partial value. Validate owner, group, mode, non-empty content, and Compose service mounts
without printing contents.

The deploy script can migrate selected legacy secrets and performs one-time JWT/database
hardening behind marker files. Marker existence is not proof that a later manual rotation
was completed correctly.

## PostgreSQL runtime credential

The single-VPS runtime login is `labelscan_app`. It must remain non-owner, non-superuser,
without privileged membership, database/role creation, replication, or `BYPASSRLS`.

Rotation order:

1. Generate a replacement password in a protected channel.
2. Change the PostgreSQL role through a local owner connection without placing the value
   in command-line arguments or interactive history.
3. Build a new `postgresql+psycopg` URL. URL-encode any non-URL-safe password; the
   deployment-generated hexadecimal format avoids this ambiguity.
4. Atomically replace `db_runtime_password` and `database_url`, preserving their different
   ownership/modes.
5. Recreate API and workers so new connection pools use the replacement.
6. Check readiness, login/refresh, a protected read, one idempotent ingestion path, and a
   cross-tenant RLS denial with the actual runtime role.

Changing PostgreSQL first allows existing connections to finish while preventing a new
container from starting with a value the database does not yet accept. If validation
fails, coordinate rollback of both the database role and secret file; do not leave two
different sources of truth.

## PostgreSQL owner/migration credential

The Hostinger owner is `labelscan_db_admin`. It must never be mounted into API or worker.

1. Change the role through a local controlled database session.
2. Atomically replace `db_admin_password` and `database_admin_url` with their required
   permissions.
3. Run a non-destructive migration connectivity/revision check using the one-shot
   migration service.
4. Reconfirm that API and worker mounts still contain only `database_url`.

The managed Compose profile currently has one shared database secret and therefore cannot
rotate owner/runtime credentials independently. Fix that deployment contract before using
the profile as least-privilege production.

## JWT signing secret and session revocation

The current token format uses one active symmetric HS256 secret; there is no key ID or
overlap set.

1. Generate at least 32 random bytes; the Hostinger deployment uses a longer generated
   value.
2. Atomically replace the API's signing-secret source and recreate the API.
3. Verify new browser/mobile login, access-token validation, refresh, and logout.
4. Confirm an access token signed with the old key is rejected.

Replacing the signing key invalidates old **access tokens**, but it does not automatically
revoke refresh-session rows. A holder of a still-valid refresh token may request a new
access token signed with the replacement key. If the rotation responds to compromise or
must force every user to sign in again, revoke the relevant session families (or all active
sessions) in a reviewed identity/DB operation as well. The repository has no dedicated
global-revocation CLI, so preserve audit evidence for that maintenance action.

## Google Vision and Anthropic

Rotate one provider at a time:

1. Create a replacement credential in the provider project, limited to the required API,
   quotas, budget, and approved egress identities where supported.
2. Update only the relevant worker secret file/object.
3. Recreate workers and process a synthetic label end to end.
4. Check provider errors, quota/cost telemetry, extraction outcome, and absence of the key
   from logs/container metadata.
5. Revoke the old key and prove it no longer works from the production egress path.

An application test can prove the new key works; it cannot prove the old provider key was
deleted or that provider-side restrictions are correct. Keep provider-console evidence.

## Managed S3 identity

Prefer short-lived workload identity to a long-lived access key. The managed Compose
profile does not define an AWS credential secret, so the platform must provide the
credential chain and scope outside this repository.

When a long-lived key is unavoidable, create a replacement on a dedicated least-privilege
principal, update only S3-using components, verify read/write on the intended tenant prefix
and denial elsewhere, then disable and delete the old key. Also verify the KMS grant;
bucket access without KMS access is an incomplete rotation.

The Hostinger filesystem topology does not need AWS credentials and must not receive them.

## Application user passwords

Users change their own password through `POST /v1/me/password` and must provide the
current password. The server enforces the role-specific policy and revokes sessions. Use
the administration flows to deactivate accounts; do not update password hashes directly
except through an approved, audited incident-recovery procedure.

The server uses salted PBKDF2-HMAC-SHA256 with constant-time verification. Rotating a user
password creates a new salt. Password-hash algorithm migration is separate from secret
rotation and must preserve safe verification/rehashing semantics.

## Mobile token exposure response

Older mobile builds could persist/export an access token inside
`photo_headers.Authorization` and leave share files behind. Current catalogue DTOs
have no token-bearing header, and temporary export files are deleted on success,
failure, and cancellation. Treat any artifact produced by an older build as exposed.

If an export was created, shared, backed up, or exposed:

1. identify and revoke the affected session family;
2. remove the export from every known destination and the device, following evidence
   preservation requirements;
3. review access logs for the token lifetime and actor scope;
4. do not treat access-token expiry as proof that no access occurred;
5. fix and verify export sanitization plus deletion/retention before reopening the flow.

## VPS and SSH access

Rotate the VPS root password through the Hostinger control plane, not through LabelScan.
Keep console recovery and one tested SSH key available before changing access. Test a new
session before closing the existing one.

SSH-key rotation should add and test the new key first, remove the old key second, and
record which operator/device owns each remaining key. The repository's SSH/fail2ban files
are reference policies; `deploy.sh` does not install them.

## When rotation fails

Stop and preserve the state if consumers disagree about the active credential, database
health drops, provider errors rise, or authentication behaves unexpectedly. Restore a
coherent old or new configuration—never a mixture—and document the interval during which
both credentials may have worked. Escalate suspected disclosure through the incident
process rather than retrying rotations blindly.
