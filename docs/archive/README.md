# LabelScan documentation archive

This directory keeps useful historical context without letting old instructions compete
with the current documentation. Nothing here should be used as an active setup, security,
deployment, or implementation guide.

For current information, start with the [documentation home](../README.md). It points to
the maintained source for every development area.

## What belongs here

A document or reference moves into the archive when it has been replaced, describes a
completed project phase, or mirrors an executable source that now lives elsewhere. We
keep it only when it still helps explain an earlier decision or repository state.

Archived files may retain their original language and terminology. Their filenames are
preserved where practical so older links and Git history remain understandable.

## Historical documents

| Document | Why it is archived | Use today |
|---|---|---|
| `0010-SYNTHESIS.md`, `0011-SYNTHESIS.md`, `0012-SYNTHESIS.md` | Completed delivery snapshots from June 2026 | [Mobile application](../mobile/MOBILE-APP.md) and the relevant feature guide |
| `ARCHITECTURE.md` | Earlier target architecture | [Enterprise architecture](../ENTERPRISE-ARCHITECTURE.md) and [ADRs](../architecture/adr/README.md) |
| `AUDIT.md`, `AUDIT-V1.1.md`, `AUDIT-TECHNIQUE-COMPLET.md` | Point-in-time audits whose findings were delivered, replaced, or reprioritized | [Security architecture](../security/SECURITY-ARCHITECTURE.md) and [open risks](../security/THREAT-MODEL.md#confirmed-open-risk-register) |
| `SECURITY-AUDIT-V2.md`, `SECURITY-AUDIT-V3.md` | Superseded security snapshots | [Security architecture](../security/SECURITY-ARCHITECTURE.md) and [open risks](../security/THREAT-MODEL.md#confirmed-open-risk-register) |
| `IMPLEMENTATION-PLAN.md`, `IMPLEMENTATION-ROADMAP.md` | Completed or superseded plans | [Developer guide](../DEVELOPER-GUIDE.md) and current issue tracking |
| `LATENCY-REVIEW.md` | Measurements from an earlier pipeline version | [SRE and reliability](../operations/SRE-RELIABILITY.md) |
| `PROD-READINESS.md` | Earlier release-readiness snapshot | [Production validation](../security/PRODUCTION-VALIDATION.md) |
| `SYNTHESIS.md`, `TECH-REVIEW.md` | Historical design and handover summaries | [Enterprise architecture](../ENTERPRISE-ARCHITECTURE.md) and [developer guide](../DEVELOPER-GUIDE.md) |
| `audit_qualite.md` | Closed quality-audit brief | No active replacement; consult Git history only when investigating that review |

## Archived technical references

These files once duplicated or anticipated executable contracts. They are retained for
history, but development must use the sources listed below.

| Directory | Archived material | Current source |
|---|---|---|
| `database/` | SQL snapshots and handwritten migration extracts | [`server/migrations/`](../../server/migrations/) and [database reference](../database/DATABASE.md) |
| `extraction/` | Version 1 extraction schema and sample fixtures | Backend extraction models, tests, and [prompt contract](../extraction/PROMPT-CONTRACT.md) |
| `pipeline/` | Superseded shared-state schema | Backend pipeline code and [pipeline architecture](../pipeline/PIPELINE-ARCHITECTURE.md) |

## Archive rule for future changes

Before moving a file here:

1. confirm that a maintained source now covers its useful information;
2. update incoming links to the maintained source;
3. add the archived item to this index with a short reason;
4. avoid archiving generated build output, secrets, or personal data.

The archive preserves context. It is not a second documentation set.
