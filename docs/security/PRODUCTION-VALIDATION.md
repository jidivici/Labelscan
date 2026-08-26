# Validation de sécurité de production

**Dernière vérification : 20 août 2026**

**Cible publique : `https://label-scan.fr`**
**Décision actuelle : VALIDÉE**

La révision applicative `0b5408ef52af95cd604f7bed0df4d302f267bcf7` a été déployée
sur le VPS Hostinger le 20 août 2026. Le pipeline a créé des sauvegardes PostgreSQL et
images brutes, appliqué la migration `0032_ingestion_db_hardening`, puis passé son
contrôle de santé et l'intégralité de `npm run security:production`.

## Contrôles actuels

| Contrôle | Résultat | Observation |
|---|---:|---|
| API métier sans jeton | Conforme | Les routes protégées répondent `401` |
| En-têtes d'identité forgés | Conforme | Les en-têtes `X-Actor-*` ne contournent pas le JWT |
| Documentation OpenAPI publique | Conforme | `/docs`, `/redoc` et `/openapi.json` répondent `404` |
| Détails de readiness | Conforme | `/v1/health/ready` répond uniquement `{"status":"ready"}` |
| Origine web étrangère au login | Conforme | Une origine étrangère est refusée `403` |
| En-têtes HTTPS | Conforme | HSTS un an avec `includeSubDomains`; API en `no-store` |
| Rôles PostgreSQL | Conforme | Runtime non privilégié, sans membership ni ownership; owner/migrateur séparé |
| Données de démonstration | Conforme | 1 `super_admin`, 6 utilisateurs, 9 images brutes et 9 ingestions conservés |
| Configuration Android | Conforme localement | URL publique HTTPS fixée par le profil; aucun secret ne doit être configuré en `EXPO_PUBLIC_*` |

## Preuves locales

- Les règles de configuration refusent un démarrage `production` sans origine HTTPS,
  hôtes autorisés et secret JWT robuste. La topologie managée exige S3/KMS et PostgreSQL
  TLS `verify-full`; la topologie Hostinger mono-VPS exige à la place le service privé
  `db` et le volume brut monté exactement dans `/app/data/raw`.
- La suite backend complète sur PostgreSQL 16 vierge passe après migration
  montée/descente/remontée : **407 réussis, 0 échec, 1 ignoré**. Le seul test ignoré
  effectuerait volontairement un appel Anthropic facturé.
- Le lint de sécurité Ruff passe et les **5 contrats d'architecture** sont respectés.
- Les preuves PostgreSQL locales couvrent l'isolation des locataires,
  `SECURITY DEFINER`, RLS, audit, immutabilité, concurrence et idempotence. La CI
  distante doit encore reproduire ce résultat avant fusion.
- L'audit Python en ligne ne trouve **aucune vulnérabilité connue** dans le graphe
  backend verrouillé.

## Dépendances npm

L'audit npm du mobile et celui du portail web exigent **0 vulnérabilité**, sans
exception temporaire. Expo reste épinglé au SDK 54 : les dépendances transitives
vulnérables sont remplacées par des versions corrigées compatibles et verrouillées
dans `package-lock.json`.

## Preuves de mise en production

1. Les secrets VPS ont été générés sur le serveur et restent absents de Git; EAS ne reçoit
   que l'URL publique non secrète.
2. L'image tourne avec `LABELSCAN_ENV=production` sur un réseau DB privé non publié.
3. `npm run security:production -- https://label-scan.fr` passe intégralement depuis une
   machine extérieure au VPS.
4. La suite backend PostgreSQL 16 a produit 407 réussites, 0 échec et 1 test facturé
   volontairement ignoré.
5. Trois paires de sauvegardes DB/images ont été créées durant la transition. La clé SSH
   temporaire de déploiement a été retirée du VPS, de hPanel et du poste local; la clé
   existante et le mot de passe root n'ont pas été modifiés.

Tout futur échec de l'un de ces contrôles bloque un nouveau déploiement.
