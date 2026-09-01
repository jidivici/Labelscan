# LabelScan documentation

Welcome. This is the shortest route to reliable information about LabelScan—whether you
are discovering the product, changing a feature, reviewing security, or preparing a
release.

Every document linked from this page is a **living reference**. It should describe the
repository as it works today, explain why the details matter, and point to the executable
source when precision is important.

## Start with the right guide

| You want to… | Start here | What you will find |
|---|---|---|
| Understand the product | [Project README](../README.md) | Product story, local setup, everyday commands, and current boundaries |
| See how the system fits together | [Enterprise architecture](ENTERPRISE-ARCHITECTURE.md) | Components, data flow, trust boundaries, ownership, and design constraints |
| Make your first contribution | [Developer guide](DEVELOPER-GUIDE.md) | Repository tour, safe change workflow, validation, and review expectations |
| Work on the backend | [Server README](../server/README.md) | Backend setup, code organization, API orientation, persistence, and workers |
| Deploy or operate LabelScan | [Deployment guide](../deploy/README.md) | Supported topologies, release inputs, validation, rollback, and operational limits |

## Product and application guides

| Area | Guide | Focus |
|---|---|---|
| Mobile app | [Mobile application](mobile/MOBILE-APP.md) | Capture, queueing, review, local storage, navigation, and recovery behavior |
| React back office | [Back-office application](mobile/MOBILE-APP.md#react-back-office) | Browser sessions, arrival search, role-based navigation, and identity administration |
| API | [API contracts](backend/API-CONTRACTS.md) | Authentication, endpoints, request rules, idempotency, errors, and ownership |
| OpenAPI | [Generated specification](backend/openapi.v1.yaml) | Machine-readable HTTP inventory generated from the server |
| Database | [Database reference](database/DATABASE.md) | Schemas, tables, transactions, tenancy, immutability, and migration workflow |

## Architecture and decision records

| Guide | Why it is useful |
|---|---|
| [Backend architecture](backend/BACKEND-ARCHITECTURE.md) | Explains the modular monolith, context boundaries, ports, adapters, and composition |
| [Architecture decisions](architecture/adr/README.md) | Preserves the reasoning behind choices that still shape the code |
| [Pipeline architecture](pipeline/PIPELINE-ARCHITECTURE.md) | Follows a capture through storage, OCR, extraction, review, and catalogue projection |

## OCR, extraction, and evaluation

| Guide | Why it is useful |
|---|---|
| [AI pipeline](ai-pipeline/AI-PIPELINE.md) | Detailed provider flow, evidence handling, gates, retries, and failure behavior |
| [Prompt contract](extraction/PROMPT-CONTRACT.md) | Closed output rules, evidence requirements, versioning, and profile-specific fields |
| [Evaluation suite](pipeline/eval-suite.md) | Dataset design, metrics, regression review, and release interpretation |
| [Model and cost control](ai-pipeline/model-and-cost-notes.md) | Supported model configuration, token measurement, calibration, latency, and cost trade-offs |

## Security, release, and operations

| Guide | Use it when… |
|---|---|
| [Threat model and open risks](security/THREAT-MODEL.md) | You need the prioritized record of confirmed security gaps and release blockers |
| [Security architecture](security/SECURITY-ARCHITECTURE.md) | You are reviewing trust boundaries, controls, data protection, or residual risk |
| [Security rules](security/SECURITY-RULES.md) | You are implementing or reviewing a security-sensitive change |
| [Pre-pentest checklist](security/PRE-PENTEST-CHECKLIST.md) | You are collecting evidence before an external security review |
| [Production validation](security/PRODUCTION-VALIDATION.md) | You are validating a specific release in a real environment |
| [Secret rotation](security/SECRET-ROTATION.md) | You need to replace credentials without losing control of the rollout |
| [SRE and reliability](operations/SRE-RELIABILITY.md) | You are monitoring, backing up, restoring, troubleshooting, or responding to an incident |

## Living documentation and archive

Current guides stay in the active documentation tree. Superseded audits, completed plans,
old design snapshots, and replaced technical references live in the
[documentation archive](archive/README.md), where every item is labelled with its
historical role and current replacement.

Archive material is context, not instruction. Never use it as the source for a new setup,
schema change, security decision, or release.

When two current sources disagree, use this order while fixing the documentation gap:

1. application code, executable migrations, runtime configuration, schemas, and automated tests;
2. generated API contracts and active prompt contracts;
3. living architecture and feature guides;
4. environment-specific release evidence.

## Documentation standard

Keep the library pleasant and dependable:

- write in clear, friendly English for the reader who will perform the work;
- introduce the purpose and prerequisites before commands or configuration;
- explain consequences, limits, and ownership instead of listing facts without context;
- update the relevant guide in the same change as the behavior;
- link to one maintained source instead of copying the same contract across files;
- keep credentials, personal data, and unverified production values out of examples;
- archive replaced material only after its useful conclusions exist in a living guide.
