# Guide développeur — LabelScan

**Public :** développeur rejoignant le projet. **Prérequis de lecture :** `README.md`
(racine), puis [`ENTERPRISE-ARCHITECTURE.md`](ENTERPRISE-ARCHITECTURE.md) et les ADR.
**Révisé :** 20 août 2026.

---

## 1. Boussole — les invariants à ne jamais casser

Toute contribution est jugée contre ces règles (elles sont outillées, pas décoratives) :

1. **No-fabrication** : une donnée non lue sur l'étiquette n'existe pas (`null`), ni côté
   LLM (gate serveur) ni côté client (jamais d'auto-complétion d'une *valeur*, seulement
   des suggestions que l'humain tape/valide).
2. **Append-only** : on n'update jamais une donnée métier ; on écrit une nouvelle version
   (`extraction_run`, `source='human'`). Les triggers PG `deny_mutation` le garantissent —
   si votre migration a besoin d'un UPDATE métier, c'est un signal d'erreur de conception.
3. **Dépendances vers l'intérieur** (backend) : adapters → application → domain, contexts
   étanches. `lint-imports` casse le build sinon.
4. **Affiché == persisté** (mobile) : jamais de retouche silencieuse d'une valeur
   extraite ; les masques de saisie ne s'appliquent qu'à la frappe de l'opérateur.
5. **Sobriété UI** : pas de badge/pourcentage/score IA, couleur = état uniquement,
   libellés métier FR (voir `src/theme/` et la direction « sober SaaS »).

## 2. Ajouter une fonctionnalité

### Côté mobile

1. **Logique d'abord, pure si possible** : nouveau module dans `src/services/` sans
   import React/RN, avec tests dans `src/__tests__/`. Exemple canonique : le calendrier —
   `services/calendar.ts` (dates, comptage, grille) testé seul, avant tout rendu.
2. **Composant ensuite** dans `src/components/` : props typées, tokens du thème
   uniquement (`colors`/`spacing`/`radius`/`typography` — jamais de couleur en dur, sauf
   rampe documentée dérivée d'un token), `accessibilityRole/Label/State` systématiques.
3. **Câblage dans l'écran** : état local + `useMemo`/`useCallback` stables (les listes
   utilisent `React.memo` + `getItemLayout` — toute hauteur de header de liste doit être
   **mesurée** via `onLayout`, jamais devinée).
4. **Vérification** : `npm run typecheck` puis `npm test` (les deux doivent être verts) ;
   documenter toute vérification manuelle qui reste à faire sur appareil.
5. **Documenter** : section dans `docs/mobile/MOBILE-APP.md` lorsque le contrat vivant change.

### Côté backend

1. Choisir le **bounded context** (le plus souvent `ingestion`). Domaine pur d'abord
   (`domain/`, testable sans DB), puis use case (`application/`), puis adaptateur
   (`adapters/http` ou SQL).
2. Nouvelle table = **migration Alembic** (`server/migrations/`) ; toute table métier
   reçoit les triggers append-only (copier le modèle des migrations 0011-0013) et des
   GRANTs minimaux.
3. Nouvel endpoint = contrat d'abord : `docs/backend/API-CONTRACTS.md` +
   `openapi.v1.yaml`, erreurs au format problem+json (catalogue `platform/http/errors.py`),
   idempotence pensée dès le design (clé ou hash).
4. **Vérification** : `bash server/scripts/run_local_proofs.sh` (PG éphémère + migrations
   + import-linter + pytest). Un test d'intégration par invariant introduit.

## 3. Créer un composant — check-list

- [ ] Fichier `src/components/MonComposant.tsx`, docstring d'en-tête (rôle + décisions).
- [ ] Props explicites (pas de `any`), état minimal, callbacks stables attendus du parent.
- [ ] Tokens du thème ; texte via `typography.*` ; espacement via `spacing.*`.
- [ ] Accessibilité : rôle, label FR, état (`selected`/`expanded`/`disabled`).
- [ ] Animations : RN `Animated` natif de préférence (reanimated réservé aux gestes) ;
      discrètes (150-250 ms), jamais bloquantes.
- [ ] Toute logique non triviale extraite dans un service pur + testée.
- [ ] Hauteur fixe exportée (`FOO_HEIGHT`) si le composant vit dans une FlatList optimisée.

## 4. Conventions de code

- **Langues** : code et identifiants en **anglais** ; UI, libellés, docs métier et
  messages de commit en **français**.
- **TypeScript** : strict, zéro `any` nouveau, types API centralisés dans
  `src/types/api.ts` (miroir des contrats backend — mettre à jour les deux ensemble).
- **Python** : ruff, typage explicite aux frontières (use cases, adapters).
- **Commentaires** : docstring d'en-tête par module (rôle, décisions, renvois audit/ADR) ;
  en corps de code, commenter le *pourquoi* et les contraintes, pas le *quoi*.
- **Imports mobiles** : relatifs, I/O jamais importée depuis un service pur.
- **Nommage fichiers** : `PascalCase.tsx` composants/écrans, `camelCase.ts` services.

## 5. Workflow Git

- **Trunk-based** : branche `main` du dépôt **interne** (`LabelScan/`, jamais le
  scaffold parent) ; branches courtes `feat/…`, `fix/…` quand un travail dépasse la
  journée, sinon commits atomiques sur `main`.
- **Message** : `Zone — description` en français (ex. `Mobile — calendrier des
  arrivages : accueil scopé par journée`). Le corps explique le pourquoi + les preuves
  (tests verts, vérifications).
- **Avant tout push** : `npm run typecheck` + `npm test` + (si le backend a bougé)
  `run_local_proofs.sh`.
- **Interdits** : committer un `.env` (git-ignorés, historique vérifié sain) ; toute clé
  dans le code ou dans `EXPO_PUBLIC_*` (inliné dans le bundle, extractible).

## 6. Déploiement

**Local** : `docker compose up` — Postgres + API (uvicorn :8000) + 2 workers d'extraction.
Secrets via `server/.env`. App mobile en dev client Expo, base URL = IP LAN du serveur.

**Procédure de mise à jour** : migrations d'abord (`alembic upgrade head` — append-only,
donc toujours additives et rétrocompatibles), puis rebuild/restart des services
(`docker compose build && docker compose up -d`). Le client mobile tolère un serveur plus
vieux (anti-spin du long-poll) — déployer le serveur avant l'app.

