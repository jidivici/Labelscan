# LabelScan — architecture de sécurité de production

**Statut :** contrat de déploiement pré-pentest

**Révision :** 20 août 2026

**Sources exécutables :** `deploy/compose/production.yml` et
`deploy/compose/single-vps.yml`

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
├── deploy/                      contrats managed et mono-VPS sans secrets
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

Worker (réseau backend seulement) ───┬─ PostgreSQL / stockage brut
                                     ├─ Google Vision
                                     └─ Anthropic

Job migrate (one-shot) ───────────────── PostgreSQL, puis arrêt obligatoire
```

| Frontière | Donnée admise | Contrôles repository | Preuve externe attendue |
|---|---|---|---|
| Internet → edge | HTTPS uniquement | URL mobile HTTP refusée en release | TLS/HSTS, body cap, scan TLS/WAF |
| Edge → API | HTTP privé, hôte et IP proxy connus | allowed hosts; `Origin` exact sur auth cookie; IP proxy explicite | règles réseau et normalisation `X-Forwarded-For` |
| Client → identité | mot de passe ou refresh opaque | cooldown, rotation/replay, cookies stricts, session révocable | comptes de test et secret de signature géré |
| API → PostgreSQL | requêtes applicatives | paramètres SQL, tenant context, RLS, runtime non-superuser et non propriétaire; TLS vérifié en managed ou réseau Docker privé sur mono-VPS | grants/ownership des rôles et transport DB |
| API/worker → objet | JPEG/PNG/WebP validé | limite 10 MiB, magic bytes, dimensions, clé par contenu, KMS obligatoire en prod | bucket privé, policy et clé KMS |
| Worker → IA | image/OCR utile à l'extraction | adapters dédiés, timeout/gates métier, secrets fichier | egress allow-list, clés restreintes, DPA/région |
| Image → runtime | image OCI immuable | bases par digest, UID 10001, root FS read-only, caps supprimées | digest scanné/signé et SBOM |

## 3. Rôles d'exécution

- `migrate` reçoit l'URL du rôle propriétaire `labelscan_db_admin` seulement le temps
  d'une release. Un échec bloque le démarrage des rôles applicatifs.
- `api` sert le backoffice et `/v1` sans port hôte publié. Swagger, Redoc et OpenAPI sont
  désactivés en production. Le rate limiter MVP impose exactement une replica.
- `worker` n'expose aucun port. Il est le seul rôle qui reçoit les secrets OCR/LLM.
- En topologie managée, PostgreSQL, S3 et l'edge sont externes. Sur le mono-VPS Hostinger,
  PostgreSQL, Caddy et le volume brut sont dans la Compose durcie mais seul Caddy publie
  des ports; la base et les images restent sur le réseau/volume privés.

Tous les rôles applicatifs utilisent un UID/GID fixe, une racine en lecture seule, un tmpfs
`noexec,nosuid,nodev`, `no-new-privileges`, aucune capability Linux et des limites de PID,
mémoire et CPU. Ils ne montent jamais le socket Docker.

## 4. Contrat de configuration fail-closed

Avec `LABELSCAN_ENV=production`, le processus refuse de démarrer si un invariant manque :

- topologie `managed` : URL PostgreSQL avec `sslmode=verify-full` et stockage S3/KMS;
- topologie `single-vps` : hôte DB exact `db` et stockage brut exact `/app/data/raw`;
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
  `super_admin`, `admin` et `manager`; le mobile accepte uniquement un `manager` actif
  affecté à exactement un portail et un magasin.
  Login et refresh refusent tout changement de surface.
- Logout, changement de mot de passe/rôle/affectation, reset de credential,
  désactivation de compte ou de portail révoquent les sessions concernées.
- L'image brute est persistée avant normalisation. Les historiques critiques et l'audit
  sont append-only; le tenant est imposé par ownership et RLS PostgreSQL.
- Aucun GUC applicatif n'active un accès multi-tenant. Les politiques RLS restent
  organisation-scopées même si `labelscan.system_access` est falsifié. La résolution
  initiale d'un refresh passe par deux fonctions
  `SECURITY DEFINER` à `search_path` fixe qui ne renvoient que l'UUID d'organisation;
  les lignes et hashes restent ensuite protégés par RLS.

### 5.1 Matrice d'autorisation métier

Le rôle accorde une capacité; l'organisation et les affectations accordent un
périmètre de données. Les contrôles privilégiés relisent le rôle et les
affectations persistés : des claims JWT plus larges ou périmés ne suffisent pas.

| Rôle | Surface | Périmètre | Administration autorisée |
|---|---|---|---|
| `super_admin` | Navigateur | Tous les magasins et portails de son organisation | Seul rôle pouvant créer et soft-supprimer un admin; possède aussi les droits admin |
| `admin` | Navigateur | Tous les magasins et portails de son organisation | Ajoute/désactive les magasins, choisit leurs métiers, crée/désactive les managers et affecte leurs portails |
| `manager` | Navigateur et mobile | Son unique portail actif et le magasin dérivé | Consulte les arrivages et capture/valide les étiquettes; aucune administration d'identités |

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

### 5.3 Credentials

La création d'un admin ou manager exige un mot de passe d'au moins douze caractères et
produit un compte immédiatement actif. Les placeholders connus sont refusés.

Un utilisateur peut changer uniquement son propre mot de passe via
`POST /v1/me/password`, en fournissant obligatoirement son mot de passe actuel. Un admin
gère le cycle de vie et le portail des managers; un super-admin gère le cycle de vie des
admins. Les réponses API n'exposent jamais un hash ou un ancien secret.

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
