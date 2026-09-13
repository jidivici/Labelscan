# Plateforme LabelScan

Les fichiers [compose](compose/) décrivent les topologies d'exécution. Le profil managed référence une base externe et un stockage S3-compatible. Le profil single-VPS regroupe les services avec PostgreSQL et un volume privé d'images.

Le chapitre [plateforme](../docs/TECHNICAL-DOCUMENTATION-FR.md#plateforme) présente ces composants. Le chapitre [observabilité](../docs/TECHNICAL-DOCUMENTATION-FR.md#observabilite) décrit les événements, compteurs et endpoints d'exploitation.

Les scripts de déploiement sont versionnés dans [hostinger](hostinger/).

Les déploiements courants réutilisent désormais le cache Docker du VPS afin
d'éviter de retélécharger et recompiler Caddy, PostgreSQL et les dépendances à
chaque livraison. Le workflow manuel GitHub Actions propose l'option
`fresh_build` pour forcer une reconstruction complète, à utiliser après une
mise à jour de base ou pour un diagnostic de cache. Les contrôles de sécurité
de la CI continuent, eux, à effectuer des builds propres sans cache.
