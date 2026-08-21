# Synthèse des règles de sécurité de production

**Statut :** règles bloquantes pour une release

**Dernière révision :** 20 août 2026

Ce document résume les contrôles exécutables. Les détails de conception et les preuves
externes restent dans `SECURITY-ARCHITECTURE.md` et `PRE-PENTEST-CHECKLIST.md`.

## Exposition réseau et routes

- Seul Caddy publie les ports HTTP/HTTPS; API, PostgreSQL, workers et volumes ne publient
  aucun port hôte.
- HTTP redirige vers HTTPS; HSTS est présent. Android/iOS de release refusent une URL API
  non HTTPS et Android de release refuse le trafic en clair.
- Toutes les routes métier exigent un JWT signé et une session serveur active. Les
  en-têtes `X-Actor-*` ne sont jamais une authentification de production.
- `/docs`, `/redoc` et `/openapi.json` répondent `404` en production. La readiness ne
  révèle pas ses contrôles internes.
- L'origine des opérations d'authentification navigateur doit correspondre exactement à
  l'origine publique. Une origine absente/étrangère est refusée selon le type de client.
- Les hôtes et proxies sont explicitement autorisés. Les en-têtes forwardés ne sont crus
  que lorsque le pair réseau appartient au réseau privé Caddy configuré.
- Les erreurs ne révèlent ni existence d'un compte, ni tenant étranger, ni secret, OCR,
  prompt ou contenu d'image.

## Authentification et autorisation

- Access token court, refresh opaque haché et rotation atomique; un replay révoque la
  famille de sessions.
- Mobile : jetons dans SecureStore limité à l'appareil. Web : access token en mémoire et
  refresh en cookie `HttpOnly`, `Secure`, `SameSite=Strict`, chemin restreint.
- Les rôles, scopes, organisation, magasin et portail sont relus côté serveur. Un JWT
  falsifié ou périmé ne peut pas élargir les droits persistés.
- Un identifiant hors périmètre renvoie `404`; `403` est réservé à une action connue mais
  interdite. Cela évite l'énumération IDOR.
- Toute désactivation, réaffectation, modification de rôle ou de mot de passe révoque les
  sessions concernées.
- Le login, refresh et endpoints sensibles sont limités en débit. Une seule replica API
  est autorisée tant que ce contrôle reste local au processus.

## Base de données et données

- Le rôle runtime est distinct du rôle propriétaire/migrateur, sans `SUPERUSER`,
  `CREATEDB`, `CREATEROLE`, `REPLICATION` ni `BYPASSRLS`.
- Le runtime n'est propriétaire d'aucune table et ne peut jamais utiliser l'URL de
  migration. Les migrations échouent si cet invariant n'est pas prouvé.
- RLS et clés étrangères composites isolent organisation, magasin et portail. Toutes les
  requêtes sont paramétrées; aucun fragment SQL ne provient directement d'un champ client.
- Images brutes, journal d'audit et historiques critiques sont append-only. Les mutations
  interdites sont refusées par grants, triggers et tests PostgreSQL.
- Les migrations sont un job unique réussi avant API/workers. Elles ne sont jamais lancées
  dans le démarrage normal des services.
- Une sauvegarde cohérente de PostgreSQL et des images brutes précède chaque déploiement;
  les images demo et volumes sont conservés sauf reset explicitement demandé.

## Ingestion et champs

- Le serveur impose les limites de taille, type MIME/magic bytes, dimensions, UUID,
  longueurs, listes fermées, dates, quantités et états; le client n'est jamais la source
  de confiance.
- Tous les textes OCR/LLM et champs corrigés sont traités comme des données, jamais comme
  des instructions, noms de colonne, HTML ou SQL. Ils sont normalisés et validés par des
  schémas fermés avant persistance/projection.
- L'organisation, magasin, portail, acteur, version du métier et identifiants de trace sont
  dérivés de l'identité autorisée ou vérifiés côté serveur, jamais acceptés aveuglément.
- Une extraction sans champ canonique réellement exploitable ne peut être revue ni
  finalisée. Elle porte l'état `recapture_required`; le mobile indique que la photo ne
  correspond pas et ouvre une nouvelle capture guidée.
- La reprise supprime uniquement la tentative/photo locale concernée. Elle ne modifie pas
  une ingestion distante déjà acceptée et conserve les protections d'idempotence.
- Une finalisation exige les champs métier minimaux et une décision humaine traçable; les
  données brutes ou prompts ne sont jamais écrits dans les journaux.

## Secrets et fournisseurs

- Aucun secret dans Git, l'image, les logs, le navigateur ou une variable
  `EXPO_PUBLIC_*`. Les fichiers secrets sont root-only et montés uniquement au composant
  qui en a besoin.
- API : URL DB runtime et clé JWT. Worker : URL DB runtime et clés OCR/LLM nécessaires.
  Migrate : URL DB admin seulement. Le profil VPS local ne transmet pas d'identifiants AWS
  inutilisés à l'API.
- Toute valeur trouvée en clair est tournée avant production. La procédure et les effets
  de révocation sont dans `SECRET-ROTATION.md`.
- Les appels fournisseurs ont timeout, validation, quota/budget et erreurs neutralisées;
  aucun secret ou contenu brut n'est journalisé.

## Conteneurs, dépendances et mobile Android 13

- Images applicatives de base par digest; processus applicatifs UID/GID non root; système
  de fichiers en lecture seule; tmpfs `noexec,nosuid,nodev`; capabilities supprimées;
  `no-new-privileges`; limites PID/mémoire/CPU; aucun socket Docker.
- Android minimum API 33 (Android 13), Expo SDK 54, mêmes contrats API et règles métier que
  sur iOS. Le build release active minification/réduction et interdit le cleartext.
- Le check Expo, typecheck, tests mobile/web/backend, audit de dépendances, scan de secrets,
  tests PostgreSQL/RLS et build Android release sont des portes de release.
- Les avis élevés Expo/Metro temporairement acceptés sont limités aux outils de build,
  documentés et expirent le 2 septembre 2026. Toute nouvelle vulnérabilité élevée/critique
  ou exception expirée bloque la CI. Le portail web doit rester à zéro vulnérabilité.

## Critère « production verrouillée »

La release est refusée si un seul contrôle suivant échoue : tests PostgreSQL réels,
configuration fail-closed, séparation des rôles DB, scan des dépendances/secrets, build
Android, smoke tests publics, snapshot/sauvegarde ou conservation des images. Après
déploiement, `npm run security:production -- https://label-scan.fr` doit être intégralement
vert et une capture réelle doit être validée sur Android 13/API 33 avant de déclarer la
parité complète avec iOS.
