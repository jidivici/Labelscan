# Observer la sécurité de Labelscan

Ce guide accompagne les journaux structurés et les protections du dépôt. Leur présence dans Git ne prouve pas leur activation sur le VPS. Après une livraison, vérifier la révision publique, les paramètres effectifs et un événement témoin dans les journaux.

## Avant un pentest

1. Confirmer le périmètre, la fenêtre UTC, les comptes de test, leurs rôles et les IP de départ. Garder les protections actives et identifier les sondes avec `X-Correlation-Id` ; cet identifiant est une aide de recherche, pas une preuve d'identité.
2. Vérifier MFA sur Hostinger, Cloudflare, GitHub et les comptes administrateurs applicatifs ; tester la révocation des sessions et conserver des moyens de récupération.
3. Vérifier Cloudflare : TLS minimum 1.2, Full (strict) après validation du certificat d'origine, redirection HTTPS, règles WAF et limites couvrant les connexions web, organisation et mobile. Les clients mobiles doivent recevoir des réponses API exploitables, sans challenge navigateur obligatoire.
4. Vérifier la fermeture de l'origine aux sources non autorisées sur IPv4 **et** IPv6, le SSH par clés, les ports PostgreSQL/API internes, les mises à jour et les sauvegardes restaurables hors VPS.
5. Exécuter `sudo bash deploy/hostinger/security-audit.sh` sur le VPS. Le script affiche les paramètres effectifs, les connexions SSH et les métadonnées des conteneurs sans afficher les valeurs des secrets. Certaines commandes requièrent root ; une sortie absente ou une erreur reste un contrôle non validé.
6. Préserver les journaux avant la livraison : la rotation Docker borne le disque mais ne conserve pas les traces d'un conteneur supprimé. Utiliser un collecteur externe avec accès restreint et stockage protégé contre l'effacement, ou exporter une copie privée avant remplacement. La rotation locale n'assure pas une durée de conservation garantie.

## Voir les IP actives et les signaux

Depuis le checkout du VPS, après déploiement des corrections :

```bash
export LABELSCAN_VERSION="$(curl --fail --silent https://label-scan.fr/v1/version | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
docker compose -f /opt/labelscan/config/compose.yml logs \
  --follow --no-log-prefix --no-color --since 2m api caddy \
  | python3 scripts/security-watch.py
```

Une synthèse JSON sort toutes les dix secondes : IP ayant produit des événements dans la dernière minute, volumes séparés API/proxy, échecs d'authentification et signaux d'alerte. Le mot « active » désigne ici une IP observée dans la fenêtre, pas une session encore connectée. Le script produit uniquement des alertes dans le terminal ; il ne configure aucun envoi de notification ni collecte persistante.

Les seuils d'observation initiaux sont : 5 échecs de login ou de refresh par IP/minute ; 10 réponses du même type parmi 401/403/404/413/429 par IP/couche/minute ; 5 réponses 5xx ; 300 requêtes par IP/couche/minute. Les adapter au trafic réel et aux IP NAT. Un signal peut venir d'un bug client ou du test autorisé ; il ne prouve pas une compromission.

La fenêtre est bornée à 50 000 événements. `discarded_due_to_capacity > 0` signifie que les chiffres deviennent partiels et que la collecte doit être renforcée. Le script ignore les événements vieux de plus d'une minute, les dates incohérentes et les lignes mal formées. Il ne remplace pas un SIEM ni une investigation.

Pour conserver les preuves, envoyer séparément les lignes JSON complètes vers le collecteur privé. Ne pas se limiter aux synthèses. Préserver les horodatages UTC, les identifiants de corrélation et les éventuels identifiants Cloudflare, avec la configuration et la révision déployées.

## Événements utiles

| Événement | Utilisation |
|---|---|
| `auth_login_succeeded` | Acteur, organisation, famille de session, type de client, IP et compte pseudonymisé |
| `auth_login_failed` | Tentative refusée, IP et clé de compte pseudonymisée ; ne distingue pas compte inconnu/mauvais mot de passe |
| `auth_refresh_succeeded` / `auth_refresh_failed` | Renouvellement accepté/refusé ; un refus seul ne distingue pas expiration et rejeu |
| `auth_logout_requested` | Demande de déconnexion ; ne prétend pas qu'un jeton fourni était valide |
| `http_request` | Méthode, chemin sans query string, statut, latence, IP et acteur résolu lorsque disponible |
| `rate_limited` | Protection déclenchée et délai avant nouvelle tentative |
| Journaux Caddy JSON | Visibilité des refus au proxy et des redirections avant l'application |

