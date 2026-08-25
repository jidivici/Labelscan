"""Install the local LabelScan demonstration data.

The seed is deliberately idempotent. It hides old test projections from the
catalogue, keeps the append-only source history intact, and creates nine fresh
arrivals backed by the real label photographs in ``server/demo/images``.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import text

from labelscan.business_profiles import trade_profile
from labelscan.contexts.identity.domain.password import hash_password, validate_password
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.engine import make_engine
from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.storage_factory import build_raw_store

NAMESPACE = uuid.UUID("6df40d77-d761-4a76-a259-a75209ca88bd")
DEMO_USERS = (
    "super_admin",
    "admin",
    "manager_p_f",
    "manager_p_n",
    "manager_p_c",
    "manager_p_m",
)

MANAGER_USERNAMES = {
    "FREJUS": "manager_p_f",
    "NICE": "manager_p_n",
    "CANNES": "manager_p_c",
    "MARSEILLE": "manager_p_m",
}


def stable_id(value: str) -> str:
    return str(uuid.uuid5(NAMESPACE, value))


def load_demo_passwords() -> dict[str, str]:
    """Read demo credentials from a bounded root-mounted JSON secret."""

    file_name = (os.environ.get("LABELSCAN_DEMO_CREDENTIALS_FILE") or "").strip()
    if not file_name:
        raise RuntimeError("LABELSCAN_DEMO_CREDENTIALS_FILE is required for demo data")
    path = Path(file_name)
    try:
        if path.stat().st_size > 64 * 1024:
            raise RuntimeError("demo credentials file exceeds the 64 KiB secret limit")
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("unable to read the demo credentials file") from exc
    if not isinstance(raw, dict) or set(raw) != set(DEMO_USERS):
        raise RuntimeError("demo credentials must contain exactly the six demo usernames")
    passwords: dict[str, str] = {}
    for username in DEMO_USERS:
        password = raw.get(username)
        if not isinstance(password, str):
            raise RuntimeError(f"demo password for {username} must be a string")
        validate_password(password)
        passwords[username] = password
    return passwords


@dataclass(frozen=True)
class DemoArrival:
    key: str
    city: str
    image: str
    fields: dict[str, str | None]
    flagged: bool = False
    # Demo JPEGs are stored already upright.  Runtime captures retain the
    # application's -90° default, but the catalogue must not rotate these
    # curated source images a second time.
    photo_base_rotation_degrees: int = 0


ARRIVALS = (
    DemoArrival("grondin", "NICE", "grondin-rouge.jpg", {
        "commercial_designation": "Grondin rouge", "scientific_name": "Aspitrigla cuculus",
        "producer_name": "Coopérative U Vendargues", "reseller_brand": "U Enseigne Vendargues",
        "batch_number": "15426", "origin_country": "France", "expiry_date": "2026-06-07",
        "packaging_date": "2026-06-03", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "FR 35.177.014 CE", "weight": "2,00 kg",
        "gtin": "3700161210016", "FAO_area": "FAO 27.VII",
        "production_method": "wild_caught", "fishing_gear_or_farming_method": "Chalut",
    }, True),
    DemoArrival("merlan", "FREJUS", "merlan-filet.jpg", {
        "commercial_designation": "Filet de merlan sans peau", "scientific_name": "Merlangius merlangus",
        "producer_name": "G & J Jack Seafoods", "reseller_brand": "Mericq",
        "batch_number": "F 12P", "origin_country": "Royaume-Uni", "expiry_date": "2026-06-15",
        "packaging_date": "2026-06-12", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "GB BB004", "weight": "3 kg",
        "gtin": "3700161210023", "FAO_area": "FAO 27.IVa",
        "production_method": "wild_caught", "fishing_gear_or_farming_method": "Chaluts",
    }),
    DemoArrival("julienne", "NICE", "dos-julienne.jpg", {
        "commercial_designation": "Dos de julienne", "scientific_name": "Molva molva",
        "producer_name": "Whitelink Seafoods Ltd", "reseller_brand": "SAS Mericq Agen",
        "batch_number": "400111", "origin_country": "Écosse", "expiry_date": "2026-06-20",
        "packaging_date": "2026-06-17", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "GB BB027", "weight": "3 kg",
        "gtin": "3700161210030", "FAO_area": "FAO 27",
        "production_method": "wild_caught", "fishing_gear_or_farming_method": "Chaluts de fond à panneaux (OTB)",
    }),
    DemoArrival("truite", "CANNES", "truite.jpg", {
        "commercial_designation": "Truite arc-en-ciel PAC", "scientific_name": "Oncorhynchus mykiss",
        "producer_name": "Truite de l'Ardèche", "reseller_brand": "Coopérative U Enseigne",
        "batch_number": "TRUITE-190626", "origin_country": "France", "expiry_date": "2026-06-23",
        "packaging_date": "2026-06-19", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "FR 07.019.003 UE", "weight": "2 kg",
        "gtin": "3700161210047", "FAO_area": "NC",
        "production_method": "farmed", "fishing_gear_or_farming_method": "Aquaculture",
    }),
    DemoArrival("maquereau", "CANNES", "maquereau.jpg", {
        "commercial_designation": "Maquereau 300/500", "scientific_name": "Scomber scombrus",
        "producer_name": "Mericq La Rochelle", "reseller_brand": "Pavillon France",
        "batch_number": "256541", "origin_country": "France", "expiry_date": "2026-06-18",
        "packaging_date": "2026-06-15", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "FR 17-300-147 CE", "weight": "3 kg",
        "gtin": "3700161210054", "FAO_area": "Atlantique Nord-Est",
        "production_method": "wild_caught", "fishing_gear_or_farming_method": "Chalut",
    }),
    DemoArrival("cabillaud", "MARSEILLE", "cabillaud.jpg", {
        "commercial_designation": "Dos de cabillaud sans peau", "scientific_name": "Gadus morhua",
        "producer_name": "Icelandic Seafood", "reseller_brand": "Icelandic Seafood France",
        "batch_number": "L-6152", "origin_country": "Islande", "expiry_date": "2026-06-08",
        "packaging_date": "2026-06-04", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "IS A-003 EFTA", "weight": "3 kg",
        "gtin": "3700161210061", "FAO_area": "FAO 27",
        "production_method": "wild_caught", "fishing_gear_or_farming_method": "Lignes et hameçons",
    }),
    DemoArrival("espadon", "MARSEILLE", "espadon-longe.jpg", {
        "commercial_designation": "Longe d'espadon", "scientific_name": "Xiphias gladius",
        "producer_name": "Médi-Pêche Set", "reseller_brand": "Médi-Pêche Distribution",
        "batch_number": "107083-21526", "origin_country": "France", "expiry_date": "2026-08-12",
        "packaging_date": "2026-08-03", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "FR 34-108-593 CE", "weight": "4,500 kg",
        "gtin": "3700161210078", "FAO_area": "FAO 27.VIII",
        "production_method": "wild_caught", "fishing_gear_or_farming_method": "Palangres calées",
    }),
    DemoArrival("encornet", "MARSEILLE", "encornet-rouge.jpg", {
        "commercial_designation": "Encornet rouge", "scientific_name": "Illex coindetii",
        "producer_name": "Michel Marée", "reseller_brand": "U Enseigne Vendargues",
        "batch_number": "MM215", "origin_country": "France", "expiry_date": "2026-08-10",
        "packaging_date": "2026-08-03", "storage_temperature": "0 à 2 °C",
        "allergens": "Mollusques", "health_mark": "FR 34.108.534 CE", "weight": "3,000 kg",
        "gtin": "3700161210085", "FAO_area": "FAO 37.1",
        "production_method": "wild_caught", "fishing_gear_or_farming_method": "Chaluts de fond à panneaux OTB",
    }),
    DemoArrival("saumon", "FREJUS", "saumon.jpg", {
        "commercial_designation": "Saumon fjord 4/5", "scientific_name": "Salmo salar",
        "producer_name": "Salmo Salar", "reseller_brand": "Coopérative U Vendargues",
        "batch_number": "26167", "origin_country": "Norvège", "expiry_date": "2026-06-14",
        "packaging_date": "2026-06-10", "storage_temperature": "0 à 2 °C",
        "allergens": "Poisson", "health_mark": "FR 85.001.002 CE", "weight": "8,830 kg",
        "gtin": "3700161210092", "FAO_area": "NC",
        "production_method": "farmed", "fishing_gear_or_farming_method": "Élevage en Norvège",
    }),
)


def audit(conn, actor_id: str, action: str) -> None:
    set_audit_context(conn, actor_id=actor_id, action=action,
                      correlation_id="labelscan-demo", trace_id="labelscan-demo")


def upsert_user(conn, organization_id: str, username: str, role: str,
                password: str, created_by: str, store_id: str | None = None,
                store_code: str | None = None) -> str:
    user_id = stable_id(f"user:{username}")
    audit(conn, created_by, "identity.demo_user_seeded")
    conn.execute(text("""
        INSERT INTO identity.app_user
            (id, organization_id, organization_code, username, display_name,
             password_hash, role, active, store_id, store_code, created_by)
        VALUES (:id, :org, 'labelscan', :username, :username, :password_hash,
                :role, true, :store_id, :store_code, :created_by)
        ON CONFLICT (organization_id, username) WHERE deleted_at IS NULL DO UPDATE SET
            display_name=excluded.display_name, password_hash=excluded.password_hash,
            role=excluded.role, active=true, store_id=excluded.store_id,
            store_code=excluded.store_code, updated_at=clock_timestamp()
    """), {"id": user_id, "org": organization_id, "username": username,
            "password_hash": hash_password(password),
            "role": role, "store_id": store_id, "store_code": store_code,
            "created_by": created_by})
    return str(conn.execute(text("SELECT id FROM identity.app_user WHERE organization_id=:org AND username=:username AND deleted_at IS NULL"),
                            {"org": organization_id, "username": username}).scalar_one())


def seed() -> None:
    demo_passwords = load_demo_passwords()
    image_dir = Path(os.environ.get("LABELSCAN_DEMO_IMAGE_DIR", "/app/demo/images"))
    image_content: dict[str, tuple[str, bytes]] = {}
    demo_contract = set(trade_profile("poissonnerie").fields)
    for arrival in ARRIVALS:
        if set(arrival.fields) != demo_contract or any(
            value is None or not str(value).strip() for value in arrival.fields.values()
        ):
            raise RuntimeError(
                f"demo arrival {arrival.key} must contain all {len(demo_contract)} V2 fields"
            )
        content = (image_dir / arrival.image).read_bytes()
        checksum = hashlib.sha256(content).hexdigest()
        image_content[arrival.key] = (checksum, content)

    engine = make_engine()
    with engine.begin() as conn:
        organization_id = str(conn.execute(text("SELECT id FROM identity.organization WHERE slug='labelscan'")).scalar_one())
        raw_store = build_raw_store()
        images = {
            key: (
                checksum,
                raw_store.put(
                    content,
                    checksum=checksum,
                    organization_id=organization_id,
                ),
            )
            for key, (checksum, content) in image_content.items()
        }
        set_tenant_context(conn, organization_id)
        bootstrap_actor = conn.execute(text("SELECT id::text FROM identity.app_user WHERE organization_id=:org AND active=true ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END LIMIT 1"), {"org": organization_id}).scalar_one_or_none()
        bootstrap_actor = bootstrap_actor or stable_id("user:super_admin")
        super_id = upsert_user(conn, organization_id, "super_admin", "super_admin", demo_passwords["super_admin"], bootstrap_actor)
        admin_id = upsert_user(conn, organization_id, "admin", "admin", demo_passwords["admin"], super_id)

        # Keep the historic Fréjus store so its append-only history stays valid;
        # present every active store with a clear city name.
        existing = conn.execute(text("SELECT id::text, code FROM identity.store WHERE organization_id=:org ORDER BY created_at LIMIT 1"), {"org": organization_id}).first()
        stores: dict[str, tuple[str, str, str]] = {}
        for city, label in (("FREJUS", "Fréjus"), ("NICE", "Nice"), ("CANNES", "Cannes"), ("MARSEILLE", "Marseille")):
            store_id = existing[0] if city == "FREJUS" and existing else stable_id(f"store:{city}")
            code = existing[1] if city == "FREJUS" and existing else city
            audit(conn, admin_id, "identity.demo_store_seeded")
            conn.execute(text("""
                INSERT INTO identity.store (id, organization_id, organization_code, code, name, active, created_by)
                VALUES (:id, :org, 'labelscan', :code, :name, true, :created_by)
                ON CONFLICT (organization_id, code) DO UPDATE SET
                    name=excluded.name, active=true, created_by=excluded.created_by, updated_at=clock_timestamp()
            """), {"id": store_id, "org": organization_id, "code": code, "name": label, "created_by": admin_id})
            store_id = str(conn.execute(text("SELECT id FROM identity.store WHERE organization_id=:org AND code=:code"), {"org": organization_id, "code": code}).scalar_one())
            portal_id = stable_id(f"portal:{city}:poissonnerie")
            conn.execute(text("""
                INSERT INTO identity.business_portal
                    (id, organization_id, store_id, profession_code, name, active, created_by)
                VALUES (:id, :org, :store_id, 'poissonnerie', :name, true, :created_by)
                ON CONFLICT (organization_id, store_id, profession_code) DO UPDATE SET
                    name=excluded.name, active=true, updated_at=clock_timestamp()
            """), {"id": portal_id, "org": organization_id, "store_id": store_id,
                    "name": f"Poissonnerie · {label}", "created_by": admin_id})
            portal_id = str(conn.execute(text("SELECT id FROM identity.business_portal WHERE organization_id=:org AND store_id=:store_id AND profession_code='poissonnerie'"), {"org": organization_id, "store_id": store_id}).scalar_one())
            stores[city] = (store_id, code, portal_id)

        managers: dict[str, str] = {}
        for city in stores:
            store_id, code, portal_id = stores[city]
            username = MANAGER_USERNAMES[city]
            manager_id = upsert_user(conn, organization_id, username, "manager",
                                     demo_passwords[username], admin_id, store_id, code)
            audit(conn, admin_id, "identity.demo_manager_assigned")
            conn.execute(text("UPDATE identity.user_portal_assignment SET active=false, updated_at=clock_timestamp() WHERE organization_id=:org AND user_id=:user_id AND portal_id<>:portal_id AND active=true"), {"org": organization_id, "user_id": manager_id, "portal_id": portal_id})
            conn.execute(text("""
                INSERT INTO identity.user_portal_assignment
                    (id, organization_id, user_id, portal_id, created_by, active)
                VALUES (:id, :org, :user_id, :portal_id, :created_by, true)
                ON CONFLICT (user_id, portal_id) DO UPDATE SET active=true, updated_at=clock_timestamp()
            """), {"id": stable_id(f"assignment:{username}"), "org": organization_id,
                    "user_id": manager_id, "portal_id": portal_id, "created_by": admin_id})
            managers[city] = manager_id


        demo_names = DEMO_USERS
        audit(conn, super_id, "identity.legacy_demo_accounts_deactivated")
        conn.execute(text("""
            UPDATE identity.app_user SET active=false, updated_at=clock_timestamp()
            WHERE organization_id=:org AND username <> ALL(CAST(:names AS text[])) AND active=true
        """), {"org": organization_id, "names": list(demo_names)})
        conn.execute(text("UPDATE identity.auth_session SET revoked_at=COALESCE(revoked_at, clock_timestamp()) WHERE organization_id=:org"), {"org": organization_id})

        # arrival_projection is a rebuildable read model. Removing its old local
        # test rows does not mutate the append-only ingestion or traceability log.
        conn.execute(text("DELETE FROM traceability.arrival_projection WHERE organization_id=:org"), {"org": organization_id})
        now = datetime.now(timezone.utc)
        for index, arrival in enumerate(ARRIVALS):
            store_id, code, portal_id = stores[arrival.city]
            actor_id = managers[arrival.city]
            checksum, image_ref = images[arrival.key]
            ingestion_id = stable_id(f"ingestion:{arrival.key}")
            run_id = stable_id(f"run:{arrival.key}")
            batch_id = stable_id(f"batch:{arrival.key}")
            correlation = f"demo-{arrival.key}"
            recorded_at = now - timedelta(days=index)
            audit(conn, actor_id, "ingestion.demo_arrival_seeded")
            conn.execute(text("""
                INSERT INTO ingestion.ingestion
                    (id, status, image_ref, checksum_sha256, client_captured_at,
                     correlation_id, trace_id, store_code, organization_id, store_id,
                     business_portal_id, trade_code_snapshot, trade_profile_version, captured_by_user_id,
                     photo_rotation_degrees, photo_base_rotation_degrees)
                VALUES (:id, 'confirmed', :image_ref, :checksum, :recorded_at,
                        :correlation, :correlation, :code, :org, :store_id, :portal_id,
                        'poissonnerie', '2', :actor_id, 0, :photo_base_rotation_degrees)
                ON CONFLICT (id) DO UPDATE SET
                    status='confirmed',
                    image_ref=excluded.image_ref,
                    checksum_sha256=excluded.checksum_sha256,
                    client_captured_at=excluded.client_captured_at,
                    store_code=excluded.store_code,
                    organization_id=excluded.organization_id,
                    store_id=excluded.store_id,
                    business_portal_id=excluded.business_portal_id,
                    trade_code_snapshot=excluded.trade_code_snapshot,
                    trade_profile_version=excluded.trade_profile_version,
                    captured_by_user_id=excluded.captured_by_user_id,
                    photo_rotation_degrees=excluded.photo_rotation_degrees,
                    photo_base_rotation_degrees=excluded.photo_base_rotation_degrees
            """), {"id": ingestion_id, "image_ref": image_ref, "checksum": checksum,
                    "recorded_at": recorded_at, "correlation": correlation, "code": code,
                    "org": organization_id, "store_id": store_id, "portal_id": portal_id,
                    "actor_id": actor_id,
                    "photo_base_rotation_degrees": arrival.photo_base_rotation_degrees})
            conn.execute(text("""
                INSERT INTO ingestion.raw_artifact
                    (id, occurred_at, ingestion_id, artifact_kind, storage_ref,
                     checksum_sha256, correlation_id, trace_id, organization_id)
                SELECT :id, :recorded_at, :ingestion_id, 'image', :image_ref,
                       :checksum, :correlation, :correlation, :org
                WHERE NOT EXISTS (SELECT 1 FROM ingestion.raw_artifact WHERE ingestion_id=:ingestion_id AND artifact_kind='image' AND checksum_sha256=:checksum)
            """), {"id": stable_id(f"artifact:{arrival.key}"), "recorded_at": recorded_at,
                    "ingestion_id": ingestion_id, "image_ref": image_ref, "checksum": checksum,
                    "correlation": correlation, "org": organization_id})
            conn.execute(text("""
                INSERT INTO ingestion.extraction_run
                    (id, ingestion_id, attempt_no, outcome, extractor_version, prompt_version,
                     ocr_provider, llm_model, rule_set_version, correlation_id, trace_id, created_at)
                VALUES (:id, :ingestion_id, 1, 'extracted', 'demo-1', 'demo-1',
                        'manual-demo', 'manual-demo', 'demo-1', :correlation, :correlation, :recorded_at)
                ON CONFLICT (id) DO NOTHING
            """), {"id": run_id, "ingestion_id": ingestion_id, "correlation": correlation, "recorded_at": recorded_at})
            fields = arrival.fields
            conn.execute(text("""
                INSERT INTO traceability.batch
                    (id, lot_code, species_scientific, fao_area_code, production_method,
                     use_by, packaging_date, status, source_ingestion_id, source_extraction_run_id,
                     correlation_id, trace_id, created_at, store_code, organization_id, store_id,
                     business_portal_id, trade_code_snapshot, trade_profile_version, captured_by_user_id)
                VALUES (:id, :lot, :scientific, :fao, :method, CAST(:use_by AS date), CAST(:packaging AS date),
                        :status, :ingestion_id, :run_id, :correlation, :correlation, :recorded_at,
                        :code, :org, :store_id, :portal_id, 'poissonnerie', '2', :actor_id)
                ON CONFLICT (id) DO UPDATE SET
                    lot_code=excluded.lot_code,
                    species_scientific=excluded.species_scientific,
                    fao_area_code=excluded.fao_area_code,
                    production_method=excluded.production_method,
                    use_by=excluded.use_by,
                    packaging_date=excluded.packaging_date,
                    status=excluded.status,
                    source_extraction_run_id=excluded.source_extraction_run_id,
                    store_code=excluded.store_code,
                    organization_id=excluded.organization_id,
                    store_id=excluded.store_id,
                    business_portal_id=excluded.business_portal_id,
                    trade_code_snapshot=excluded.trade_code_snapshot,
                    trade_profile_version=excluded.trade_profile_version,
                    captured_by_user_id=excluded.captured_by_user_id
            """), {"id": batch_id, "lot": fields["batch_number"], "scientific": fields["scientific_name"],
                    "fao": fields["FAO_area"], "method": fields["production_method"], "use_by": fields["expiry_date"],
                    "packaging": fields["packaging_date"], "status": "flagged" if arrival.flagged else "registered",
                    "ingestion_id": ingestion_id, "run_id": run_id, "correlation": correlation,
                    "recorded_at": recorded_at, "code": code, "org": organization_id,
                    "store_id": store_id, "portal_id": portal_id, "actor_id": actor_id})
            conn.execute(text("""
                INSERT INTO traceability.arrival_projection
                    (batch_id, organization_id, store_id, store_code, ingestion_id,
                     extraction_run_id, revision_no, fields, image_ref, image_checksum,
                     recorded_at, updated_at, business_portal_id, trade_code_snapshot,
                     trade_profile_version, captured_by_user_id)
                VALUES (:batch_id, :org, :store_id, :code, :ingestion_id, :run_id, 1,
                        CAST(:fields AS jsonb), :image_ref, :checksum, :recorded_at, :recorded_at,
                        :portal_id, 'poissonnerie', '2', :actor_id)
            """), {"batch_id": batch_id, "org": organization_id, "store_id": store_id,
                    "code": code, "ingestion_id": ingestion_id, "run_id": run_id,
                    "fields": json.dumps(fields, ensure_ascii=False), "image_ref": image_ref,
                    "checksum": checksum, "recorded_at": recorded_at, "portal_id": portal_id,
                    "actor_id": actor_id})

    print(f"LabelScan demo installed: 4 city stores, 6 accounts, {len(ARRIVALS)} photographed arrivals")


if __name__ == "__main__":
    seed()
