# Rotation des mots de passe et secrets de production

**Statut :** procédure d'exploitation obligatoire

**Dernière révision :** 20 août 2026

Cette procédure ne contient aucune valeur secrète. Une valeur ayant été copiée dans un
terminal partagé, une capture, un ticket ou un fichier local en clair doit être considérée
comme compromise et remplacée.

## Principes

1. Effectuer une sauvegarde PostgreSQL et des images brutes avant toute rotation.
2. Tourner un secret à la fois, vérifier le service, puis révoquer l'ancienne valeur.
3. Générer au moins 48 octets aléatoires avec un gestionnaire de secrets ou, sur le VPS,
   `openssl rand -hex 48`.
4. Conserver les fichiers sous `/opt/labelscan/secrets`, propriétaire `root:root`, mode
   `0600`. Ne jamais les placer dans Git, une image Docker ou une variable `EXPO_PUBLIC_*`.
5. Écrire d'abord un nouveau fichier temporaire de mode `0600`, puis le renommer de façon
   atomique. Ne jamais modifier un secret partiellement pendant qu'un conteneur le lit.
6. Après chaque rotation : redémarrer uniquement les composants consommateurs, passer les
   tests de santé et d'autorisation, puis contrôler les journaux sans afficher la valeur.

## Inventaire et portée

| Secret | Consommateur autorisé | Effet d'une rotation |
|---|---|---|
| mot de passe `labelscan_db_admin` | PostgreSQL et job `migrate` seulement | aucune coupure API si l'URL runtime est distincte |
| mot de passe runtime `labelscan_app` | API, workers et job demo | reconnexion DB des conteneurs applicatifs |
| `LABELSCAN_JWT_SECRET` | API seulement | invalide tous les jetons et impose une reconnexion |
| clé Google Vision | workers seulement | suspend l'OCR pendant leur redémarrage |
| clé Anthropic | workers seulement | suspend l'extraction LLM pendant leur redémarrage |
| identifiants AWS | seulement les rôles utilisant réellement AWS | réinitialise les connexions au service concerné |
| mots de passe utilisateurs | identité LabelScan | révoque les sessions du compte modifié |

Le mobile ne reçoit que l'URL publique HTTPS. Les jetons de session sont conservés dans
SecureStore; aucune clé fournisseur, DB, JWT ou AWS ne doit être compilée dans Android/iOS.

## PostgreSQL sur le VPS

La production utilise deux rôles séparés :

- `labelscan_db_admin` : rôle de propriété/migration, jamais fourni à l'API;
- `labelscan_app` : login runtime non propriétaire, sans superuser, `BYPASSRLS`, création
  de rôle/base ni réplication; il porte seulement les grants applicatifs.

Les fichiers sont :

- `/opt/labelscan/secrets/db_admin_password`;
- `/opt/labelscan/secrets/db_runtime_password`;
- `/opt/labelscan/secrets/database_admin_url` pour `migrate`;
- `/opt/labelscan/secrets/database_url` pour API/workers/demo.

### Rotation du runtime sans changer l'administrateur

1. Créer un nouveau mot de passe hexadécimal dans un fichier temporaire de mode `0600`.
2. En session PostgreSQL locale administrateur, exécuter `ALTER ROLE labelscan_app
   PASSWORD '<nouvelle valeur>';` sans écrire la valeur dans l'historique shell.
3. Créer la nouvelle URL `postgresql+psycopg://labelscan_app:<mot-de-passe>@db:5432/labelscan`
   dans un fichier temporaire. Une valeur contenant d'autres caractères que l'hexadécimal
   doit être encodée pour une URL.
4. Remplacer atomiquement `db_runtime_password` et `database_url`.
5. Recréer API et workers, vérifier readiness, login, route protégée, ingestion et RLS.

La base doit être changée avant les conteneurs : les connexions existantes continuent
temporairement, tandis que les nouvelles utilisent immédiatement le nouveau secret.

### Rotation de l'administrateur/migrateur

1. Générer la nouvelle valeur et exécuter localement `ALTER ROLE labelscan_db_admin
   PASSWORD '<nouvelle valeur>';` via le socket PostgreSQL du conteneur.
2. Remplacer atomiquement `db_admin_password` et `database_admin_url`.
3. Lancer le job `migrate` en mode vérification et confirmer qu'il peut lire la révision
   Alembic. Ne jamais redémarrer l'API avec cette URL.

Les valeurs ne doivent pas apparaître sur la ligne de commande. Utiliser un fichier root
temporaire ou l'outil de rotation contrôlé du déploiement, puis le supprimer.

## Secret de signature JWT

1. Générer une valeur aléatoire d'au moins 48 octets.
2. Remplacer atomiquement `/opt/labelscan/secrets/jwt_secret`.
3. Recréer l'API et vérifier login, refresh et route protégée.
4. Informer les utilisateurs qu'ils doivent se reconnecter : le modèle HS256 actuel ne
   conserve qu'une clé active et tous les anciens access tokens deviennent invalides.
5. Révoquer/expirer les sessions serveur existantes si la rotation répond à un incident.

## Google Vision et Anthropic

Pour chaque fournisseur, séparément :

1. Créer une nouvelle clé côté fournisseur, limitée au projet/API requis, aux quotas
   attendus et, si disponible, aux adresses de sortie du VPS.
2. Mettre à jour le fichier secret lu uniquement par les workers.
3. Recréer les workers et valider une image de test contrôlée de bout en bout.
4. Vérifier les erreurs, quotas et coûts, puis révoquer l'ancienne clé.

Une clé qui a existé en clair dans un poste de développement doit être tournée avant la
mise en production, même si le fichier était exclu de Git.

## Identifiants AWS

Préférer un rôle temporaire à une clé longue durée. Si une clé est nécessaire : créer une
nouvelle clé sur un utilisateur dédié à droits minimaux, mettre à jour le fichier
`aws_credentials`, redémarrer les seuls consommateurs, vérifier l'accès minimal, puis
désactiver et supprimer l'ancienne clé. Le profil Hostinger avec stockage brut sur volume
local ne justifie pas de transmettre des identifiants AWS à l'API.

## Mots de passe utilisateurs

- Chaque utilisateur change son propre mot de passe via `POST /v1/me/password`, avec son
  mot de passe actuel. La modification révoque ses sessions.
- Les administrateurs créent/désactivent les managers; chaque manager change ensuite son
  propre mot de passe avec le mot de passe actuel.
- Un mot de passe comporte au minimum 12 caractères et au maximum 128; les valeurs exemple
  connues sont refusées. Utiliser une phrase de passe unique générée par un gestionnaire.
- Ne jamais modifier directement le hash en base sauf procédure de reprise d'incident
  approuvée et auditée.

## Preuve après rotation

Conserver uniquement : date, opérateur, identifiant du secret, composants redémarrés,
résultat des tests et date de révocation de l'ancienne valeur. Ne conserver ni la valeur,
ni son préfixe, ni une capture du portail fournisseur.
