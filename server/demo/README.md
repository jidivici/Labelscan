# Démonstration LabelScan

La démonstration locale comprend **quatre magasins, six comptes et neuf arrivages de poissonnerie**, fondés sur les photographies d'[images](images/). Le [manifeste v2](manifest.v2.json) associe chaque image à son SHA-256 et décrit les champs présents, absents ou ambigus, avec leur évidence.

## Configuration

Depuis la racine, sur un clone neuf :

```bash
cp server/.env.example server/.env
cp server/demo/credentials.example.json server/demo/credentials.local.json
```

Renseigner les fichiers locaux avant le premier lancement :

| Fichier / variable | Valeur attendue |
|---|---|
| `server/.env` : `POSTGRES_USER` | `labelscan_app_local`, compte propriétaire utilisé par cette recette |
| `POSTGRES_PASSWORD` | Mot de passe local ; une valeur hexadécimale s'insère directement dans l'URL Compose |
| `LABELSCAN_JWT_SECRET` | Secret aléatoire d'au moins 32 octets |
| `LABELSCAN_ENV` | `development` |
| `LABELSCAN_GOOGLE_VISION_API_KEY` | Clé OCR pour analyser de nouvelles captures |
| `ANTHROPIC_API_KEY` | Clé IA pour l'extraction structurée |
| `credentials.local.json` | Les six identifiants du modèle, chacun avec un mot de passe de 12 à 128 caractères |

`openssl rand -hex 32` génère une valeur aléatoire utilisable pour un secret local. Les fichiers `.env` et `credentials.local.json` sont exclus du suivi Git. Compose utilise la base dédiée `labelscan_demo`, en remplaçant le nom de base de l'exemple.

## Lancer et parcourir

Prérequis : Docker Compose v2, ports 5432 et 8000 disponibles. Pour consulter les données préchargées, sans lancer les fournisseurs d'extraction :

```bash
docker compose --env-file server/.env config --quiet
docker compose --env-file server/.env up -d --build --wait server
docker compose --env-file server/.env ps -a
```

Ouvrir **http://localhost:8000/backoffice/o/labelscan/**. Le compte `super_admin` donne accès à l'espace global ; les comptes `manager_p_f`, `manager_p_n`, `manager_p_c` et `manager_p_m` correspondent à Fréjus, Nice, Cannes et Marseille. Les mots de passe sont ceux du fichier local.

1. Ouvrir le catalogue et choisir un arrivage.
2. Comparer la photographie et les champs de sa fiche.
3. Observer les valeurs renseignées et les décisions `NC`.
4. Filtrer la liste ou changer de périmètre selon le compte connecté.

Après configuration des clés fournisseurs, activer les quatre workers pour les nouvelles captures :

```bash
docker compose --env-file server/.env up -d --build --scale worker=4 worker
```

## Jeu de données

Le [seed](../scripts/seed_demo.py) prépare les comptes et reconstruit le catalogue de démonstration de l'organisation `labelscan`. Il cible l'environnement de démonstration dédié ; il ne constitue pas une importation additive. Il conserve les historiques source et installe les exemples à partir des images, sans appel OCR/IA.

Les [tests du jeu de données](../tests/test_demo_arrivals.py) vérifient les exemples. Le [guide du dépôt](../../docs/GUIDE-DU-DEPOT.md#environnement) décrit l'observation et l'arrêt des services sans suppression des volumes.

Le contrat d'extraction est présenté dans la [documentation technique](../../docs/TECHNICAL-DOCUMENTATION-FR.md#contrat-ia).
