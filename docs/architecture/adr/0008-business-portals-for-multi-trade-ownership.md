# ADR-0008: Business portals as the multi-trade ownership boundary

## Status
Accepted & Implemented

## Context
LabelScan originally treated a store as the only business access boundary and
assumed a seafood workflow. One organization and one physical store can now run
several regulated trades with different extraction fields, operational teams,
and traceability views. A store-only role or a free-form trade label would let
authorization and historical records drift apart.

The implemented trades are exactly:

- `poissonnerie`;
- `boucherie`;
- `charcuterie_traiteur`.

`charcuterie_traiteur` is one combined profession. Splitting it into two codes
would create incompatible assignments, filters, and historical ownership.

## Decision
Model a **business portal** as the unique
`(organization_id, store_id, profession_code)` unit.

- `super_admin` is organization-wide. An `admin` is bounded to portals of the
  stores it owns. Neither may cross an organization boundary.
- The assignable roles are exactly `super_admin`, `admin`, and `manager`.
- A `manager` has exactly one active portal assignment; its visible store and
  profession are derived from that portal. It may use the browser and mobile
  surfaces.
- The historical database value `operator` is retained only so old migrations
  and immutable records remain interpretable. Production authentication rejects
  it and no current HTTP route can assign it.
- Capabilities (scopes) and data perimeter are separate checks. A valid scope
  never broadens the organization/store/portal predicate.
- Access tokens carry canonical store and portal ids plus the primary portal and
  trade code. Privileged IAM writes still re-read persisted roles and
  assignments.
- Ingestion and traceability rows snapshot organization, store, portal,
  profession code, trade-profile version, and capture actor. Later assignment
  changes do not move historical records.
- Portals and assignments use soft activation. Runtime APIs do not physically
  delete them; disabling a portal revokes sessions of assigned users.
- Hidden or foreign resources return the same `404`; `403` represents a known
  action forbidden by role/scope or an explicit out-of-assignment request.

## Consequences

- **Positive:** one consistent ownership key scopes arrivals, images, alerts,
  traceability, IAM lists, and filters.
- **Positive:** a physical store can expose all three trades without duplicating
  store records or widening a manager's access.
- **Positive:** immutable snapshots preserve the meaning of historical data when
  portals, profiles, or staff assignments change.
- **Positive:** composite foreign keys and PostgreSQL RLS provide a database
  boundary in addition to HTTP authorization.
- **Cost:** every portal-owned write and query must propagate and validate more
  identifiers than a store-only model.
- **Cost:** stale access tokens must be revoked when an assignment or portal
  changes; authorization cannot rely only on JWT scopes.

## Alternatives considered

1. **Keep store-only authorization and filter by a trade string.** Rejected:
   filters are not an authorization boundary and cannot isolate teams sharing a
   store.
2. **Create one store per profession.** Rejected: it duplicates the physical
   directory, fragments reporting, and misrepresents a single establishment.
3. **Create separate `charcuterie` and `traiteur` portals.** Rejected: the agreed
   operational domain is one combined profession and one field profile.
4. **Make super-admin platform-global.** Rejected: it would bypass tenant
   isolation and enlarge the blast radius of one credential.

## Trade-offs
The design trades simpler store-only queries for explicit, auditable multi-trade
ownership. That additional dimension is accepted because it prevents accidental
cross-profession access and keeps historical traceability stable.

## Reversibility
**Medium.** New professions can be added additively through a versioned profile
and portal backfill. Removing or splitting a profession is deliberately harder:
historical snapshots and assignments must remain interpretable, so such a change
requires a new ADR and an expand/backfill/contract migration rather than a code
rename.
