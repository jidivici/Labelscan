# Validation de sécurité de production

**Dernière vérification : 20 août 2026**

**Cible publique : `https://label-scan.fr`**
**Décision actuelle : REFUSÉE**

Le code contient les garde-fous attendus pour le mode `production`, mais le service
public vérifié le 20 août 2026 fonctionne encore avec une configuration hors
production. Ce document doit passer à **VALIDÉE** uniquement après un déploiement et
un passage intégral de `npm run security:production`.

## Contrôles actuels

| Contrôle | Résultat | Observation |
|---|---:|---|
| API métier sans jeton | Conforme | Les routes protégées répondent `401` |
| En-têtes d'identité forgés | Conforme | Les en-têtes `X-Actor-*` ne contournent pas le JWT |
| Documentation OpenAPI publique | Non conforme | `/docs` et `/openapi.json` répondent `200` |
| Détails de readiness | Non conforme | `/v1/health/ready` expose encore les contrôles internes |
| Origine web étrangère au login | Non conforme | La requête atteint la vérification des identifiants au lieu d'être refusée `403` |
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

L'audit du mobile signale **9 vulnérabilités élevées** dans les outils de
compilation Expo/Metro (`image-size` et `postcss`). Elles ne sont pas exécutées dans
l'application Android livrée et ne traitent, pendant le build, que les ressources
contrôlées du dépôt. Les avis connus sont documentés dans
`security/npm-audit-allowlist.json`, avec responsable, justification et expiration au
**2 septembre 2026**. Le contrôle CI refuse automatiquement tout nouvel avis élevé ou
critique, ainsi que toute exception expirée.

Le correctif proposé par npm force Expo 57 et casserait la contrainte Expo SDK 54 : il
n'est donc pas appliqué sans migration testée. La dépendance directe `uuid` a en
revanche été mise à jour vers sa version corrigée. Le portail web affiche
**0 vulnérabilité**.

## Critère de mise en production

1. Configurer/faire tourner les secrets VPS sans les placer dans Git; EAS ne reçoit que
   l'URL publique non secrète.
2. Déployer l'image produite depuis la révision validée avec
   `LABELSCAN_ENV=production`.
3. Exécuter `npm run security:production -- https://label-scan.fr`.
4. Rejouer la suite backend avec PostgreSQL 16, puis conserver le rapport de CI.

Un échec de l'une de ces étapes bloque la validation production.
