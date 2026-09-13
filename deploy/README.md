# Déploiement LabelScan

Les fichiers [compose](compose/) décrivent les topologies d'exécution. Le profil managed référence une base externe et un stockage S3-compatible. Le profil single-VPS regroupe les services avec PostgreSQL et un volume privé d'images.

Le chapitre [plateforme](../docs/TECHNICAL-DOCUMENTATION-FR.md#plateforme) présente ces composants. Le chapitre [observabilité](../docs/TECHNICAL-DOCUMENTATION-FR.md#observabilite) décrit les événements, compteurs et endpoints d'exploitation.

## Fichiers et responsabilités

| Fichier | Responsabilité |
|---|---|
| [server/Dockerfile](../server/Dockerfile) | Compiler le web et assembler l'image Python/API/worker |
| [single-vps.yml](compose/single-vps.yml) | Services d'exécution : Caddy, PostgreSQL, API et workers |
| [single-vps.build.yml](compose/single-vps.build.yml) | Contexte et paramètres de construction des images VPS |
| [production.yml](compose/production.yml) | Déclaration du profil avec services de données externes |
| [production.env.example](env/production.env.example) | Noms des paramètres d'environnement du profil managed |
| [Caddyfile](caddy/Caddyfile) | Routage HTTP du proxy |
| [deploy.sh](hostinger/deploy.sh) | Mise à jour d'une installation VPS provisionnée |
| [Workflow de livraison](../.github/workflows/deploy-hostinger.yml) | Validation et livraison d'une révision Git précise |

## Cycle d'une livraison VPS

Le workflow utilise un runner Linux associé à l'environnement GitHub `production`. Il agit sur une installation existante sous `/opt/labelscan`, avec sa configuration, ses secrets, ses volumes et le wrapper de déploiement déjà provisionnés.

1. **Valider la révision** : contrôles clients et backend, migrations de test et construction des artefacts.
2. **Préparer la livraison** : vérification du checkout, sauvegarde de PostgreSQL et des images.
3. **Construire** : images identifiées par la révision Git demandée.
4. **Appliquer** : migrations, puis remise en service de l'API, des quatre workers et du proxy.
5. **Contrôler** : disponibilité HTTP, présence des quatre conteneurs workers et version publiée.

La mise à jour conserve les sauvegardes dans le répertoire privé de l'installation. Le script contient également la gestion de retour aux services précédents en cas d'échec.

## Déclenchement et configuration

Dans GitHub Actions, le workflow `deploy-hostinger` peut être lancé manuellement sur `main`. Un push ne déclenche sa livraison que si son message contient le marqueur `[deploy production]`. Une livraison courante laisse `reset_demo` vide et `fresh_build` désactivé.

Les builds du VPS réutilisent le cache Docker. L'option manuelle `fresh_build` lance une reconstruction sans cache ; les builds de contrôle de la révision restent propres. Le paramètre de réinitialisation de démo n'entre pas dans le parcours de livraison courant.

La configuration relie quatre ensembles : **version d'image**, **origine publique et routage**, **connexion aux données**, **identifiants des fournisseurs et sessions**. Les valeurs effectives appartiennent à l'environnement d'exécution ; les fichiers versionnés en décrivent les noms et les points de montage.

## Contrôles d'exploitation

| Endpoint | Information exposée |
|---|---|
| `/v1/health/live` | Présence du processus API |
| `/v1/health/ready` | Accès PostgreSQL et stockage d'objets |
| `/v1/version` | Version de l'application |

Le worker possède un contrôle de battement local, invoqué par son healthcheck Docker. Le [guide du dépôt](../docs/GUIDE-DU-DEPOT.md#livraison) distingue construction d'image, composition des services et livraison.
