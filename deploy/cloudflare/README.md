# Cloudflare pour LabelScan

`label-scan.fr` reste exécuté sur le VPS derrière Caddy. Cloudflare sert de proxy
TLS, de protection DDoS/WAF et de limiteur de débit. Aucun Worker ni projet Pages
n'est requis pour cette architecture ; Wrangler n'est donc pas une dépendance du
projet et ne constitue pas la source de vérité de ces réglages de zone.

## État appliqué le 14 septembre 2026

- TLS minimum 1.2 et TLS 1.3 activé ;
- chiffrement d'origine `Full (strict)` après validation des certificats Let's
  Encrypt de `label-scan.fr` et `www.label-scan.fr` sur le VPS ;
- redirection `Always Use HTTPS` activée ;
- règles Cloudflare Free Managed et DDoS L7 actives ;
- `/v1` exempté uniquement de Browser Integrity Check et Security Level : le WAF
  géré, les règles personnalisées et les limites de débit continuent de s'appliquer ;
- méthodes HTTP étrangères à l'API bloquées sans challenge ;
- limite partagée de 10 requêtes par 10 secondes et par IP/centre Cloudflare sur
  les connexions web, organisation et mobile, avec blocage pendant 10 secondes.

La politique relue depuis l'API est conservée dans
`security-policy.json`. Les instantanés avant/après et la recette publique datée
servent de preuves d'exploitation, pas de mécanisme automatique d'application.

## Recette publique

La commande suivante ne possède aucun identifiant et n'effectue aucune mutation
applicative réussie :

```bash
python3 deploy/cloudflare/verify-public.py
```

Le contrôle plus intrusif ci-dessous provoque volontairement un bref blocage des
routes de connexion pour l'IP appelante :

```bash
python3 deploy/cloudflare/verify-public.py --exercise-rate-limit
```

Utiliser un Python lié à OpenSSL récent pour tester TLS 1.0 à 1.3. Le Python
système de certaines versions de macOS utilise LibreSSL et ne sait pas proposer
TLS 1.3 dans cette sonde.

Les clients JSON envoient `Accept: application/json`. Cloudflare renvoie une erreur
structurée pour la limitation de débit. Sur l'offre Free, un blocage WAF personnalisé
peut rester HTML ; les clients traduisent alors le statut en `HTTP_403` sans essayer
d'afficher ou de résoudre une page de challenge.
