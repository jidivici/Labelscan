# LabelScan — modèle de menace pré-pentest

**Révision :** 3 août 2026  
**Actifs prioritaires :** comptes nominatifs, sessions, images brutes, extractions,
traçabilité HACCP, audit append-only, secrets IA/DB et séparation des organisations.

## Acteurs et hypothèses

- Attaquant Internet non authentifié visant l'authentification et les ressources coûteuses.
- Utilisateur opérateur ou admin malveillant tentant un IDOR inter-magasin/inter-tenant.
- Navigateur ou device perdu/compromis et refresh token volé.
- Étiquette hostile injectant des instructions dans OCR/LLM ou une image pathologique.
- Dépendance, image ou pipeline compromis.
- Erreur d'exploitation exposant API/DB, secrets, sauvegardes ou diagnostics.

Le reverse proxy, l'orchestrateur, PostgreSQL managé, S3/KMS et les fournisseurs IA sont
hors du trust boundary applicatif. Ils ne sont considérés fiables qu'après fourniture des
preuves de `PRE-PENTEST-CHECKLIST.md`.

## Scénarios prioritaires

| ID | Menace / chemin d'abus | Impact | Contrôles présents | Test pentest attendu |
|---|---|---|---|---|
| TM-01 | Credential stuffing / brute force | prise de compte | 5 échecs/IP/minute, cooldown compte, timing dummy hash | IP distinctes, compte distinct, reset et `Retry-After` |
| TM-02 | Vol/rejeu refresh | persistance de session | token opaque haché, rotation atomique, family revoke | course concurrente, rejeu, expiration, logout |
| TM-03 | JWT forgé ou mauvais service | élévation | signature, `exp/iat/jti/sid/iss/aud`, session active | algorithme/claims/issuer/audience/session invalides |
| TM-04 | CSRF login/refresh/logout navigateur | session confusion | origin HTTPS exact, SameSite Strict, path cookie étroit | Origin absent/null/tiers, cookie flags |
| TM-05 | IDOR inter-tenant/magasin | fuite/modification HACCP | tenant claims, ownership, RLS, scopes et stores | matrice deux organisations/deux magasins |
| TM-06 | Upload bomb/mime spoof/polyglot | DoS/coût/stockage hostile | lecture incrémentale 10 MiB, magic bytes, axes/MP | tronqué, faux MIME, dimensions, aucun artefact écrit |
| TM-07 | Prompt injection sur étiquette | donnée inventée/action induite | texte non fiable, sortie structurée, allow-list champs, no-fabrication/HITL | corpus adversarial et champs hors contrat |
| TM-08 | Epuisement OCR/LLM/API | coût/indisponibilité | quotas ingestion/mutations/long-poll, une replica | burst/sustained/holds globaux et acteur |
| TM-09 | Proxy/header spoof | bypass limite/hôte | trusted peer exact, allowed host, header-auth interdit | XFF depuis peer inconnu, Host hostile, auth headers |
| TM-10 | SQL injection | tenant escape/corruption | bind params, S608, code-selected fragments | chaque filtre/tri/ID et encodages inattendus |
| TM-11 | XSS/backoffice/token theft | compte admin | CSP, nosniff, frame denial, token mémoire, cookie HttpOnly | données stockées/réfléchies, DOM sinks, framing |
| TM-12 | Compromission conteneur | secrets/lateral movement | non-root, read-only, cap-drop, no-new-privileges, réseaux | filesystem, proc, metadata, ports et egress |
| TM-13 | Supply chain | exécution arbitraire | locks hashés, audits CI, bases par digest, exceptions expirantes | SBOM/scan/signature et provenance image |
| TM-14 | Altération/suppression de preuve | perte probante | raw-before-normalize, audit same-txn, triggers append-only | UPDATE/DELETE avec rôle applicatif et rollback |
| TM-15 | Fuite par logs/diagnostics | secrets/architecture | logs allow-list, erreurs génériques, docs prod fermées | tokens/mots de passe, 5xx, readiness, OpenAPI |

## Critères de re-modélisation

Ce modèle doit être revu avant : ajout d'une replica API, CORS/cross-origin, SSO/OIDC,
webhooks, URL d'objet signée, nouveau fournisseur IA, nouveau type de fichier, accès support
cross-tenant ou changement de politique de rétention.
