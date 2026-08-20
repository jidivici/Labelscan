# Documentation LabelScan

Cet index distingue les références vivantes des documents historiques. Une référence
vivante doit décrire le code et le déploiement actuels; les audits, plans datés et
supports de présentation terminés appartiennent à `archive/`.

## Références vivantes

| Domaine | Référence |
|---|---|
| Vue d'ensemble | `../README.md`, `ENTERPRISE-ARCHITECTURE.md` |
| Décisions | `architecture/adr/` |
| Mobile Expo SDK 54 | `mobile/MOBILE-APP.md` |
| API et backend | `backend/API-CONTRACTS.md`, `backend/openapi.v1.yaml`, `backend/BACKEND-ARCHITECTURE.md` |
| Données | `database/DATABASE.md`, `server/migrations/` |
| Extraction | `extraction/PROMPT-CONTRACT.md`, `pipeline/PIPELINE-ARCHITECTURE.md`, `ai-pipeline/AI-PIPELINE.md` |
| Sécurité | `security/SECURITY-RULES.md`, `security/SECURITY-ARCHITECTURE.md`, `security/SECRET-ROTATION.md`, `security/THREAT-MODEL.md`, `security/PRE-PENTEST-CHECKLIST.md`, `security/PRODUCTION-VALIDATION.md` |
| Exploitation | `operations/SRE-RELIABILITY.md`, `deploy/README.md` |
| Contribution | `DEVELOPER-GUIDE.md` |

## Règle d'entretien

- Mettre à jour la référence vivante dans le même changement que le contrat concerné.
- Ne pas transformer un audit daté en documentation permanente.
- Déplacer dans `archive/` tout plan livré, audit remplacé ou présentation ponctuelle.
- Les migrations, schémas exécutables, tests et fichiers de configuration priment en cas
  d'écart avec la prose.
