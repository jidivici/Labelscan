--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: compliance; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA compliance;


--
-- Name: haccp; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA haccp;


--
-- Name: identity; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA identity;


--
-- Name: ingestion; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ingestion;


--
-- Name: platform; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA platform;


--
-- Name: traceability; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA traceability;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: auth_session_organization_for_family(uuid, uuid); Type: FUNCTION; Schema: identity; Owner: -
--

CREATE FUNCTION identity.auth_session_organization_for_family(candidate_family uuid, candidate_user uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'identity'
    SET row_security TO 'off'
    AS $$
            SELECT session.organization_id
            FROM identity.auth_session AS session
            WHERE session.family_id = candidate_family
              AND session.user_id = candidate_user
            LIMIT 1
        $$;


--
-- Name: auth_session_organization_for_token(text); Type: FUNCTION; Schema: identity; Owner: -
--

CREATE FUNCTION identity.auth_session_organization_for_token(candidate_hash text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'identity'
    SET row_security TO 'off'
    AS $$
            SELECT session.organization_id
            FROM identity.auth_session AS session
            WHERE session.refresh_token_hash = candidate_hash
            LIMIT 1
        $$;


--
-- Name: audit_on_insert(); Type: FUNCTION; Schema: platform; Owner: -
--

CREATE FUNCTION platform.audit_on_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor  text := nullif(current_setting('labelscan.actor_id',       true), '');
    v_action text := nullif(current_setting('labelscan.action',         true), '');
    v_corr   text := nullif(current_setting('labelscan.correlation_id', true), '');
    v_trace  text := nullif(current_setting('labelscan.trace_id',       true), '');
    v_actor_uuid uuid;
    v_root   oid  := COALESCE(pg_partition_root(TG_RELID), TG_RELID);
    v_schema text;
    v_table  text;
BEGIN
    IF v_actor IS NULL OR v_action IS NULL OR v_corr IS NULL OR v_trace IS NULL THEN
        RAISE EXCEPTION
            'audit context missing: SET LOCAL labelscan.{actor_id,action,correlation_id,trace_id} is required before writing %.%',
            TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'raise_exception';
    END IF;
    -- strict validation: a malformed actor cannot be recorded (anti-spoof)
    BEGIN
        v_actor_uuid := v_actor::uuid;
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid audit context: actor_id is not a uuid (got %)', v_actor
            USING ERRCODE = 'raise_exception';
    END;
    IF length(v_action) > 128 OR length(v_corr) > 200 OR length(v_trace) > 200 THEN
        RAISE EXCEPTION 'invalid audit context: field exceeds length bound'
            USING ERRCODE = 'raise_exception';
    END IF;
    -- record the LOGICAL parent table (never the physical partition)
    SELECT n.nspname, c.relname INTO v_schema, v_table
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = v_root;
    INSERT INTO audit.audit_log
        (occurred_at, actor_id, action, subject_schema, subject_table, subject_id,
         correlation_id, trace_id)
    VALUES
        (clock_timestamp(), v_actor_uuid, v_action, v_schema, v_table,
         NEW.id, v_corr, v_trace);
    RETURN NULL;
END $$;


--
-- Name: default_organization_id(); Type: FUNCTION; Schema: platform; Owner: -
--

CREATE FUNCTION platform.default_organization_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'identity'
    AS $$
          SELECT id FROM identity.organization WHERE slug = 'labelscan'
        $$;


--
-- Name: deny_mutation(); Type: FUNCTION; Schema: platform; Owner: -
--

CREATE FUNCTION platform.deny_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
    BEGIN
        RAISE EXCEPTION
            'append-only violation: % on %.% is forbidden (immutable historical record)',
            TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'restrict_violation';
    END $$;


SET default_tablespace = '';

--
-- Name: audit_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    subject_schema text NOT NULL,
    subject_table text NOT NULL,
    subject_id uuid,
    correlation_id text NOT NULL,
    trace_id text NOT NULL
)
PARTITION BY RANGE (occurred_at);


SET default_table_access_method = heap;

--
-- Name: audit_log_2026_06; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_log_2026_06 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    subject_schema text NOT NULL,
    subject_table text NOT NULL,
    subject_id uuid,
    correlation_id text NOT NULL,
    trace_id text NOT NULL
);


--
-- Name: audit_log_2026_07; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_log_2026_07 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    subject_schema text NOT NULL,
    subject_table text NOT NULL,
    subject_id uuid,
    correlation_id text NOT NULL,
    trace_id text NOT NULL
);


--
-- Name: audit_log_default; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.audit_log_default (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    subject_schema text NOT NULL,
    subject_table text NOT NULL,
    subject_id uuid,
    correlation_id text NOT NULL,
    trace_id text NOT NULL
);


--
-- Name: alert; Type: TABLE; Schema: haccp; Owner: -
--

CREATE TABLE haccp.alert (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid,
    alert_type text NOT NULL,
    severity text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    control_plan_version text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    store_id uuid,
    business_portal_id uuid,
    CONSTRAINT alert_alert_type_check CHECK ((alert_type = ANY (ARRAY['expiry'::text, 'temperature'::text, 'required_field'::text, 'inconsistency'::text]))),
    CONSTRAINT alert_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT alert_state_check CHECK ((state = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text]))),
    CONSTRAINT ck_alert_store_portal_consistency CHECK (((store_id IS NULL) OR (business_portal_id IS NOT NULL)))
);

ALTER TABLE ONLY haccp.alert FORCE ROW LEVEL SECURITY;


--
-- Name: control_plan; Type: TABLE; Schema: haccp; Owner: -
--

CREATE TABLE haccp.control_plan (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version text NOT NULL,
    max_temp_c numeric(5,2),
    min_temp_c numeric(5,2),
    expiry_warning_days integer,
    active boolean DEFAULT true NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: temperature_log; Type: TABLE; Schema: haccp; Owner: -
--

CREATE TABLE haccp.temperature_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    batch_id uuid,
    location text NOT NULL,
    temp_c numeric(5,2) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    CONSTRAINT temperature_log_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'sensor'::text])))
)
PARTITION BY RANGE (recorded_at);


--
-- Name: temperature_log_2026_06; Type: TABLE; Schema: haccp; Owner: -
--

CREATE TABLE haccp.temperature_log_2026_06 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    batch_id uuid,
    location text NOT NULL,
    temp_c numeric(5,2) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    CONSTRAINT temperature_log_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'sensor'::text])))
);


--
-- Name: temperature_log_2026_07; Type: TABLE; Schema: haccp; Owner: -
--

CREATE TABLE haccp.temperature_log_2026_07 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    batch_id uuid,
    location text NOT NULL,
    temp_c numeric(5,2) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    CONSTRAINT temperature_log_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'sensor'::text])))
);


--
-- Name: temperature_log_default; Type: TABLE; Schema: haccp; Owner: -
--

CREATE TABLE haccp.temperature_log_default (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    batch_id uuid,
    location text NOT NULL,
    temp_c numeric(5,2) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    CONSTRAINT temperature_log_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'sensor'::text])))
);


--
-- Name: app_user; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.app_user (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role text DEFAULT 'admin'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text NOT NULL,
    created_by uuid NOT NULL,
    store_code text,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    organization_code text DEFAULT 'labelscan'::text NOT NULL,
    store_id uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT ck_app_user_role CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text]))),
    CONSTRAINT ck_operator_store_required CHECK (((role <> 'operator'::text) OR (store_code IS NOT NULL)))
);

ALTER TABLE ONLY identity.app_user FORCE ROW LEVEL SECURITY;


--
-- Name: auth_session; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.auth_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    refresh_token_hash text NOT NULL,
    refresh_expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    replaced_by_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    client_type text DEFAULT 'browser'::text NOT NULL,
    CONSTRAINT ck_auth_session_client_type CHECK ((client_type = ANY (ARRAY['browser'::text, 'mobile'::text]))),
    CONSTRAINT ck_auth_session_expiry CHECK ((refresh_expires_at > created_at))
);

ALTER TABLE ONLY identity.auth_session FORCE ROW LEVEL SECURITY;


--
-- Name: business_portal; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.business_portal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    store_id uuid NOT NULL,
    profession_code text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_business_portal_name_not_blank CHECK ((btrim(name) <> ''::text))
);

ALTER TABLE ONLY identity.business_portal FORCE ROW LEVEL SECURITY;


--
-- Name: organization; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.organization (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    timezone text DEFAULT 'Europe/Paris'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_organization_name CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT ck_organization_slug CHECK (((slug = lower(btrim(slug))) AND (slug ~ '^[a-z0-9][a-z0-9-]*$'::text)))
);


--
-- Name: profession; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.profession (
    code text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_profession_code CHECK ((code = ANY (ARRAY['poissonnerie'::text, 'boucherie'::text, 'charcuterie_traiteur'::text]))),
    CONSTRAINT ck_profession_name_not_blank CHECK ((btrim(name) <> ''::text))
);


--
-- Name: store; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.store (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    organization_code text DEFAULT 'labelscan'::text NOT NULL,
    CONSTRAINT ck_store_code_format CHECK (((code = upper(btrim(code))) AND (code ~ '^[A-Z0-9][A-Z0-9._-]*$'::text))),
    CONSTRAINT ck_store_name_not_blank CHECK ((btrim(name) <> ''::text))
);

ALTER TABLE ONLY identity.store FORCE ROW LEVEL SECURITY;


--
-- Name: user_portal_assignment; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.user_portal_assignment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    portal_id uuid NOT NULL,
    created_by uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY identity.user_portal_assignment FORCE ROW LEVEL SECURITY;