Les mots de passe, cookies, en-têtes d'autorisation et corps de requêtes ne sont pas ajoutés aux nouveaux événements. Les en-têtes et paramètres de requête sont retirés des journaux d'accès Caddy. Uvicorn n'émet plus son journal d'accès brut ; les événements applicatifs prennent le relais. Les IP et identifiants de comptes restent des données sensibles à accès restreint.

## Attribution correcte de l'IP

Caddy accepte `CF-Connecting-IP` seulement si le pair appartient aux plages officielles Cloudflare. Il remplace ensuite `X-Forwarded-For` par cette IP résolue. L'API ne fait confiance qu'aux proxys configurés et remonte la chaîne depuis le dernier saut ; un saut mal formé fait revenir au pair réseau. Vérifier et resserrer `LABELSCAN_TRUSTED_PROXIES` sur le réseau/IP réellement utilisé par Caddy. Maintenir les plages Cloudflare à jour.

À la recette, comparer deux clients de réseaux différents ; chacun doit avoir son IP réelle dans `client_ip`. Une requête avec des en-têtes d'IP forgés doit garder l'IP réelle. Le refus de l'origine doit être vérifié indépendamment de cette attribution.

## Limites applicatives par défaut

| Protection | Seuil |
|---|---|
| Toute requête HTTP, en production | 600/minute/IP |
| Connexion, toutes tentatives comprises | 5/minute/IP |
| Connexion distribuée sur un même compte | 20/minute/compte |
| Vérifications de mots de passe globales | 120/minute/processus |
| Échecs de connexion par compte | Pause 60 s après 5 échecs |
| Refresh/logout | 30/minute/IP |
| Ingestions authentifiées | 60/10 min et 360/h/acteur |
| Autres mutations authentifiées | 600/h/acteur |
| Long polling | 4 attentes/acteur, 100 au total |

Les variables de configuration sont décrites dans `server/.env.example`. Les compteurs restent locaux à un processus et sont remis à zéro au redémarrage. Avant plusieurs réplicas API, utiliser un stockage de compteurs partagé et atomique. Conserver une limite au niveau Cloudflare pour absorber le trafic avant qu'il consomme le CPU/bande passante du VPS. Les limites par IP peuvent toucher plusieurs utilisateurs derrière un NAT : suivre les 429 avant ajustement.

## Inventorier les sessions encore valides

Les IP historiques n'existent pas dans la table actuelle des sessions. Corréler les nouvelles traces de connexion via `session_family_id` ; les sessions antérieures à la livraison n'auront pas ces traces. Une liste des sessions valides n'est pas une preuve de présence en ligne. Pour l'inventaire, exécuter cette lecture depuis une connexion PostgreSQL d'exploitation autorisée, sans exposer les hash des refresh tokens :

```sql
SELECT s.organization_id, s.user_id, s.family_id, s.client_type,
       min(s.created_at) AS first_record_at,
       max(s.refresh_expires_at) AS expires_at
FROM identity.auth_session s
JOIN identity.app_user u ON u.id = s.user_id
WHERE s.revoked_at IS NULL AND s.consumed_at IS NULL
  AND s.refresh_expires_at > clock_timestamp() AND u.active
GROUP BY s.organization_id, s.user_id, s.family_id, s.client_type
ORDER BY first_record_at DESC;
```

Les politiques RLS restent applicables : utiliser le contexte d'organisation approprié ou le rôle d'exploitation autorisé. Ne pas donner ces droits au rôle API pour faciliter une inspection.

## Réagir pendant le test

En cas de signal inattendu, corréler IP, heure, compte, statut, révision et identifiant de requête avec les opérateurs du test. Préserver les preuves avant de redémarrer. Si une compromission est confirmée, contenir la source ou le compte, révoquer les sessions concernées et renouveler les secrets effectivement exposés. Vérifier ensuite l'impact sur les autres organisations et les fournisseurs OCR/IA. Toute règle de blocage doit conserver un accès d'exploitation et être retestée sur le mobile et le web.

## Références

- [OWASP — journalisation de sécurité](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OWASP — authentification](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Caddy — journaux et filtres](https://caddyserver.com/docs/caddyfile/directives/log)
- [Cloudflare — Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
