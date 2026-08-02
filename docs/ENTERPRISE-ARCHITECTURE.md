# Architecture entreprise LabelScan

## Principes

Le backend FastAPI reste un monolithe modulaire stateless. PostgreSQL est la
source de vérité des organisations, magasins, utilisateurs, ingestions,
révisions et arrivages. Les images sont stockées dans un bucket S3 compatible
privé ; l’adaptateur fichier est réservé au développement.

```text
Mobile Expo ── HTTPS/JWT ──┐
                           ├── API FastAPI stateless ── PostgreSQL managé
Web React ─── HTTPS/JWT ───┘              │
                                         ├── outbox ── workers indépendants
                                         └── bucket objet privé et versionné
```

Les contextes `identity`, `ingestion`, `traceability` et `haccp` ne
s’importent jamais entre eux. Ils échangent des identifiants et des événements
via l’outbox. Les adaptateurs de stockage partagés vivent dans `platform`.

## Isolation des organisations

- `organization_id` est présent sur les magasins, utilisateurs, ingestions,
  artefacts, lots et projections de catalogue.
- Le JWT contient `organization_id`, `organization_slug`, `store_id` et
  `store_code`. L’API n’accepte jamais un tenant arbitraire dans le corps d’une
  requête métier.
- Les identifiants visibles `username` et `store.code` sont uniques dans leur
  organisation. La clé métier d’un lot inclut également l’organisation.
- Tous les adaptateurs ajoutent un prédicat de tenant. PostgreSQL RLS constitue
  une seconde barrière sur chaque table possédée par un tenant.
- Le rôle de connexion de production doit hériter de `labelscan_app`, sans être
  propriétaire des tables et sans `BYPASSRLS`. Le rôle de migration reste
  distinct.
- Les workers utilisent uniquement le contexte système transactionnel pour
  relayer l’outbox ; les consommateurs réappliquent l’organisation portée par
  l’événement.

## Synchronisation mobile

1. La capture est persistée côté serveur avec sa photo avant le `202`.
2. L’extraction crée des runs et champs append-only.
3. La validation mobile enregistre d’abord une opération locale
   `finalize_review`.
4. `POST /v1/ingestions/{id}/reviews` écrit les 17 champs, confirme
   l’ingestion et publie `review.finalized` dans une transaction unique.
5. La clé d’idempotence est liée au SHA-256 canonique de la requête. Un rejeu
   identique retourne le même run ; une réutilisation différente retourne
   `409 IDEMPOTENCY_KEY_CONFLICT`.
6. L’opération est rejouée au démarrage, au retour au premier plan et au retour
   du réseau. L’arrivage reste « En attente de synchronisation » jusqu’au succès.
7. Le catalogue mobile est relu depuis l’API et conservé dans le cache
   persistant TanStack Query.

Une désinstallation du téléphone ne supprime donc ni la fiche ni la photo.

## Catalogue courant et historique

`extraction_run` et `extracted_field` restent immuables. La table mutable
`traceability.arrival_projection` contient uniquement la dernière projection
lisible. Le consommateur `review.finalized` la met à jour et incrémente
`revision_no`, sans modifier les runs précédents.

Le web lit `/v1/arrivals`, `/v1/arrivals/{batch_id}` et l’image autorisée
séparément. Un opérateur ne voit que son magasin ; un administrateur voit tous
les magasins de son organisation.

## Stockage objet

Variables de production :

```text
LABELSCAN_OBJECT_STORE=s3
LABELSCAN_S3_BUCKET=...
LABELSCAN_S3_REGION=...
LABELSCAN_S3_ENDPOINT_URL=...        # facultatif pour un S3 compatible
LABELSCAN_S3_ENCRYPTION=aws:kms      # ou AES256
LABELSCAN_S3_KMS_KEY_ID=...          # si aws:kms
```

Les clés suivent
`organizations/{organization_id}/sha256/{préfixe}/{sha256}`. L’adaptateur
vérifie le SHA-256 à l’écriture et à la lecture. Le bucket doit bloquer l’accès
public, activer le chiffrement et le versioning.

La copie initiale s’effectue après les migrations additives :

```bash
python /app/scripts/migrate_raw_store_to_s3.py
```

Le script relit chaque objet après envoi et refuse la bascule si une somme
diffère. Conserver le volume fichier en lecture seule jusqu’à la fin de cette
vérification.

## Déploiement

Ordre recommandé :

1. sauvegarde PostgreSQL et test de restauration ponctuelle ;
2. migrations additives `0018` à `0023` et contrôle du backfill ;
3. configuration du bucket, copie vérifiée des photos ;
4. déploiement de l’API stateless et des workers ;
5. déploiement du web React ;
6. déploiement mobile opérateur avec outbox `finalize_review` ;
7. retrait progressif des anciennes lectures locales après observation.

`/v1/health/ready` contrôle PostgreSQL et le stockage sélectionné. Les logs JSON
portent les corrélations, l’organisation, la latence du catalogue, les retries
et les dead letters. Les alertes de production doivent couvrir :

- âge et volume de la file outbox, retries et dead letters ;
- erreurs `DEPENDENCY_UNAVAILABLE` du stockage objet ;
- p95/p99 de `catalog_query.latency_ms` ;
- erreurs HTTP regroupées par `organization_id` ;
- opérations mobiles durablement en erreur, remontées par la télémétrie du
  client mobile.

## Validation de référence

- migrations exécutées depuis une base vide jusqu’à `0023` ;
- 284 tests backend, dont RLS inter-organisation, identifiants devinés,
  finalisation atomique, rejeu sans doublon et S3 ;
- 214 tests mobile et typecheck TypeScript ;
- 5 contrats d’architecture conservés ;
- build React et contrôle visuel à 320, 768 et 1440 px, sans dépassement de
  `scrollWidth`.