--
-- Name: extracted_field; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.extracted_field (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    extraction_run_id uuid NOT NULL,
    field_name text NOT NULL,
    value jsonb,
    evidence jsonb,
    provenance jsonb,
    source_raw_artifact_id uuid,
    validation_status text NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    llm_confidence numeric(4,3),
    ocr_confidence numeric(4,3),
    combined_confidence numeric(4,3) NOT NULL,
    confidence_band text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_evidence_iff_value CHECK (((value IS NULL) = (evidence IS NULL))),
    CONSTRAINT ck_extracted_field_confidence_ranges CHECK ((((llm_confidence IS NULL) OR ((llm_confidence >= (0)::numeric) AND (llm_confidence <= (1)::numeric))) AND ((ocr_confidence IS NULL) OR ((ocr_confidence >= (0)::numeric) AND (ocr_confidence <= (1)::numeric))) AND ((combined_confidence >= (0)::numeric) AND (combined_confidence <= (1)::numeric)))),
    CONSTRAINT ck_extracted_field_evidence_shape CHECK (((evidence IS NULL) OR ((jsonb_typeof(evidence) = 'array'::text) AND ((jsonb_array_length(evidence) >= 1) AND (jsonb_array_length(evidence) <= 16)) AND (length((evidence)::text) <= 32768)))),
    CONSTRAINT ck_extracted_field_provenance_shape CHECK (((provenance IS NULL) OR ((jsonb_typeof(provenance) = 'object'::text) AND (length((provenance)::text) <= 8192)))),
    CONSTRAINT ck_extracted_field_value_shape CHECK (((value IS NULL) OR ((jsonb_typeof(value) = 'string'::text) AND (length((value #>> '{}'::text[])) <= 512)))),
    CONSTRAINT ck_extracted_field_warnings_shape CHECK (((jsonb_typeof(warnings) = 'array'::text) AND (jsonb_array_length(warnings) <= 16) AND (length((warnings)::text) <= 16384))),
    CONSTRAINT ck_value_requires_provenance CHECK (((value IS NULL) OR ((provenance IS NOT NULL) AND (source_raw_artifact_id IS NOT NULL)))),
    CONSTRAINT extracted_field_confidence_band_check CHECK ((confidence_band = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT extracted_field_field_name_check CHECK ((field_name = ANY (ARRAY['product_name'::text, 'commercial_designation'::text, 'scientific_name'::text, 'batch_number'::text, 'supplier_name'::text, 'origin_country'::text, 'FAO_area'::text, 'production_method'::text, 'fishing_gear_or_farming_method'::text, 'expiry_date'::text, 'packaging_date'::text, 'storage_temperature'::text, 'allergens'::text, 'weight'::text, 'price'::text, 'gtin'::text, 'producer_name'::text, 'reseller_brand'::text, 'health_mark'::text, 'animal_species'::text, 'animal_category'::text, 'cut_name'::text, 'birth_country'::text, 'rearing_country'::text, 'slaughter_country'::text, 'cutting_country'::text, 'slaughterhouse_approval'::text, 'cutting_plant_approval'::text, 'product_family'::text, 'manufacturer_name'::text, 'preparation_date'::text, 'conditioning_type'::text, 'storage_mode'::text, 'use_instructions'::text, 'reheating_instructions'::text, 'ingredients'::text, 'additives'::text]))),
    CONSTRAINT extracted_field_source_check CHECK ((source = ANY (ARRAY['llm'::text, 'human'::text, 'gs1'::text]))),
    CONSTRAINT extracted_field_validation_status_check CHECK ((validation_status = ANY (ARRAY['present'::text, 'missing'::text, 'ambiguous'::text, 'normalized'::text, 'unnormalizable'::text, 'invalid'::text])))
);

ALTER TABLE ONLY ingestion.extracted_field FORCE ROW LEVEL SECURITY;


--
-- Name: extraction_run; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.extraction_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ingestion_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    outcome text NOT NULL,
    extractor_version text NOT NULL,
    prompt_version text NOT NULL,
    ocr_provider text NOT NULL,
    llm_model text NOT NULL,
    ocr_raw_ref text,
    rule_set_version text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    escalation_model text,
    CONSTRAINT ck_extraction_run_attempt_positive CHECK ((attempt_no > 0)),
    CONSTRAINT ck_extraction_run_metadata_lengths CHECK (
        length(extractor_version) BETWEEN 1 AND 128
        AND length(prompt_version) BETWEEN 1 AND 128
        AND length(ocr_provider) BETWEEN 1 AND 128
        AND length(llm_model) BETWEEN 1 AND 128
        AND length(rule_set_version) BETWEEN 1 AND 128
    ),
    CONSTRAINT extraction_run_outcome_check CHECK ((outcome = ANY (ARRAY['extraction_running'::text, 'extracted'::text, 'needs_review'::text, 'extraction_failed'::text, 'unparseable'::text, 'off_schema'::text, 'refused'::text])))
);

ALTER TABLE ONLY ingestion.extraction_run FORCE ROW LEVEL SECURITY;


--
-- Name: ingestion; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.ingestion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text NOT NULL,
    image_ref text NOT NULL,
    checksum_sha256 text NOT NULL,
    barcode_raw text,
    client_captured_at timestamp with time zone,
    server_received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    store_code text,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    store_id uuid,
    business_portal_id uuid,
    trade_code_snapshot text DEFAULT 'poissonnerie'::text NOT NULL,
    trade_profile_version text DEFAULT '2'::text NOT NULL,
    captured_by_user_id uuid,
    photo_rotation_degrees smallint DEFAULT 0 NOT NULL,
    photo_base_rotation_degrees smallint DEFAULT '-90'::integer NOT NULL,
    CONSTRAINT ck_ingestion_barcode_length CHECK (((barcode_raw IS NULL) OR (length(barcode_raw) <= 128))),
    CONSTRAINT ck_ingestion_checksum_sha256 CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ck_ingestion_image_ref_length CHECK (((length(image_ref) >= 1) AND (length(image_ref) <= 1024))),
    CONSTRAINT ck_ingestion_store_code_not_blank CHECK (((store_code IS NULL) OR (btrim(store_code) <> ''::text))),
    CONSTRAINT ck_ingestion_store_portal_consistency CHECK (((store_id IS NULL) OR (business_portal_id IS NOT NULL))),
    CONSTRAINT ck_ingestion_trade_profile_version CHECK ((btrim(trade_profile_version) <> ''::text)),
    CONSTRAINT ingestion_photo_base_rotation_degrees_check CHECK ((photo_base_rotation_degrees = ANY (ARRAY['-90'::integer, 0]))),
    CONSTRAINT ingestion_photo_rotation_degrees_check CHECK ((photo_rotation_degrees = ANY (ARRAY[0, 180]))),
    CONSTRAINT ingestion_status_check CHECK ((status = ANY (ARRAY['raw_stored'::text, 'ocr_running'::text, 'ocr_done'::text, 'ocr_failed'::text, 'ocr_skipped_garbage'::text, 'extraction_running'::text, 'extracted'::text, 'extraction_failed'::text, 'needs_review'::text, 'confirmed'::text, 'rejected'::text, 'halted_missing_context'::text])))
);

ALTER TABLE ONLY ingestion.ingestion FORCE ROW LEVEL SECURITY;


--
-- Name: interim_field; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.interim_field (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ingestion_id uuid NOT NULL,
    field_name text NOT NULL,
    value jsonb NOT NULL,
    source text DEFAULT 'deterministic'::text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT interim_field_field_name_check CHECK ((field_name = ANY (ARRAY['expiry_date'::text, 'packaging_date'::text, 'storage_temperature'::text, 'price'::text, 'batch_number'::text]))),
    CONSTRAINT interim_field_source_check CHECK ((source = 'deterministic'::text))
);

ALTER TABLE ONLY ingestion.interim_field FORCE ROW LEVEL SECURITY;


--
-- Name: raw_artifact; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.raw_artifact (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ingestion_id uuid NOT NULL,
    artifact_kind text NOT NULL,
    storage_ref text NOT NULL,
    checksum_sha256 text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    model text,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    CONSTRAINT ck_raw_artifact_checksum_sha256 CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ck_raw_artifact_kind CHECK ((artifact_kind = ANY (ARRAY['image'::text, 'ocr_json'::text, 'llm_output'::text]))),
    CONSTRAINT ck_raw_artifact_model_length CHECK (((model IS NULL) OR ((length(model) >= 1) AND (length(model) <= 128)))),
    CONSTRAINT ck_raw_artifact_storage_ref_length CHECK (((length(storage_ref) >= 1) AND (length(storage_ref) <= 1024)))
)
PARTITION BY RANGE (occurred_at);

ALTER TABLE ONLY ingestion.raw_artifact FORCE ROW LEVEL SECURITY;


--
-- Name: raw_artifact_2026_06; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.raw_artifact_2026_06 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ingestion_id uuid NOT NULL,
    artifact_kind text NOT NULL,
    storage_ref text NOT NULL,
    checksum_sha256 text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    model text,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    CONSTRAINT ck_raw_artifact_checksum_sha256 CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ck_raw_artifact_kind CHECK ((artifact_kind = ANY (ARRAY['image'::text, 'ocr_json'::text, 'llm_output'::text]))),
    CONSTRAINT ck_raw_artifact_model_length CHECK (((model IS NULL) OR ((length(model) >= 1) AND (length(model) <= 128)))),
    CONSTRAINT ck_raw_artifact_storage_ref_length CHECK (((length(storage_ref) >= 1) AND (length(storage_ref) <= 1024)))
);


--
-- Name: raw_artifact_2026_07; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.raw_artifact_2026_07 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ingestion_id uuid NOT NULL,
    artifact_kind text NOT NULL,
    storage_ref text NOT NULL,
    checksum_sha256 text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    model text,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    CONSTRAINT ck_raw_artifact_checksum_sha256 CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ck_raw_artifact_kind CHECK ((artifact_kind = ANY (ARRAY['image'::text, 'ocr_json'::text, 'llm_output'::text]))),
    CONSTRAINT ck_raw_artifact_model_length CHECK (((model IS NULL) OR ((length(model) >= 1) AND (length(model) <= 128)))),
    CONSTRAINT ck_raw_artifact_storage_ref_length CHECK (((length(storage_ref) >= 1) AND (length(storage_ref) <= 1024)))
);


--
-- Name: raw_artifact_default; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.raw_artifact_default (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ingestion_id uuid NOT NULL,
    artifact_kind text NOT NULL,
    storage_ref text NOT NULL,
    checksum_sha256 text NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    model text,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    CONSTRAINT ck_raw_artifact_checksum_sha256 CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ck_raw_artifact_kind CHECK ((artifact_kind = ANY (ARRAY['image'::text, 'ocr_json'::text, 'llm_output'::text]))),
    CONSTRAINT ck_raw_artifact_model_length CHECK (((model IS NULL) OR ((length(model) >= 1) AND (length(model) <= 128)))),
    CONSTRAINT ck_raw_artifact_storage_ref_length CHECK (((length(storage_ref) >= 1) AND (length(storage_ref) <= 1024)))
);


--
-- Name: request_idempotency; Type: TABLE; Schema: ingestion; Owner: -
--

CREATE TABLE ingestion.request_idempotency (
    endpoint text NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    ingestion_id uuid NOT NULL,
    run_id uuid NOT NULL,
    field_name text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    request_hash text,
    CONSTRAINT ck_request_idempotency_finalize_hash CHECK (((endpoint <> 'finalize_review'::text) OR (request_hash IS NOT NULL))),
    CONSTRAINT ck_request_idempotency_hash CHECK (((request_hash IS NULL) OR (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT ck_request_idempotency_key_length CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 128))),
    CONSTRAINT request_idempotency_endpoint_check CHECK ((endpoint = ANY (ARRAY['override_field'::text, 'finalize_review'::text])))
);

ALTER TABLE ONLY ingestion.request_idempotency FORCE ROW LEVEL SECURITY;


--
-- Name: idempotency_key; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.idempotency_key (
    scope_hash text NOT NULL,
    request_fingerprint text NOT NULL,
    state text NOT NULL,
    response_status integer,
    response_body_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT idempotency_key_state_check CHECK ((state = ANY (ARRAY['in_progress'::text, 'completed'::text])))
);


--
-- Name: outbox; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    last_error text,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT ck_outbox_status CHECK ((status = ANY (ARRAY['pending'::text, 'published'::text, 'dead_letter'::text])))
);


--
-- Name: processed_event; Type: TABLE; Schema: platform; Owner: -
--

CREATE TABLE platform.processed_event (
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: arrival_projection; Type: TABLE; Schema: traceability; Owner: -
--

CREATE TABLE traceability.arrival_projection (
    batch_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    store_id uuid,
    store_code text,
    ingestion_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    revision_no integer DEFAULT 1 NOT NULL,
    fields jsonb NOT NULL,
    image_ref text NOT NULL,
    image_checksum text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    business_portal_id uuid,
    trade_code_snapshot text DEFAULT 'poissonnerie'::text NOT NULL,
    trade_profile_version text DEFAULT '2'::text NOT NULL,
    captured_by_user_id uuid,
    CONSTRAINT ck_arrival_projection_store_portal_consistency CHECK (((store_id IS NULL) OR (business_portal_id IS NOT NULL))),
    CONSTRAINT ck_arrival_projection_trade_profile_version CHECK ((btrim(trade_profile_version) <> ''::text))
);

ALTER TABLE ONLY traceability.arrival_projection FORCE ROW LEVEL SECURITY;


--
-- Name: batch; Type: TABLE; Schema: traceability; Owner: -
--

CREATE TABLE traceability.batch (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lot_code text NOT NULL,
    gtin text,
    product_id uuid,
    supplier_id uuid,
    species_scientific text,
    fao_area_code text,
    production_method text,
    use_by date,
    packaging_date date,
    status text NOT NULL,
    source_ingestion_id uuid NOT NULL,
    source_extraction_run_id uuid NOT NULL,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    store_code text,
    organization_id uuid DEFAULT platform.default_organization_id() NOT NULL,
    store_id uuid,
    business_portal_id uuid,
    trade_code_snapshot text DEFAULT 'poissonnerie'::text NOT NULL,
    trade_profile_version text DEFAULT '2'::text NOT NULL,
    captured_by_user_id uuid,
    CONSTRAINT batch_production_method_check CHECK (((production_method IS NULL) OR (production_method = ANY (ARRAY['wild_caught'::text, 'farmed'::text])))),
    CONSTRAINT batch_status_check CHECK ((status = ANY (ARRAY['registered'::text, 'flagged'::text]))),
    CONSTRAINT ck_batch_store_code_not_blank CHECK (((store_code IS NULL) OR (btrim(store_code) <> ''::text))),
    CONSTRAINT ck_batch_store_portal_consistency CHECK (((store_id IS NULL) OR (business_portal_id IS NOT NULL))),
    CONSTRAINT ck_batch_trade_profile_version CHECK ((btrim(trade_profile_version) <> ''::text))
);

ALTER TABLE ONLY traceability.batch FORCE ROW LEVEL SECURITY;


--
-- Name: product; Type: TABLE; Schema: traceability; Owner: -
--

CREATE TABLE traceability.product (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    common_name text,
    scientific_name text,
    gtin text,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: supplier; Type: TABLE; Schema: traceability; Owner: -
--

CREATE TABLE traceability.supplier (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    approval_number text,
    correlation_id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: audit_log_2026_06; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log ATTACH PARTITION audit.audit_log_2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: audit_log_2026_07; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log ATTACH PARTITION audit.audit_log_2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: audit_log_default; Type: TABLE ATTACH; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log ATTACH PARTITION audit.audit_log_default DEFAULT;


--
-- Name: temperature_log_2026_06; Type: TABLE ATTACH; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.temperature_log ATTACH PARTITION haccp.temperature_log_2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: temperature_log_2026_07; Type: TABLE ATTACH; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.temperature_log ATTACH PARTITION haccp.temperature_log_2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: temperature_log_default; Type: TABLE ATTACH; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.temperature_log ATTACH PARTITION haccp.temperature_log_default DEFAULT;


--
-- Name: raw_artifact_2026_06; Type: TABLE ATTACH; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.raw_artifact ATTACH PARTITION ingestion.raw_artifact_2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


--
-- Name: raw_artifact_2026_07; Type: TABLE ATTACH; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.raw_artifact ATTACH PARTITION ingestion.raw_artifact_2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');


--
-- Name: raw_artifact_default; Type: TABLE ATTACH; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.raw_artifact ATTACH PARTITION ingestion.raw_artifact_default DEFAULT;


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_log_2026_06 audit_log_2026_06_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log_2026_06
    ADD CONSTRAINT audit_log_2026_06_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_log_2026_07 audit_log_2026_07_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log_2026_07
    ADD CONSTRAINT audit_log_2026_07_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_log_default audit_log_default_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.audit_log_default
    ADD CONSTRAINT audit_log_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: alert alert_pkey; Type: CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.alert
    ADD CONSTRAINT alert_pkey PRIMARY KEY (id);


--
-- Name: control_plan control_plan_pkey; Type: CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.control_plan
    ADD CONSTRAINT control_plan_pkey PRIMARY KEY (id);


--
-- Name: control_plan control_plan_version_key; Type: CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.control_plan
    ADD CONSTRAINT control_plan_version_key UNIQUE (version);


--
-- Name: temperature_log temperature_log_pkey; Type: CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.temperature_log
    ADD CONSTRAINT temperature_log_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: temperature_log_2026_06 temperature_log_2026_06_pkey; Type: CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.temperature_log_2026_06
    ADD CONSTRAINT temperature_log_2026_06_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: temperature_log_2026_07 temperature_log_2026_07_pkey; Type: CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.temperature_log_2026_07
    ADD CONSTRAINT temperature_log_2026_07_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: temperature_log_default temperature_log_default_pkey; Type: CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.temperature_log_default
    ADD CONSTRAINT temperature_log_default_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_refresh_token_hash_key; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.auth_session
    ADD CONSTRAINT auth_session_refresh_token_hash_key UNIQUE (refresh_token_hash);


--
-- Name: business_portal business_portal_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT business_portal_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_key; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization
    ADD CONSTRAINT organization_slug_key UNIQUE (slug);


--
-- Name: profession profession_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.profession
    ADD CONSTRAINT profession_pkey PRIMARY KEY (code);


--
-- Name: store store_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.store
    ADD CONSTRAINT store_pkey PRIMARY KEY (id);


--
-- Name: app_user uq_app_user_organization_id; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.app_user
    ADD CONSTRAINT uq_app_user_organization_id UNIQUE (organization_id, id);


--
-- Name: business_portal uq_business_portal_org_store_id; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT uq_business_portal_org_store_id UNIQUE (organization_id, store_id, id);


--
-- Name: business_portal uq_business_portal_organization_id; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT uq_business_portal_organization_id UNIQUE (organization_id, id);


--
-- Name: business_portal uq_business_portal_store_profession; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT uq_business_portal_store_profession UNIQUE (organization_id, store_id, profession_code);


--
-- Name: store uq_store_org_id_id; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.store
    ADD CONSTRAINT uq_store_org_id_id UNIQUE (organization_id, id);


--
-- Name: store uq_store_organization_code; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.store
    ADD CONSTRAINT uq_store_organization_code UNIQUE (organization_id, code);


--
-- Name: user_portal_assignment user_portal_assignment_id_key; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.user_portal_assignment
    ADD CONSTRAINT user_portal_assignment_id_key UNIQUE (id);


--
-- Name: user_portal_assignment user_portal_assignment_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.user_portal_assignment
    ADD CONSTRAINT user_portal_assignment_pkey PRIMARY KEY (user_id, portal_id);


--
-- Name: extracted_field extracted_field_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.extracted_field
    ADD CONSTRAINT extracted_field_pkey PRIMARY KEY (id);


--
-- Name: extraction_run extraction_run_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.extraction_run
    ADD CONSTRAINT extraction_run_pkey PRIMARY KEY (id);


--
-- Name: ingestion ingestion_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.ingestion
    ADD CONSTRAINT ingestion_pkey PRIMARY KEY (id);


--
-- Name: interim_field interim_field_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.interim_field
    ADD CONSTRAINT interim_field_pkey PRIMARY KEY (id);


--
-- Name: raw_artifact raw_artifact_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.raw_artifact
    ADD CONSTRAINT raw_artifact_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: raw_artifact_2026_06 raw_artifact_2026_06_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.raw_artifact_2026_06
    ADD CONSTRAINT raw_artifact_2026_06_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: raw_artifact_2026_07 raw_artifact_2026_07_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.raw_artifact_2026_07
    ADD CONSTRAINT raw_artifact_2026_07_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: raw_artifact_default raw_artifact_default_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.raw_artifact_default
    ADD CONSTRAINT raw_artifact_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: request_idempotency request_idempotency_pkey; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.request_idempotency
    ADD CONSTRAINT request_idempotency_pkey PRIMARY KEY (endpoint, actor_id, idempotency_key);


--
-- Name: extraction_run uq_extraction_run_attempt; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.extraction_run
    ADD CONSTRAINT uq_extraction_run_attempt UNIQUE (ingestion_id, attempt_no);


--
-- Name: extracted_field uq_field_per_run; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.extracted_field
    ADD CONSTRAINT uq_field_per_run UNIQUE (extraction_run_id, field_name);


--
-- Name: interim_field uq_interim_field_per_ingestion; Type: CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.interim_field
    ADD CONSTRAINT uq_interim_field_per_ingestion UNIQUE (ingestion_id, field_name);


--
-- Name: idempotency_key idempotency_key_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.idempotency_key
    ADD CONSTRAINT idempotency_key_pkey PRIMARY KEY (scope_hash);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: processed_event processed_event_pkey; Type: CONSTRAINT; Schema: platform; Owner: -
--

ALTER TABLE ONLY platform.processed_event
    ADD CONSTRAINT processed_event_pkey PRIMARY KEY (consumer, event_id);


--
-- Name: arrival_projection arrival_projection_pkey; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT arrival_projection_pkey PRIMARY KEY (batch_id);


--
-- Name: batch batch_pkey; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT batch_pkey PRIMARY KEY (id);


--
-- Name: product product_pkey; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.product
    ADD CONSTRAINT product_pkey PRIMARY KEY (id);


--
-- Name: supplier supplier_pkey; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.supplier
    ADD CONSTRAINT supplier_pkey PRIMARY KEY (id);


--
-- Name: batch uq_batch_lot; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT uq_batch_lot UNIQUE NULLS NOT DISTINCT (organization_id, business_portal_id, supplier_id, product_id, lot_code);


--
-- Name: product uq_product_identity; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.product
    ADD CONSTRAINT uq_product_identity UNIQUE NULLS NOT DISTINCT (common_name, scientific_name, gtin);


--
-- Name: supplier uq_supplier_name; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.supplier
    ADD CONSTRAINT uq_supplier_name UNIQUE (name);


--
-- Name: ix_audit_log_correlation; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_audit_log_correlation ON ONLY audit.audit_log USING btree (correlation_id);


--
-- Name: audit_log_2026_06_correlation_id_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_2026_06_correlation_id_idx ON audit.audit_log_2026_06 USING btree (correlation_id);


--
-- Name: ix_audit_log_subject; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX ix_audit_log_subject ON ONLY audit.audit_log USING btree (subject_schema, subject_table, subject_id);


--
-- Name: audit_log_2026_06_subject_schema_subject_table_subject_id_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_2026_06_subject_schema_subject_table_subject_id_idx ON audit.audit_log_2026_06 USING btree (subject_schema, subject_table, subject_id);


--
-- Name: audit_log_2026_07_correlation_id_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_2026_07_correlation_id_idx ON audit.audit_log_2026_07 USING btree (correlation_id);


--
-- Name: audit_log_2026_07_subject_schema_subject_table_subject_id_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_2026_07_subject_schema_subject_table_subject_id_idx ON audit.audit_log_2026_07 USING btree (subject_schema, subject_table, subject_id);


--
-- Name: audit_log_default_correlation_id_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_default_correlation_id_idx ON audit.audit_log_default USING btree (correlation_id);


--
-- Name: audit_log_default_subject_schema_subject_table_subject_id_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_log_default_subject_schema_subject_table_subject_id_idx ON audit.audit_log_default USING btree (subject_schema, subject_table, subject_id);


--
-- Name: ix_alert_open; Type: INDEX; Schema: haccp; Owner: -
--

CREATE INDEX ix_alert_open ON haccp.alert USING btree (batch_id) WHERE (state = 'open'::text);


--
-- Name: ix_alert_org_portal_state_created; Type: INDEX; Schema: haccp; Owner: -
--

CREATE INDEX ix_alert_org_portal_state_created ON haccp.alert USING btree (organization_id, business_portal_id, state, created_at DESC);


--
-- Name: ix_control_plan_active; Type: INDEX; Schema: haccp; Owner: -
--

CREATE INDEX ix_control_plan_active ON haccp.control_plan USING btree (active) WHERE active;


--
-- Name: ix_temperature_log_batch; Type: INDEX; Schema: haccp; Owner: -
--

CREATE INDEX ix_temperature_log_batch ON ONLY haccp.temperature_log USING btree (batch_id);


--
-- Name: temperature_log_2026_06_batch_id_idx; Type: INDEX; Schema: haccp; Owner: -
--

CREATE INDEX temperature_log_2026_06_batch_id_idx ON haccp.temperature_log_2026_06 USING btree (batch_id);


--
-- Name: temperature_log_2026_07_batch_id_idx; Type: INDEX; Schema: haccp; Owner: -
--

CREATE INDEX temperature_log_2026_07_batch_id_idx ON haccp.temperature_log_2026_07 USING btree (batch_id);


--
-- Name: temperature_log_default_batch_id_idx; Type: INDEX; Schema: haccp; Owner: -
--

CREATE INDEX temperature_log_default_batch_id_idx ON haccp.temperature_log_default USING btree (batch_id);


--
-- Name: ix_app_user_store_code; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX ix_app_user_store_code ON identity.app_user USING btree (store_code);


--
-- Name: ix_auth_session_family; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX ix_auth_session_family ON identity.auth_session USING btree (family_id, refresh_expires_at DESC);


--
-- Name: ix_auth_session_user; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX ix_auth_session_user ON identity.auth_session USING btree (organization_id, user_id, refresh_expires_at DESC);


--
-- Name: ix_business_portal_org_active; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX ix_business_portal_org_active ON identity.business_portal USING btree (organization_id, active, store_id);


--
-- Name: ix_user_portal_assignment_org_portal; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX ix_user_portal_assignment_org_portal ON identity.user_portal_assignment USING btree (organization_id, portal_id, user_id);


--
-- Name: ix_user_portal_assignment_org_user; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX ix_user_portal_assignment_org_user ON identity.user_portal_assignment USING btree (organization_id, user_id);


--
-- Name: uq_user_organization_username_current; Type: INDEX; Schema: identity; Owner: -
--

CREATE UNIQUE INDEX uq_user_organization_username_current ON identity.app_user USING btree (organization_id, username) WHERE (deleted_at IS NULL);


--
-- Name: ix_extraction_run_ingestion; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_extraction_run_ingestion ON ingestion.extraction_run USING btree (ingestion_id, created_at DESC);


--
-- Name: ix_ingestion_org_captured_received; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_ingestion_org_captured_received ON ingestion.ingestion USING btree (organization_id, captured_by_user_id, server_received_at DESC);


--
-- Name: ix_ingestion_org_portal_received; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_ingestion_org_portal_received ON ingestion.ingestion USING btree (organization_id, business_portal_id, server_received_at DESC);


--
-- Name: ix_ingestion_org_store_received; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_ingestion_org_store_received ON ingestion.ingestion USING btree (organization_id, store_id, server_received_at DESC);


--
-- Name: ix_ingestion_status; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_ingestion_status ON ingestion.ingestion USING btree (status);


--
-- Name: ix_ingestion_store_received; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_ingestion_store_received ON ingestion.ingestion USING btree (store_code, server_received_at DESC);


--
-- Name: ix_interim_field_ingestion; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_interim_field_ingestion ON ingestion.interim_field USING btree (ingestion_id);


--
-- Name: ix_raw_artifact_ingestion; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_raw_artifact_ingestion ON ONLY ingestion.raw_artifact USING btree (ingestion_id);


--
-- Name: ix_raw_artifact_org_ingestion; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX ix_raw_artifact_org_ingestion ON ONLY ingestion.raw_artifact USING btree (organization_id, ingestion_id);


--
-- Name: uq_raw_artifact_content; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE UNIQUE INDEX uq_raw_artifact_content ON ONLY ingestion.raw_artifact USING btree (ingestion_id, artifact_kind, checksum_sha256, occurred_at);


--
-- Name: raw_artifact_2026_06_ingestion_id_artifact_kind_checksum_sh_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE UNIQUE INDEX raw_artifact_2026_06_ingestion_id_artifact_kind_checksum_sh_idx ON ingestion.raw_artifact_2026_06 USING btree (ingestion_id, artifact_kind, checksum_sha256, occurred_at);


--
-- Name: raw_artifact_2026_06_ingestion_id_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX raw_artifact_2026_06_ingestion_id_idx ON ingestion.raw_artifact_2026_06 USING btree (ingestion_id);


--
-- Name: raw_artifact_2026_06_organization_id_ingestion_id_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX raw_artifact_2026_06_organization_id_ingestion_id_idx ON ingestion.raw_artifact_2026_06 USING btree (organization_id, ingestion_id);


--
-- Name: raw_artifact_2026_07_ingestion_id_artifact_kind_checksum_sh_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE UNIQUE INDEX raw_artifact_2026_07_ingestion_id_artifact_kind_checksum_sh_idx ON ingestion.raw_artifact_2026_07 USING btree (ingestion_id, artifact_kind, checksum_sha256, occurred_at);


--
-- Name: raw_artifact_2026_07_ingestion_id_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX raw_artifact_2026_07_ingestion_id_idx ON ingestion.raw_artifact_2026_07 USING btree (ingestion_id);


--
-- Name: raw_artifact_2026_07_organization_id_ingestion_id_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX raw_artifact_2026_07_organization_id_ingestion_id_idx ON ingestion.raw_artifact_2026_07 USING btree (organization_id, ingestion_id);


--
-- Name: raw_artifact_default_ingestion_id_artifact_kind_checksum_sh_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE UNIQUE INDEX raw_artifact_default_ingestion_id_artifact_kind_checksum_sh_idx ON ingestion.raw_artifact_default USING btree (ingestion_id, artifact_kind, checksum_sha256, occurred_at);


--
-- Name: raw_artifact_default_ingestion_id_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX raw_artifact_default_ingestion_id_idx ON ingestion.raw_artifact_default USING btree (ingestion_id);


--
-- Name: raw_artifact_default_organization_id_ingestion_id_idx; Type: INDEX; Schema: ingestion; Owner: -
--

CREATE INDEX raw_artifact_default_organization_id_ingestion_id_idx ON ingestion.raw_artifact_default USING btree (organization_id, ingestion_id);


--
-- Name: ix_outbox_claimable; Type: INDEX; Schema: platform; Owner: -
--

CREATE INDEX ix_outbox_claimable ON platform.outbox USING btree (created_at) WHERE ((published_at IS NULL) AND (status <> 'dead_letter'::text));


--
-- Name: ix_outbox_dead_letter; Type: INDEX; Schema: platform; Owner: -
--

CREATE INDEX ix_outbox_dead_letter ON platform.outbox USING btree (created_at) WHERE (status = 'dead_letter'::text);


--
-- Name: ix_arrival_projection_fields_trgm; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_fields_trgm ON traceability.arrival_projection USING gin (((fields)::text) public.gin_trgm_ops);


--
-- Name: ix_arrival_projection_lot_trgm; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_lot_trgm ON traceability.arrival_projection USING gin (COALESCE((fields ->> 'batch_number'::text), ''::text) public.gin_trgm_ops);


--
-- Name: ix_arrival_projection_org_portal_expiry; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_org_portal_expiry ON traceability.arrival_projection USING btree (organization_id, business_portal_id, ((fields ->> 'expiry_date'::text)), batch_id);


--
-- Name: ix_arrival_projection_org_portal_lot; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_org_portal_lot ON traceability.arrival_projection USING btree (organization_id, business_portal_id, ((fields ->> 'batch_number'::text)), batch_id);


--
-- Name: ix_arrival_projection_org_portal_product; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_org_portal_product ON traceability.arrival_projection USING btree (organization_id, business_portal_id, COALESCE((fields ->> 'commercial_designation'::text), (fields ->> 'product_name'::text), ''::text), batch_id);


--
-- Name: ix_arrival_projection_org_portal_recorded; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_org_portal_recorded ON traceability.arrival_projection USING btree (organization_id, business_portal_id, recorded_at DESC);


--
-- Name: ix_arrival_projection_org_portal_supplier; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_org_portal_supplier ON traceability.arrival_projection USING btree (organization_id, business_portal_id, COALESCE((fields ->> 'reseller_brand'::text), (fields ->> 'producer_name'::text), (fields ->> 'supplier_name'::text), ''::text), batch_id);


--
-- Name: ix_arrival_projection_org_store_recorded; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_org_store_recorded ON traceability.arrival_projection USING btree (organization_id, store_id, recorded_at DESC);


--
-- Name: ix_arrival_projection_supplier_trgm; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_arrival_projection_supplier_trgm ON traceability.arrival_projection USING gin (COALESCE((fields ->> 'reseller_brand'::text), (fields ->> 'producer_name'::text), (fields ->> 'supplier_name'::text), ''::text) public.gin_trgm_ops);


--
-- Name: ix_batch_lot_code; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_batch_lot_code ON traceability.batch USING btree (lot_code);


--
-- Name: ix_batch_org_portal_created; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_batch_org_portal_created ON traceability.batch USING btree (organization_id, business_portal_id, created_at DESC);


--
-- Name: ix_batch_org_store_created; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_batch_org_store_created ON traceability.batch USING btree (organization_id, store_id, created_at DESC);


--
-- Name: ix_batch_source_run; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_batch_source_run ON traceability.batch USING btree (source_extraction_run_id);


--
-- Name: ix_batch_store_created; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_batch_store_created ON traceability.batch USING btree (store_code, created_at DESC);


--
-- Name: ix_batch_supplier; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX ix_batch_supplier ON traceability.batch USING btree (supplier_id);


--
-- Name: audit_log_2026_06_correlation_id_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.ix_audit_log_correlation ATTACH PARTITION audit.audit_log_2026_06_correlation_id_idx;


--
-- Name: audit_log_2026_06_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.audit_log_pkey ATTACH PARTITION audit.audit_log_2026_06_pkey;


--
-- Name: audit_log_2026_06_subject_schema_subject_table_subject_id_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.ix_audit_log_subject ATTACH PARTITION audit.audit_log_2026_06_subject_schema_subject_table_subject_id_idx;


--
-- Name: audit_log_2026_07_correlation_id_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.ix_audit_log_correlation ATTACH PARTITION audit.audit_log_2026_07_correlation_id_idx;


--
-- Name: audit_log_2026_07_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.audit_log_pkey ATTACH PARTITION audit.audit_log_2026_07_pkey;


--
-- Name: audit_log_2026_07_subject_schema_subject_table_subject_id_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.ix_audit_log_subject ATTACH PARTITION audit.audit_log_2026_07_subject_schema_subject_table_subject_id_idx;


--
-- Name: audit_log_default_correlation_id_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.ix_audit_log_correlation ATTACH PARTITION audit.audit_log_default_correlation_id_idx;


--
-- Name: audit_log_default_pkey; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.audit_log_pkey ATTACH PARTITION audit.audit_log_default_pkey;


--
-- Name: audit_log_default_subject_schema_subject_table_subject_id_idx; Type: INDEX ATTACH; Schema: audit; Owner: -
--

ALTER INDEX audit.ix_audit_log_subject ATTACH PARTITION audit.audit_log_default_subject_schema_subject_table_subject_id_idx;


--
-- Name: temperature_log_2026_06_batch_id_idx; Type: INDEX ATTACH; Schema: haccp; Owner: -
--

ALTER INDEX haccp.ix_temperature_log_batch ATTACH PARTITION haccp.temperature_log_2026_06_batch_id_idx;


--
-- Name: temperature_log_2026_06_pkey; Type: INDEX ATTACH; Schema: haccp; Owner: -
--

ALTER INDEX haccp.temperature_log_pkey ATTACH PARTITION haccp.temperature_log_2026_06_pkey;


--
-- Name: temperature_log_2026_07_batch_id_idx; Type: INDEX ATTACH; Schema: haccp; Owner: -
--

ALTER INDEX haccp.ix_temperature_log_batch ATTACH PARTITION haccp.temperature_log_2026_07_batch_id_idx;


--
-- Name: temperature_log_2026_07_pkey; Type: INDEX ATTACH; Schema: haccp; Owner: -
--

ALTER INDEX haccp.temperature_log_pkey ATTACH PARTITION haccp.temperature_log_2026_07_pkey;


--
-- Name: temperature_log_default_batch_id_idx; Type: INDEX ATTACH; Schema: haccp; Owner: -
--

ALTER INDEX haccp.ix_temperature_log_batch ATTACH PARTITION haccp.temperature_log_default_batch_id_idx;


--
-- Name: temperature_log_default_pkey; Type: INDEX ATTACH; Schema: haccp; Owner: -
--

ALTER INDEX haccp.temperature_log_pkey ATTACH PARTITION haccp.temperature_log_default_pkey;


--
-- Name: raw_artifact_2026_06_ingestion_id_artifact_kind_checksum_sh_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.uq_raw_artifact_content ATTACH PARTITION ingestion.raw_artifact_2026_06_ingestion_id_artifact_kind_checksum_sh_idx;


--
-- Name: raw_artifact_2026_06_ingestion_id_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.ix_raw_artifact_ingestion ATTACH PARTITION ingestion.raw_artifact_2026_06_ingestion_id_idx;


--
-- Name: raw_artifact_2026_06_organization_id_ingestion_id_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.ix_raw_artifact_org_ingestion ATTACH PARTITION ingestion.raw_artifact_2026_06_organization_id_ingestion_id_idx;


--
-- Name: raw_artifact_2026_06_pkey; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.raw_artifact_pkey ATTACH PARTITION ingestion.raw_artifact_2026_06_pkey;


--
-- Name: raw_artifact_2026_07_ingestion_id_artifact_kind_checksum_sh_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.uq_raw_artifact_content ATTACH PARTITION ingestion.raw_artifact_2026_07_ingestion_id_artifact_kind_checksum_sh_idx;


--
-- Name: raw_artifact_2026_07_ingestion_id_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.ix_raw_artifact_ingestion ATTACH PARTITION ingestion.raw_artifact_2026_07_ingestion_id_idx;


--
-- Name: raw_artifact_2026_07_organization_id_ingestion_id_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.ix_raw_artifact_org_ingestion ATTACH PARTITION ingestion.raw_artifact_2026_07_organization_id_ingestion_id_idx;


--
-- Name: raw_artifact_2026_07_pkey; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.raw_artifact_pkey ATTACH PARTITION ingestion.raw_artifact_2026_07_pkey;


--
-- Name: raw_artifact_default_ingestion_id_artifact_kind_checksum_sh_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.uq_raw_artifact_content ATTACH PARTITION ingestion.raw_artifact_default_ingestion_id_artifact_kind_checksum_sh_idx;


--
-- Name: raw_artifact_default_ingestion_id_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.ix_raw_artifact_ingestion ATTACH PARTITION ingestion.raw_artifact_default_ingestion_id_idx;


--
-- Name: raw_artifact_default_organization_id_ingestion_id_idx; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.ix_raw_artifact_org_ingestion ATTACH PARTITION ingestion.raw_artifact_default_organization_id_ingestion_id_idx;


--
-- Name: raw_artifact_default_pkey; Type: INDEX ATTACH; Schema: ingestion; Owner: -
--

ALTER INDEX ingestion.raw_artifact_pkey ATTACH PARTITION ingestion.raw_artifact_default_pkey;


--
-- Name: audit_log trg_audit_log_no_mutation; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_log_no_mutation BEFORE DELETE OR UPDATE ON audit.audit_log FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: audit_log trg_audit_log_no_truncate; Type: TRIGGER; Schema: audit; Owner: -
--

CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: alert trg_alert_audit; Type: TRIGGER; Schema: haccp; Owner: -
--

CREATE TRIGGER trg_alert_audit AFTER INSERT OR UPDATE ON haccp.alert FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: control_plan trg_control_plan_audit; Type: TRIGGER; Schema: haccp; Owner: -
--

CREATE TRIGGER trg_control_plan_audit AFTER INSERT ON haccp.control_plan FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: control_plan trg_control_plan_no_mutation; Type: TRIGGER; Schema: haccp; Owner: -
--

CREATE TRIGGER trg_control_plan_no_mutation BEFORE DELETE OR UPDATE ON haccp.control_plan FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: temperature_log trg_temperature_log_audit; Type: TRIGGER; Schema: haccp; Owner: -
--

CREATE TRIGGER trg_temperature_log_audit AFTER INSERT ON haccp.temperature_log FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: temperature_log trg_temperature_log_no_mutation; Type: TRIGGER; Schema: haccp; Owner: -
--

CREATE TRIGGER trg_temperature_log_no_mutation BEFORE DELETE OR UPDATE ON haccp.temperature_log FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: temperature_log trg_temperature_log_no_truncate; Type: TRIGGER; Schema: haccp; Owner: -
--

CREATE TRIGGER trg_temperature_log_no_truncate BEFORE TRUNCATE ON haccp.temperature_log FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: app_user trg_app_user_audit; Type: TRIGGER; Schema: identity; Owner: -
--

CREATE TRIGGER trg_app_user_audit AFTER INSERT OR UPDATE ON identity.app_user FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: store trg_store_audit; Type: TRIGGER; Schema: identity; Owner: -
--

CREATE TRIGGER trg_store_audit AFTER INSERT OR UPDATE ON identity.store FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: user_portal_assignment trg_user_portal_assignment_audit; Type: TRIGGER; Schema: identity; Owner: -
--

CREATE TRIGGER trg_user_portal_assignment_audit AFTER INSERT OR UPDATE ON identity.user_portal_assignment FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: extracted_field trg_extracted_field_no_mutation; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_extracted_field_no_mutation BEFORE DELETE OR UPDATE ON ingestion.extracted_field FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: extracted_field trg_extracted_field_no_truncate; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_extracted_field_no_truncate BEFORE TRUNCATE ON ingestion.extracted_field FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: extraction_run trg_extraction_run_audit; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_extraction_run_audit AFTER INSERT ON ingestion.extraction_run FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: extraction_run trg_extraction_run_no_mutation; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_extraction_run_no_mutation BEFORE DELETE OR UPDATE ON ingestion.extraction_run FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: extraction_run trg_extraction_run_no_truncate; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_extraction_run_no_truncate BEFORE TRUNCATE ON ingestion.extraction_run FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: ingestion trg_ingestion_audit; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_ingestion_audit AFTER INSERT ON ingestion.ingestion FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: ingestion trg_ingestion_audit_update; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_ingestion_audit_update AFTER UPDATE ON ingestion.ingestion FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: interim_field trg_interim_field_no_mutation; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_interim_field_no_mutation BEFORE DELETE OR UPDATE ON ingestion.interim_field FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: interim_field trg_interim_field_no_truncate; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_interim_field_no_truncate BEFORE TRUNCATE ON ingestion.interim_field FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: raw_artifact trg_raw_artifact_audit; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_raw_artifact_audit AFTER INSERT ON ingestion.raw_artifact FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: raw_artifact trg_raw_artifact_no_mutation; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_raw_artifact_no_mutation BEFORE DELETE OR UPDATE ON ingestion.raw_artifact FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: raw_artifact trg_raw_artifact_no_truncate; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_raw_artifact_no_truncate BEFORE TRUNCATE ON ingestion.raw_artifact FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: request_idempotency trg_request_idempotency_no_mutation; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_request_idempotency_no_mutation BEFORE DELETE OR UPDATE ON ingestion.request_idempotency FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: request_idempotency trg_request_idempotency_no_truncate; Type: TRIGGER; Schema: ingestion; Owner: -
--

CREATE TRIGGER trg_request_idempotency_no_truncate BEFORE TRUNCATE ON ingestion.request_idempotency FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: batch trg_batch_audit; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_batch_audit AFTER INSERT ON traceability.batch FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: batch trg_batch_no_mutation; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_batch_no_mutation BEFORE DELETE OR UPDATE ON traceability.batch FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: batch trg_batch_no_truncate; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_batch_no_truncate BEFORE TRUNCATE ON traceability.batch FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: product trg_product_audit; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_product_audit AFTER INSERT ON traceability.product FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: product trg_product_no_mutation; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_product_no_mutation BEFORE DELETE OR UPDATE ON traceability.product FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: product trg_product_no_truncate; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_product_no_truncate BEFORE TRUNCATE ON traceability.product FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: supplier trg_supplier_audit; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_supplier_audit AFTER INSERT ON traceability.supplier FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();


--
-- Name: supplier trg_supplier_no_mutation; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_supplier_no_mutation BEFORE DELETE OR UPDATE ON traceability.supplier FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: supplier trg_supplier_no_truncate; Type: TRIGGER; Schema: traceability; Owner: -
--

CREATE TRIGGER trg_supplier_no_truncate BEFORE TRUNCATE ON traceability.supplier FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();


--
-- Name: alert fk_alert_business_portal; Type: FK CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.alert
    ADD CONSTRAINT fk_alert_business_portal FOREIGN KEY (organization_id, store_id, business_portal_id) REFERENCES identity.business_portal(organization_id, store_id, id);


--
-- Name: alert fk_alert_organization; Type: FK CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.alert
    ADD CONSTRAINT fk_alert_organization FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: alert fk_alert_organization_store; Type: FK CONSTRAINT; Schema: haccp; Owner: -
--

ALTER TABLE ONLY haccp.alert
    ADD CONSTRAINT fk_alert_organization_store FOREIGN KEY (organization_id, store_id) REFERENCES identity.store(organization_id, id);


--
-- Name: app_user app_user_organization_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.app_user
    ADD CONSTRAINT app_user_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: auth_session auth_session_organization_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.auth_session
    ADD CONSTRAINT auth_session_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: auth_session auth_session_replaced_by_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.auth_session
    ADD CONSTRAINT auth_session_replaced_by_id_fkey FOREIGN KEY (replaced_by_id) REFERENCES identity.auth_session(id);


--
-- Name: auth_session auth_session_user_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.auth_session
    ADD CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity.app_user(id) ON DELETE CASCADE;


--
-- Name: business_portal business_portal_organization_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT business_portal_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: business_portal business_portal_profession_code_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT business_portal_profession_code_fkey FOREIGN KEY (profession_code) REFERENCES identity.profession(code);


--
-- Name: app_user fk_app_user_created_by; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.app_user
    ADD CONSTRAINT fk_app_user_created_by FOREIGN KEY (created_by) REFERENCES identity.app_user(id);


--
-- Name: app_user fk_app_user_organization_store; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.app_user
    ADD CONSTRAINT fk_app_user_organization_store FOREIGN KEY (organization_id, store_id) REFERENCES identity.store(organization_id, id);


--
-- Name: app_user fk_app_user_store_id; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.app_user
    ADD CONSTRAINT fk_app_user_store_id FOREIGN KEY (store_id) REFERENCES identity.store(id);


--
-- Name: business_portal fk_business_portal_organization_creator; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT fk_business_portal_organization_creator FOREIGN KEY (organization_id, created_by) REFERENCES identity.app_user(organization_id, id);


--
-- Name: business_portal fk_business_portal_organization_store; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.business_portal
    ADD CONSTRAINT fk_business_portal_organization_store FOREIGN KEY (organization_id, store_id) REFERENCES identity.store(organization_id, id);


--
-- Name: user_portal_assignment fk_user_portal_assignment_creator; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.user_portal_assignment
    ADD CONSTRAINT fk_user_portal_assignment_creator FOREIGN KEY (organization_id, created_by) REFERENCES identity.app_user(organization_id, id);


--
-- Name: user_portal_assignment fk_user_portal_assignment_portal; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.user_portal_assignment
    ADD CONSTRAINT fk_user_portal_assignment_portal FOREIGN KEY (organization_id, portal_id) REFERENCES identity.business_portal(organization_id, id);


--
-- Name: user_portal_assignment fk_user_portal_assignment_user; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.user_portal_assignment
    ADD CONSTRAINT fk_user_portal_assignment_user FOREIGN KEY (organization_id, user_id) REFERENCES identity.app_user(organization_id, id);


--
-- Name: store store_created_by_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.store
    ADD CONSTRAINT store_created_by_fkey FOREIGN KEY (created_by) REFERENCES identity.app_user(id);


--
-- Name: store store_organization_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.store
    ADD CONSTRAINT store_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: user_portal_assignment user_portal_assignment_organization_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.user_portal_assignment
    ADD CONSTRAINT user_portal_assignment_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: extracted_field extracted_field_extraction_run_id_fkey; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.extracted_field
    ADD CONSTRAINT extracted_field_extraction_run_id_fkey FOREIGN KEY (extraction_run_id) REFERENCES ingestion.extraction_run(id);


--
-- Name: ingestion fk_ingestion_business_portal; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.ingestion
    ADD CONSTRAINT fk_ingestion_business_portal FOREIGN KEY (organization_id, store_id, business_portal_id) REFERENCES identity.business_portal(organization_id, store_id, id);


--
-- Name: ingestion fk_ingestion_captured_by; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.ingestion
    ADD CONSTRAINT fk_ingestion_captured_by FOREIGN KEY (organization_id, captured_by_user_id) REFERENCES identity.app_user(organization_id, id);


--
-- Name: ingestion fk_ingestion_organization_store; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.ingestion
    ADD CONSTRAINT fk_ingestion_organization_store FOREIGN KEY (organization_id, store_id) REFERENCES identity.store(organization_id, id);


--
-- Name: ingestion fk_ingestion_trade_snapshot; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.ingestion
    ADD CONSTRAINT fk_ingestion_trade_snapshot FOREIGN KEY (trade_code_snapshot) REFERENCES identity.profession(code);


--
-- Name: ingestion ingestion_organization_id_fkey; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.ingestion
    ADD CONSTRAINT ingestion_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: interim_field interim_field_ingestion_id_fkey; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.interim_field
    ADD CONSTRAINT interim_field_ingestion_id_fkey FOREIGN KEY (ingestion_id) REFERENCES ingestion.ingestion(id);


--
-- Name: raw_artifact raw_artifact_organization_id_fkey; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ingestion.raw_artifact
    ADD CONSTRAINT raw_artifact_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: request_idempotency request_idempotency_ingestion_id_fkey; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.request_idempotency
    ADD CONSTRAINT request_idempotency_ingestion_id_fkey FOREIGN KEY (ingestion_id) REFERENCES ingestion.ingestion(id);


--
-- Name: request_idempotency request_idempotency_run_id_fkey; Type: FK CONSTRAINT; Schema: ingestion; Owner: -
--

ALTER TABLE ONLY ingestion.request_idempotency
    ADD CONSTRAINT request_idempotency_run_id_fkey FOREIGN KEY (run_id) REFERENCES ingestion.extraction_run(id);


--
-- Name: arrival_projection arrival_projection_batch_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT arrival_projection_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES traceability.batch(id);


--
-- Name: arrival_projection arrival_projection_extraction_run_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT arrival_projection_extraction_run_id_fkey FOREIGN KEY (extraction_run_id) REFERENCES ingestion.extraction_run(id);


--
-- Name: arrival_projection arrival_projection_ingestion_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT arrival_projection_ingestion_id_fkey FOREIGN KEY (ingestion_id) REFERENCES ingestion.ingestion(id);


--
-- Name: arrival_projection arrival_projection_organization_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT arrival_projection_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: batch batch_organization_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT batch_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES identity.organization(id);


--
-- Name: batch batch_product_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT batch_product_id_fkey FOREIGN KEY (product_id) REFERENCES traceability.product(id);


--
-- Name: batch batch_supplier_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT batch_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES traceability.supplier(id);


--
-- Name: arrival_projection fk_arrival_projection_business_portal; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT fk_arrival_projection_business_portal FOREIGN KEY (organization_id, store_id, business_portal_id) REFERENCES identity.business_portal(organization_id, store_id, id);


--
-- Name: arrival_projection fk_arrival_projection_captured_by; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT fk_arrival_projection_captured_by FOREIGN KEY (organization_id, captured_by_user_id) REFERENCES identity.app_user(organization_id, id);


--
-- Name: arrival_projection fk_arrival_projection_organization_store; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT fk_arrival_projection_organization_store FOREIGN KEY (organization_id, store_id) REFERENCES identity.store(organization_id, id);


--
-- Name: arrival_projection fk_arrival_projection_trade_snapshot; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.arrival_projection
    ADD CONSTRAINT fk_arrival_projection_trade_snapshot FOREIGN KEY (trade_code_snapshot) REFERENCES identity.profession(code);


--
-- Name: batch fk_batch_business_portal; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT fk_batch_business_portal FOREIGN KEY (organization_id, store_id, business_portal_id) REFERENCES identity.business_portal(organization_id, store_id, id);


--
-- Name: batch fk_batch_captured_by; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT fk_batch_captured_by FOREIGN KEY (organization_id, captured_by_user_id) REFERENCES identity.app_user(organization_id, id);


--
-- Name: batch fk_batch_organization_store; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT fk_batch_organization_store FOREIGN KEY (organization_id, store_id) REFERENCES identity.store(organization_id, id);


--
-- Name: batch fk_batch_trade_snapshot; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.batch
    ADD CONSTRAINT fk_batch_trade_snapshot FOREIGN KEY (trade_code_snapshot) REFERENCES identity.profession(code);


--
-- Name: alert; Type: ROW SECURITY; Schema: haccp; Owner: -
--

ALTER TABLE haccp.alert ENABLE ROW LEVEL SECURITY;

--
-- Name: alert haccp_alert_tenant_policy; Type: POLICY; Schema: haccp; Owner: -
--

CREATE POLICY haccp_alert_tenant_policy ON haccp.alert USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: app_user; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.app_user ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_session; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.auth_session ENABLE ROW LEVEL SECURITY;

--
-- Name: business_portal; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.business_portal ENABLE ROW LEVEL SECURITY;

--
-- Name: app_user identity_app_user_tenant_policy; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY identity_app_user_tenant_policy ON identity.app_user USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: auth_session identity_auth_session_tenant_policy; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY identity_auth_session_tenant_policy ON identity.auth_session USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: business_portal identity_business_portal_tenant_policy; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY identity_business_portal_tenant_policy ON identity.business_portal USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: profession identity_profession_reference_read; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY identity_profession_reference_read ON identity.profession FOR SELECT USING (true);


--
-- Name: store identity_store_tenant_policy; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY identity_store_tenant_policy ON identity.store USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: user_portal_assignment identity_user_portal_assignment_tenant_policy; Type: POLICY; Schema: identity; Owner: -
--

CREATE POLICY identity_user_portal_assignment_tenant_policy ON identity.user_portal_assignment USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: profession; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.profession ENABLE ROW LEVEL SECURITY;

--
-- Name: store; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.store ENABLE ROW LEVEL SECURITY;

--
-- Name: user_portal_assignment; Type: ROW SECURITY; Schema: identity; Owner: -
--

ALTER TABLE identity.user_portal_assignment ENABLE ROW LEVEL SECURITY;

--
-- Name: extracted_field; Type: ROW SECURITY; Schema: ingestion; Owner: -
--

ALTER TABLE ingestion.extracted_field ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_run; Type: ROW SECURITY; Schema: ingestion; Owner: -
--

ALTER TABLE ingestion.extraction_run ENABLE ROW LEVEL SECURITY;

--
-- Name: ingestion; Type: ROW SECURITY; Schema: ingestion; Owner: -
--

ALTER TABLE ingestion.ingestion ENABLE ROW LEVEL SECURITY;

--
-- Name: extracted_field ingestion_extracted_field_tenant_policy; Type: POLICY; Schema: ingestion; Owner: -
--

CREATE POLICY ingestion_extracted_field_tenant_policy ON ingestion.extracted_field USING ((EXISTS ( SELECT 1
   FROM (ingestion.extraction_run run
     JOIN ingestion.ingestion parent ON ((parent.id = run.ingestion_id)))
  WHERE ((run.id = extracted_field.extraction_run_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (ingestion.extraction_run run
     JOIN ingestion.ingestion parent ON ((parent.id = run.ingestion_id)))
  WHERE ((run.id = extracted_field.extraction_run_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true))))));


--
-- Name: extraction_run ingestion_extraction_run_tenant_policy; Type: POLICY; Schema: ingestion; Owner: -
--

CREATE POLICY ingestion_extraction_run_tenant_policy ON ingestion.extraction_run USING ((EXISTS ( SELECT 1
   FROM ingestion.ingestion parent
  WHERE ((parent.id = extraction_run.ingestion_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ingestion.ingestion parent
  WHERE ((parent.id = extraction_run.ingestion_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true))))));


--
-- Name: ingestion ingestion_ingestion_tenant_policy; Type: POLICY; Schema: ingestion; Owner: -
--

CREATE POLICY ingestion_ingestion_tenant_policy ON ingestion.ingestion USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: interim_field ingestion_interim_field_tenant_policy; Type: POLICY; Schema: ingestion; Owner: -
--

CREATE POLICY ingestion_interim_field_tenant_policy ON ingestion.interim_field USING ((EXISTS ( SELECT 1
   FROM ingestion.ingestion parent
  WHERE ((parent.id = interim_field.ingestion_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ingestion.ingestion parent
  WHERE ((parent.id = interim_field.ingestion_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true))))));


--
-- Name: raw_artifact ingestion_raw_artifact_tenant_policy; Type: POLICY; Schema: ingestion; Owner: -
--

CREATE POLICY ingestion_raw_artifact_tenant_policy ON ingestion.raw_artifact USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: request_idempotency ingestion_request_idempotency_tenant_policy; Type: POLICY; Schema: ingestion; Owner: -
--

CREATE POLICY ingestion_request_idempotency_tenant_policy ON ingestion.request_idempotency USING ((EXISTS ( SELECT 1
   FROM ingestion.ingestion parent
  WHERE ((parent.id = request_idempotency.ingestion_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ingestion.ingestion parent
  WHERE ((parent.id = request_idempotency.ingestion_id) AND ((parent.organization_id)::text = current_setting('labelscan.organization_id'::text, true))))));


--
-- Name: interim_field; Type: ROW SECURITY; Schema: ingestion; Owner: -
--

ALTER TABLE ingestion.interim_field ENABLE ROW LEVEL SECURITY;

--
-- Name: raw_artifact; Type: ROW SECURITY; Schema: ingestion; Owner: -
--

ALTER TABLE ingestion.raw_artifact ENABLE ROW LEVEL SECURITY;

--
-- Name: request_idempotency; Type: ROW SECURITY; Schema: ingestion; Owner: -
--

ALTER TABLE ingestion.request_idempotency ENABLE ROW LEVEL SECURITY;

--
-- Name: arrival_projection; Type: ROW SECURITY; Schema: traceability; Owner: -
--

ALTER TABLE traceability.arrival_projection ENABLE ROW LEVEL SECURITY;

--
-- Name: batch; Type: ROW SECURITY; Schema: traceability; Owner: -
--

ALTER TABLE traceability.batch ENABLE ROW LEVEL SECURITY;

--
-- Name: arrival_projection traceability_arrival_projection_tenant_policy; Type: POLICY; Schema: traceability; Owner: -
--

CREATE POLICY traceability_arrival_projection_tenant_policy ON traceability.arrival_projection USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: batch traceability_batch_tenant_policy; Type: POLICY; Schema: traceability; Owner: -
--

CREATE POLICY traceability_batch_tenant_policy ON traceability.batch USING (((organization_id)::text = current_setting('labelscan.organization_id'::text, true))) WITH CHECK (((organization_id)::text = current_setting('labelscan.organization_id'::text, true)));


--
-- Name: SCHEMA audit; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA audit TO labelscan_app;
GRANT USAGE ON SCHEMA audit TO labelscan_auditor;


--
-- Name: SCHEMA compliance; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA compliance TO labelscan_app;


--
-- Name: SCHEMA haccp; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA haccp TO labelscan_app;


--
-- Name: SCHEMA identity; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA identity TO labelscan_app;


--
-- Name: SCHEMA ingestion; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA ingestion TO labelscan_app;


--
-- Name: SCHEMA platform; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA platform TO labelscan_app;


--
-- Name: SCHEMA traceability; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA traceability TO labelscan_app;


--
-- Name: FUNCTION auth_session_organization_for_family(candidate_family uuid, candidate_user uuid); Type: ACL; Schema: identity; Owner: -
--

REVOKE ALL ON FUNCTION identity.auth_session_organization_for_family(candidate_family uuid, candidate_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION identity.auth_session_organization_for_family(candidate_family uuid, candidate_user uuid) TO labelscan_app;


--
-- Name: FUNCTION auth_session_organization_for_token(candidate_hash text); Type: ACL; Schema: identity; Owner: -
--

REVOKE ALL ON FUNCTION identity.auth_session_organization_for_token(candidate_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION identity.auth_session_organization_for_token(candidate_hash text) TO labelscan_app;


--
-- Name: FUNCTION audit_on_insert(); Type: ACL; Schema: platform; Owner: -
--

REVOKE ALL ON FUNCTION platform.audit_on_insert() FROM PUBLIC;


--
-- Name: FUNCTION default_organization_id(); Type: ACL; Schema: platform; Owner: -
--

REVOKE ALL ON FUNCTION platform.default_organization_id() FROM PUBLIC;
GRANT ALL ON FUNCTION platform.default_organization_id() TO labelscan_app;


--
-- Name: FUNCTION deny_mutation(); Type: ACL; Schema: platform; Owner: -
--

REVOKE ALL ON FUNCTION platform.deny_mutation() FROM PUBLIC;


--
-- Name: TABLE audit_log; Type: ACL; Schema: audit; Owner: -
--

GRANT INSERT ON TABLE audit.audit_log TO labelscan_auditor;
GRANT SELECT ON TABLE audit.audit_log TO labelscan_app;


--
-- Name: TABLE alert; Type: ACL; Schema: haccp; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE haccp.alert TO labelscan_app;


--
-- Name: TABLE control_plan; Type: ACL; Schema: haccp; Owner: -
--

GRANT SELECT,INSERT ON TABLE haccp.control_plan TO labelscan_app;


--
-- Name: TABLE temperature_log; Type: ACL; Schema: haccp; Owner: -
--

GRANT SELECT,INSERT ON TABLE haccp.temperature_log TO labelscan_app;


--
-- Name: TABLE app_user; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE identity.app_user TO labelscan_app;


--
-- Name: TABLE auth_session; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE identity.auth_session TO labelscan_app;


--
-- Name: TABLE business_portal; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE identity.business_portal TO labelscan_app;


--
-- Name: TABLE organization; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT ON TABLE identity.organization TO labelscan_app;


--
-- Name: TABLE profession; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT ON TABLE identity.profession TO labelscan_app;


--
-- Name: TABLE store; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE identity.store TO labelscan_app;


--
-- Name: TABLE user_portal_assignment; Type: ACL; Schema: identity; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE identity.user_portal_assignment TO labelscan_app;


--
-- Name: TABLE extracted_field; Type: ACL; Schema: ingestion; Owner: -
--

GRANT SELECT,INSERT ON TABLE ingestion.extracted_field TO labelscan_app;


--
-- Name: TABLE extraction_run; Type: ACL; Schema: ingestion; Owner: -
--

GRANT SELECT,INSERT ON TABLE ingestion.extraction_run TO labelscan_app;


--
-- Name: TABLE ingestion; Type: ACL; Schema: ingestion; Owner: -
--

GRANT SELECT,INSERT ON TABLE ingestion.ingestion TO labelscan_app;


--
-- Name: COLUMN ingestion.status; Type: ACL; Schema: ingestion; Owner: -
--

GRANT UPDATE(status) ON TABLE ingestion.ingestion TO labelscan_app;


--
-- Name: COLUMN ingestion.photo_rotation_degrees; Type: ACL; Schema: ingestion; Owner: -
--

GRANT UPDATE(photo_rotation_degrees) ON TABLE ingestion.ingestion TO labelscan_app;


--
-- Name: COLUMN ingestion.photo_base_rotation_degrees; Type: ACL; Schema: ingestion; Owner: -
--

GRANT UPDATE(photo_base_rotation_degrees) ON TABLE ingestion.ingestion TO labelscan_app;


--
-- Name: TABLE interim_field; Type: ACL; Schema: ingestion; Owner: -
--

GRANT SELECT,INSERT ON TABLE ingestion.interim_field TO labelscan_app;


--
-- Name: TABLE raw_artifact; Type: ACL; Schema: ingestion; Owner: -
--

GRANT SELECT,INSERT ON TABLE ingestion.raw_artifact TO labelscan_app;


--
-- Name: TABLE request_idempotency; Type: ACL; Schema: ingestion; Owner: -
--

GRANT SELECT,INSERT ON TABLE ingestion.request_idempotency TO labelscan_app;


--
-- Name: TABLE idempotency_key; Type: ACL; Schema: platform; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE platform.idempotency_key TO labelscan_app;


--
-- Name: TABLE outbox; Type: ACL; Schema: platform; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE platform.outbox TO labelscan_app;


--
-- Name: TABLE processed_event; Type: ACL; Schema: platform; Owner: -
--

GRANT SELECT,INSERT ON TABLE platform.processed_event TO labelscan_app;


--
-- Name: TABLE arrival_projection; Type: ACL; Schema: traceability; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE traceability.arrival_projection TO labelscan_app;


--
-- Name: TABLE batch; Type: ACL; Schema: traceability; Owner: -
--

GRANT SELECT,INSERT ON TABLE traceability.batch TO labelscan_app;


--
-- Name: TABLE product; Type: ACL; Schema: traceability; Owner: -
--

GRANT SELECT,INSERT ON TABLE traceability.product TO labelscan_app;


--
-- Name: TABLE supplier; Type: ACL; Schema: traceability; Owner: -
--

GRANT SELECT,INSERT ON TABLE traceability.supplier TO labelscan_app;


--
-- PostgreSQL database dump complete
--
