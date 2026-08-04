# LabelScan — architecture de sécurité de production

**Statut :** contrat de déploiement pré-pentest  
**Révision :** 4 août 2026
**Source exécutable :** `deploy/compose/production.yml`

Ce document décrit l'architecture réellement implémentée. Il ne certifie pas
l'infrastructure qui sera créée autour de l'image. Les preuves externes restent dans
`PRE-PENTEST-CHECKLIST.md`.

## 1. Décision d'architecture

LabelScan reste un **monolithe modulaire**. Le découper en microservices avant le MVP
ajouterait des identités machine, des flux réseau et des états distribués sans réduire la
surface métier. Les frontières de contexte sont déjà imposées par `import-linter`; les
travaux CPU/IO longs sont isolés dans un processus worker et communiquent par une outbox
PostgreSQL transactionnelle.

Arborescence de référence :

```text
Labelscan/
├── src/                         application mobile Expo SDK 54
├── web/                         backoffice React/Vite same-origin
├── server/
│   ├── src/labelscan/
│   │   ├── app/                 composition API/worker uniquement
│   │   ├── contexts/            audit, compliance, HACCP, identity,
│   │   │                        ingestion et traceability
│   │   └── platform/            HTTP, config, DB, outbox et stockage
│   ├── migrations/              migrations Alembic, exécutées à part
│   ├── tests/                   preuves unitaires/intégration/tenancy
│   └── scripts/                 inventaire OpenAPI reproductible
├── deploy/                      contrat de déploiement sans secrets
├── security/                    politiques d'audit des dépendances
└── docs/security/               architecture, menaces et gates pentest
```

Les couches `domain` ne dépendent ni de FastAPI, SQLAlchemy, stockage objet, OCR ou LLM.
Les appels Google Vision et Anthropic passent par des adapters; ils ne sont possibles que
depuis le worker.

## 2. Topologie et frontières de confiance

```text
Mobile Expo ───────┐
                   ├─ HTTPS ─> Edge TLS/WAF ─> API (1 replica) ─┬─ PostgreSQL privé
Navigateur ────────┘                 │                          ├─ S3 privé + KMS
                                     │                          └─ outbox
                                     │
                                     └─ aucun accès direct API/DB depuis Internet

Worker (réseau backend seulement) ───┬─ PostgreSQL / S3
                                     ├─ Google Vision
                                     └─ Anthropic

Job migrate (one-shot) ───────────────── PostgreSQL, puis arrêt obligatoire
```

| Frontière | Donnée admise | Contrôles repository | Preuve externe attendue |
|---|---|---|---|
| Internet → edge | HTTPS uniquement | URL mobile HTTP refusée en release | TLS/HSTS, body cap, scan TLS/WAF |
| Edge → API | HTTP privé, hôte et IP proxy connus | allowed hosts; `Origin` exact sur auth cookie; IP proxy explicite | règles réseau et normalisation `X-Forwarded-For` |
| Client → identité | mot de passe ou refresh opaque | cooldown, rotation/replay, cookies stricts, session révocable | comptes de test et secret de signature géré |
| API → PostgreSQL | requêtes applicatives | paramètres SQL, tenant context, RLS, rôle attendu non-superuser, TLS vérifié | grants du rôle et certificat DB |
| API/worker → objet | JPEG/PNG/WebP validé | limite 10 MiB, magic bytes, dimensions, clé par contenu, KMS obligatoire en prod | bucket privé, policy et clé KMS |
| Worker → IA | image/OCR utile à l'extraction | adapters dédiés, timeout/gates métier, secrets fichier | egress allow-list, clés restreintes, DPA/région |
| Image → runtime | image OCI immuable | bases par digest, UID 10001, root FS read-only, caps supprimées | digest scanné/signé et SBOM |

## 3. Rôles d'exécution

- `migrate` détient seulement le temps d'une release le droit de modifier le schéma. Un
  échec bloque le démarrage des rôles applicatifs.
- `api` sert le backoffice et `/v1` sans port hôte publié. Swagger, Redoc et OpenAPI sont
  désactivés en production. Le rate limiter MVP impose exactement une replica.
- `worker` n'expose aucun port. Il est le seul rôle qui reçoit les secrets OCR/LLM.
- PostgreSQL, S3, le reverse proxy et le gestionnaire de secrets ne font pas partie de la
  Compose applicative : ce sont des services gérés ou contrôlés indépendamment.

Tous les rôles applicatifs utilisent un UID/GID fixe, une racine en lecture seule, un tmpfs
`noexec,nosuid,nodev`, `no-new-privileges`, aucune capability Linux et des limites de PID,
mémoire et CPU. Ils ne montent jamais le socket Docker.

## 4. Contrat de configuration fail-closed

Avec `LABELSCAN_ENV=production`, le processus refuse de démarrer si un invariant manque :

- URL PostgreSQL avec `sslmode=verify-full`;
- stockage S3, chiffrement `aws:kms`, bucket/région/key ID explicites;
- JWT secret non exemple, issuer et audience explicites;
- origin HTTPS, allowed hosts et IP exactes des proxies explicites;
- version de build explicite et header-auth désactivée;
- côté worker, providers et secrets Google Vision/Anthropic présents.

Les secrets peuvent uniquement venir de `NAME` ou `NAME_FILE`, jamais des deux. Le contrat
production n'utilise que les fichiers montés dans `/run/secrets`.

## 5. Données et sessions

- Le JWT d'accès dure 15 minutes et porte `jti`, `sid`, `iss`, `aud`, acteur,
  organisation, rôle, scopes, magasins, portails métier, portail principal, code
  métier et type de client. La session serveur est vérifiée sur chaque accès protégé.
