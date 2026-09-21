# Serveur LabelScan

Le serveur FastAPI expose les sessions, captures, extractions, revues et arrivages. Les workers relient les traitements métier par une outbox PostgreSQL.

La [documentation technique](../docs/TECHNICAL-DOCUMENTATION-FR.md#modules) décrit les modules ; les chapitres [pipeline](../docs/TECHNICAL-DOCUMENTATION-FR.md#pipeline) et [API](../docs/TECHNICAL-DOCUMENTATION-FR.md#api) présentent les échanges.

Le contrat complet est l'[inventaire OpenAPI](../docs/backend/openapi.v1.yaml). Les sources sont dans [src/labelscan](src/labelscan/), le schéma dans [migrations](migrations/) et les scénarios dans [tests](tests/).

## Démarrage avec Docker

Le [parcours de démonstration](demo/README.md) fournit la configuration commune, une base dédiée et les comptes. Il construit également le back-office. La variante ci-dessous sert au développement Python dans un terminal.

## Exécution hors Docker

Prérequis : Python 3.12, Node.js 22.13+ dans la branche 22, Docker Compose v2 et le fichier `server/.env` configuré selon le [guide local](demo/README.md#configuration). Python s'exécute dans le terminal et PostgreSQL dans Docker. Les commandes suivantes partent de la racine et créent une base distincte de la démo.

```bash
docker compose --env-file server/.env up -d --wait db
docker compose --env-file server/.env exec -T db \
  sh -c 'createdb -U "$POSTGRES_USER" labelscan_dev'
npm --prefix web ci
npm --prefix web run build

cd server
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes -r requirements-dev.lock
python -m pip install --no-deps -e .
```

La création de `labelscan_dev` et du virtualenv s'effectue une seule fois. Charger le fichier local au format shell, puis adapter les chemins hors conteneur :

```bash
set -a
. ./.env
set +a
export LABELSCAN_ENV=development
export DATABASE_URL="postgresql+psycopg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/labelscan_dev"
export LABELSCAN_OBJECT_STORE=filesystem
export LABELSCAN_RAW_STORE_DIR="$PWD/.local-archive/raw"
export LABELSCAN_STATIC_DIR="$PWD/../web/dist"
python -m alembic upgrade head
```

Renseigner `LABELSCAN_ADMIN_USERNAME` et `LABELSCAN_ADMIN_PASSWORD` dans l'environnement pour créer le compte initial, puis lancer l'API sur le port 8000 disponible :

```bash
python -m labelscan.contexts.identity.adapters.cli
python -m uvicorn labelscan.app.http_app:create_app \
  --factory --host 0.0.0.0 --port 8000 \
  --no-proxy-headers --no-server-header --no-date-header
```

Le [back-office local](http://localhost:8000/backoffice/) utilise cette même API. Après une modification web, `npm --prefix web run build`, depuis la racine, actualise ses fichiers. Dans un second terminal chargé avec le même environnement et les clés fournisseurs, le worker se lance depuis `server/` par `python -m labelscan.app.worker_runtime`.

## Tests

Depuis `server/`, avec le virtualenv activé :

```bash
lint-imports
ruff check .
LABELSCAN_ENV=test python scripts/export_openapi.py --check
```

Pour la suite complète, le [runner local](scripts/run_local_proofs.sh) crée une base temporaire, applique les migrations puis lance les tests. Depuis la racine, avec le virtualenv activé et PostgreSQL 16 installé :

```bash
PG_BIN=/opt/homebrew/opt/postgresql@16/bin \
PGPORT=54329 LABELSCAN_ENV=test \
bash server/scripts/run_local_proofs.sh
```

`PG_BIN` désigne le répertoire réel des binaires PostgreSQL ; le chemin ci-dessus correspond à Homebrew sur macOS Apple Silicon. Le port choisi doit être libre. Le script ferme sa base temporaire à la fin. La [CI backend](../.github/workflows/backend-ci.yml) vérifie aussi la réversibilité des migrations sur une base de test.

## Lire le code

[Couches et domaines](../docs/GUIDE-DU-DEPOT.md#serveur) · [Une revue de bout en bout](../docs/GUIDE-DU-DEPOT.md#parcours-code) · [Données et API](../docs/GUIDE-DU-DEPOT.md#donnees-api)
