# Serveur LabelScan

Le serveur FastAPI expose les sessions, captures, extractions, revues et arrivages. Les workers relient les traitements métier par une outbox PostgreSQL.

La [documentation technique](../docs/TECHNICAL-DOCUMENTATION-FR.md#modules) décrit les modules ; les chapitres [pipeline](../docs/TECHNICAL-DOCUMENTATION-FR.md#pipeline) et [API](../docs/TECHNICAL-DOCUMENTATION-FR.md#api) présentent les échanges.

Le contrat complet est l'[inventaire OpenAPI](../docs/backend/openapi.v1.yaml). Les sources sont dans [src/labelscan](src/labelscan/), le schéma dans [migrations](migrations/) et les scénarios dans [tests](tests/).