- Le refresh est une valeur opaque 256 bits, hachée en base, valable sept jours et tournée
  atomiquement. Une réutilisation révoque toute la famille.
- Mobile : les deux tokens sont dans SecureStore avec
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Navigateur : access token en mémoire, refresh dans un
  cookie `HttpOnly`, `SameSite=Strict`, `Secure` en production, limité à `/v1/auth`.
- Chaque session porte `client_type=browser|mobile`. Le navigateur accepte
  `manager`, `admin` et `super_admin`; le mobile accepte uniquement `operator`.
  Login et refresh refusent tout changement de surface.
- Logout, changement de mot de passe/rôle/affectation, reset de credential,
  désactivation de compte ou de portail révoquent les sessions concernées.
- L'image brute est persistée avant normalisation. Les historiques critiques et l'audit
  sont append-only; le tenant est imposé par ownership et RLS PostgreSQL.
- Aucun GUC applicatif n'active un accès multi-tenant. Les politiques RLS restent
  organisation-scopées même si `labelscan.system_access` est falsifié. La résolution
  initiale d'un refresh ou code d'activation passe par trois fonctions
  `SECURITY DEFINER` à `search_path` fixe qui ne renvoient que l'UUID d'organisation;
  les lignes et hashes restent ensuite protégés par RLS.

### 5.1 Matrice d'autorisation métier

Le rôle accorde une capacité; l'organisation et les affectations accordent un
périmètre de données. Les contrôles privilégiés relisent le rôle et les
affectations persistés : des claims JWT plus larges ou périmés ne suffisent pas.

| Rôle | Surface | Périmètre | Administration autorisée |
|---|---|---|---|
| `super_admin` | Navigateur | Tous les magasins et portails de son organisation | Seul rôle pouvant créer et soft-supprimer un admin; possède aussi les droits admin |
| `admin` | Navigateur | Tous les magasins et portails de son organisation | Invite/désactive les managers, affecte leurs portails, active/désactive les portails magasin; ne manipule jamais le credential d'autrui |
| `manager` | Navigateur | Portails affectés et magasins dérivés | Crée, liste, désactive, réaffecte et réinitialise les opérateurs de ses seuls portails |
| `operator` | Mobile | Un portail actif et son magasin | Aucune administration et aucun accès web |

`super_admin` reste strictement lié à une organisation : il n'existe pas de rôle
global traversant les tenants.

### 5.2 Isolation organisation × magasin × portail

Les trois professions autorisées sont `poissonnerie`, `boucherie` et
`charcuterie_traiteur`. Ce dernier code désigne un unique métier; il ne doit pas
être scindé. Un portail est identifié par l'unicité
`(organization_id, store_id, profession_code)` et désactivé par état, jamais par
suppression physique.

La politique est appliquée à plusieurs étages :

1. résolution de l'organisation depuis la route/identité signée;
2. scopes pour l'action, puis contexte d'accès pour les ids magasin/portail;
3. prédicats SQL paramétrés sur `organization_id`, `store_id` et
   `business_portal_id`;
4. RLS PostgreSQL et clés étrangères composites empêchant les associations
   inter-organisations;
5. snapshots d'organisation, magasin, portail, métier/version et acteur sur
   ingestion, lot et projection d'arrivage.

Un identifiant absent ou non visible renvoie toujours `404 NOT_FOUND`, y compris
sur les fiches et images d'arrivage, afin d'éviter l'énumération IDOR. `403
FORBIDDEN` est réservé à une action connue interdite par le rôle/scope ou à une
demande explicite de portail hors affectation. Les filtres ne peuvent jamais
élargir le périmètre signé.

### 5.3 Activation et credentials

La création d'un admin, manager ou opérateur produit un compte inactif et un
jeton d'activation opaque communiqué une seule fois. Seul son SHA-256 est stocké;
le jeton expire après 24 heures et `POST /v1/auth/activate` le consomme lors de
la définition du mot de passe. Le reset opérateur invalide d'abord le credential
et les sessions, puis utilise le même mécanisme à usage unique.

Un utilisateur peut changer uniquement son propre mot de passe via
`POST /v1/me/password`. Un manager peut émettre le reset d'un opérateur dans son
périmètre. Un admin n'a aucune route de lecture, déplacement ou réinitialisation
des credentials; un super-admin gère le cycle de vie des admins, pas leur mot de
passe. Les réponses API n'exposent jamais un hash ou un ancien secret.

## 6. Invariants de déploiement

1. Une image identifiée par digest, construite, scannée et signée.
2. Une seule replica API tant que le rate limiter et les holds restent process-local.
3. Edge seul exposé; API, DB, objet et workers privés.
4. Migration one-shot réussie avant API/worker; aucun `alembic upgrade` dans leur startup.
5. Secrets, TLS, sauvegardes, supervision et règles réseau prouvés hors Git.
6. L'inventaire `docs/backend/openapi.v1.yaml` généré depuis le commit déployé est la
   référence du périmètre pentest; l'endpoint OpenAPI runtime reste fermé.

## 7. Risques volontairement non résolus dans le MVP

- Le rate limiting n'est pas distribué : une seconde replica nécessite un contrôle edge ou
  Redis avant déploiement.
- SSO/MFA, PIN/kiosque et distribution MDM restent des travaux de phase suivante.
- L'infrastructure managée, le chiffrement effectivement activé, les DPA, la rétention,
  l'exercice PITR et la réponse à incident exigent des preuves externes.
- Le pentest peut produire de nouveaux constats; ce document n'est ni une certification ni
  une acceptation anticipée des risques.
