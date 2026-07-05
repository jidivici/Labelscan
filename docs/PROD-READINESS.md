# LabelScan — Synthèse prod-readiness : ce qui manque pour vendre à un grand groupe

**Date :** 3 juillet 2026
**Public :** décision produit/technique interne (préparation d'un dossier commercial grand compte)
**Hypothèse de vente :** un groupe agroalimentaire / GMS multi-sites (criées, ateliers de marée,
plateformes logistiques) qui déploie LabelScan comme outil de traçabilité HACCP à la réception.

---

## 1. Ce que le produit sait faire aujourd'hui (acquis, vérifié)

Le cœur métier est **complet, testé et architecturé au-dessus des standards d'un MVP** :

- **Chaîne scan → extraction → revue → persistance auditable** : GS1-128 déterministe +
  OCR Vision + LLM Haiku (sortie structurée, gate anti-fabrication, escalade Opus bornée),
  réconciliation où le code-barres gagne, corrections humaines append-only `source='human'`,
  confirmation de revue (`POST /confirm`), audit DB non contournable (triggers SECURITY DEFINER).
- **Latence perçue travaillée en profondeur** : soumission spéculative, cascade 3 vagues
  (GS1 → regex déterministes → LLM), long-poll serveur, animations de révélation. L'opérateur
  voit l'écran se remplir en continu.
- **Résilience réelle** : outbox transactionnelle + DLQ côté serveur (workers `SKIP LOCKED`),
  outbox durable côté mobile avec drain au foreground et **idempotence de bout en bout**
  (clé client stable → dédup serveur, migration 0013).
- **Qualité d'ingénierie** : monolithe modulaire 6 bounded contexts, import-linter,
  239 tests backend + 144 tests mobile, CI, migrations Alembic (13), contrats documentés.

C'est un **excellent pilote mono-site**. Ce qui suit est ce qui sépare ce pilote d'un
contrat grand compte.

---

## 2. Les manques, par domaine (bloquant → différable)

### 2.1 Identité & contrôle d'accès — **BLOQUANT**
État actuel : **un seul compte admin** (`LABELSCAN_ADMIN_USERNAME`/`PASSWORD` en env), JWT
signé par un secret partagé, pas de gestion d'utilisateurs.
Un grand groupe exigera :
- [ ] **Comptes opérateurs individuels** (l'audit HACCP doit nommer QUI a validé — aujourd'hui
  tous les scans portent le même actor). C'est aussi une exigence réglementaire d'auditabilité.
- [ ] **SSO d'entreprise** (SAML/OIDC — Entra ID est le standard de facto en agro) + provisioning
  (SCIM ou a minima admin UI).
- [ ] **RBAC** : opérateur (scan/revue), responsable qualité (alertes, exports, overrides),
  admin site, admin groupe. Les scopes JWT existent déjà — c'est le bon socle, il manque la
  couche de gestion.
- [ ] Rotation des secrets (JWT, clés API) sans redéploiement ; verrouillage/expiration de session.
**Effort : L (2-4 semaines). C'est le manque n°1.**

### 2.2 Multi-tenant / multi-sites — **BLOQUANT**
État actuel : une base = un déploiement = un site. Aucune notion d'organisation, de site,
ni de cloisonnement.
- [ ] Modèle **organisation → sites → utilisateurs** ; chaque ingestion rattachée à un site.
- [ ] Choix d'isolation : schéma-par-tenant ou colonne `tenant_id` + RLS Postgres. Vu
  l'architecture append-only + triggers existante, **RLS + tenant_id** est le chemin le moins
  invasif ; à décider AVANT d'écrire la migration (coûteux à changer après).
- [ ] Agrégations groupe : un responsable qualité national veut voir tous les sites.
**Effort : L-XL (3-6 semaines selon l'option d'isolation).**

### 2.3 Infrastructure & exploitation — **BLOQUANT**
État actuel : docker-compose local, Postgres non managé, raw store sur volume disque,
secrets dans `.env`, pas de métriques agrégées, pas d'alerting.
- [ ] **Hébergement production UE** (exigence quasi systématique) : Postgres managé + backups
  testés (PITR), stockage objet S3-compatible pour le raw store (le port existe), secrets
  manager, IaC (Terraform), environnements dev/staging/prod.
- [ ] **Observabilité** : les logs structurés existent (bon socle) mais il manque la stack —
  agrégation (Loki/Datadog), métriques (latence par étape, taux d'échec, profondeur DLQ,
  hit-rate cache prompt, taux d'escalade, coût/scan), alerting + astreinte.
- [ ] **SLO/SLA chiffrés** : un grand compte demandera ≥ 99,5 % dispo + RPO/RTO documentés.
  Rien n'est mesuré aujourd'hui. Le long-poll sync (thread tenu) impose de dimensionner
  l'API ou de passer LISTEN/NOTIFY (Tier 2) au-delà de ~30 devices simultanés par instance.
- [ ] **CI/CD déploiement** (la CI teste, elle ne déploie pas) : build image, migration
  automatique avec plan de rollback, blue/green ou rolling.
- [ ] **Plan de charge** : aucun test de charge n'existe. Cible réaliste à valider :
  50 scans/min en pointe multi-sites (réception matinale).
**Effort : L-XL (3-6 semaines) + coût récurrent d'exploitation.**

### 2.4 Conformité & contractuel — **BLOQUANT (juridique, pas du code)**
- [ ] **RGPD** : registre des traitements, DPA signable, politique de rétention (photos
  d'étiquettes = données pro, mais l'audit log porte des identités), procédure d'effacement,
  sous-traitants listés (Anthropic, Google Vision — **les deux traitent les images/textes :
  il faut les DPA correspondants et une mention explicite** ; option : régionalisation UE des
  appels API si exigée).
- [ ] **Dossier sécurité** : pentest tiers + remédiation, chiffrement au repos (DB + objet),
  TLS partout, politique de logs (déjà bonne : allow-list anti-fuite), plan de réponse à
  incident. Un grand groupe enverra un questionnaire sécurité de 200 lignes — le préparer
  une fois (SIG-Lite / CAIQ) sert pour tous les prospects.
- [ ] **Conformité métier** : export réglementaire des registres de réception (format
  inspectable DDPP), durée de rétention traçabilité (souvent 5 ans), horodatage fiable.
- [ ] **Contractuel** : SLA, plafonds de responsabilité, assurance RC pro / cyber,
  réversibilité (export complet des données du client à la sortie).
**Effort : M en interne + prestataires (pentest, juridique). Long en délai — démarrer tôt.**

### 2.5 Fiabilité IA en continu — **IMPORTANT (différenciant en avant-vente)**
État actuel : gate anti-fabrication + calibration + suite d'éval **documentées**, mais
l'éval n'est pas exécutée en continu et le golden set est embryonnaire.
- [ ] **Golden set réel** (200-500 étiquettes annotées, multi-fournisseurs, multi-langues) +
  exécution de l'éval en CI et à chaque changement de prompt/modèle (les seuils SC1-SC10
  existent déjà sur le papier — les rendre exécutoires).
- [ ] **Monitoring qualité prod** : taux de `needs_review`, taux d'override humain par champ
  (= taux d'erreur réel), dérive dans le temps. C'est AUSSI l'argument commercial : « voici
  notre précision mesurée, champ par champ ».
- [ ] **Mode dégradé** : panne Vision ou Anthropic → aujourd'hui l'ingestion finit en
  `extraction_failed` et la photo est conservée (bien) ; il manque la re-soumission
  automatique en lot au retour du service (Batches API, −50 % de coût).
- [ ] Plafond de coût par tenant + facturation interne du coût IA/scan.
**Effort : M (2-3 semaines) — forte valeur en démo.**

### 2.6 Application mobile : distribution & durcissement — **IMPORTANT**
État actuel : app Expo lancée via Metro/Expo Go, pas de build de distribution, pas de
crash reporting, stockage AsyncStorage.
- [ ] **Builds EAS signés** + distribution entreprise (MDM type Intune/Workspace ONE — les
  grands groupes ne passent pas par les stores publics pour un outil métier) + mise à jour
  OTA maîtrisée (expo-updates, canaux staging/prod).
- [ ] **Crash/erreur reporting** (Sentry) + télémétrie latence réelle terrain.
- [ ] **SQLite** : brancher `SqliteArticleStore` (port prêt) — indispensable au-delà de
  quelques milliers d'articles par device.
- [ ] Durcissement device partagé : verrouillage par PIN opérateur (lié à 2.1), mode kiosque.
- [ ] i18n si le groupe a des sites hors France (l'app est fr-only).
**Effort : M-L (2-4 semaines).**

### 2.7 Intégrations SI — **IMPORTANT (souvent LA condition d'achat)**
Un grand compte n'achète pas un silo : la donnée de réception doit rejoindre son ERP/QMS.
- [ ] **API d'export/webhooks** documentée (OpenAPI existe — la compléter) : arrivages
  confirmés, alertes, non-conformités, au fil de l'eau ou en batch (CSV/JSON, SFTP au pire).
- [ ] Connecteurs à la demande (SAP QM, outils qualité type Normea/Qualnet) — à traiter en
  services, pas en produit, mais l'API générique doit exister.
- [ ] Référentiels du client : catalogue fournisseurs/espèces attendues par site
  (améliore aussi l'extraction : autocomplétion + validation croisée).
**Effort : M pour l'API générique ; connecteurs = par contrat.**

---

## 3. Chemin critique proposé

| Phase | Contenu | Objectif commercial | Durée indicative |
|---|---|---|---|
| **A — Durcir le socle** | 2.1 comptes/RBAC + 2.3 infra prod UE + backups + observabilité de base | Pouvoir dire « c'est en production » et signer un **pilote payant mono-site** | 4-6 semaines |
| **B — Pilote grand compte** | 2.5 golden set + métriques qualité + 2.6 builds MDM + Sentry + SQLite | Un site réel en conditions réelles, chiffres de précision/latence opposables | 4-6 semaines (en parallèle du pilote) |
| **C — Contrat groupe** | 2.2 multi-tenant/multi-sites + 2.1 SSO + 2.7 API d'intégration + 2.4 dossier sécurité/DPA/pentest | Déploiement multi-sites contractualisé avec SLA | 6-10 semaines |

**Trois décisions à prendre tôt** (coûteuses à changer après) :
1. Modèle d'isolation multi-tenant (RLS vs schéma) — conditionne toutes les migrations suivantes.
2. Hébergeur/région UE + posture sous-traitants IA (DPA Anthropic/Google, éventuelle
   régionalisation des appels) — conditionne le dossier RGPD.
3. Distribution mobile (MDM vs stores) — conditionne la chaîne de build et le rythme de MAJ.

**Ordre de grandeur global : ~3-5 mois d'ingénierie** (1-2 devs seniors + prestataires
ponctuels pentest/juridique) entre l'état actuel et un déploiement groupe contractualisable.
Le différenciateur à mettre en avant en avant-vente : l'architecture d'intégrité (append-only,
audit non contournable, no-fabrication gate, idempotence bout-en-bout) est **déjà** au niveau
attendu — c'est l'inverse du prototype IA habituel, et c'est vérifiable dans le code.