**Production** : VPS Hostinger, TLS Caddy, services Docker privés et script
`deploy/hostinger/deploy.sh`. Le script sauvegarde PostgreSQL, applique les migrations,
recrée API/workers et vérifie `/v1/health/ready`. Ne jamais utiliser `--reset-demo`
pour une mise à jour normale.

## 7. Où chercher quoi

| Question | Document |
|---|---|
| Pourquoi ce choix technique ? | [`ENTERPRISE-ARCHITECTURE.md`](ENTERPRISE-ARCHITECTURE.md), [`architecture/adr/`](architecture/adr/) |
| Quel endpoint, quel payload ? | [`backend/API-CONTRACTS.md`](backend/API-CONTRACTS.md), `openapi.v1.yaml` |
| Quel champ, quelle validation ? | [`extraction/PROMPT-CONTRACT.md`](extraction/PROMPT-CONTRACT.md), `src/types/api.ts` |
| Comment marche l'écran X ? | [`mobile/MOBILE-APP.md`](mobile/MOBILE-APP.md) |
| Le schéma de la base ? | [`database/DATABASE.md`](database/DATABASE.md) + `server/migrations/` (source de vérité) |
| Sécurité production ? | [`security/SECURITY-ARCHITECTURE.md`](security/SECURITY-ARCHITECTURE.md), [`security/PRE-PENTEST-CHECKLIST.md`](security/PRE-PENTEST-CHECKLIST.md) |
