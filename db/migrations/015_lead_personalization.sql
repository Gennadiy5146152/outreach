CREATE TABLE IF NOT EXISTS personalization_pilots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_import_id uuid UNIQUE REFERENCES outreach_imports(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','running','completed','completed_with_errors','cancelled')),
  requested_limit integer NOT NULL CHECK (requested_limit BETWEEN 1 AND 30),
  rules_version text NOT NULL,
  selection_token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS lead_enrichments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('qualified','review','excluded','failed')),
  fit_score integer NOT NULL DEFAULT 0 CHECK (fit_score BETWEEN 0 AND 100),
  fit_reason text NOT NULL DEFAULT '',
  canonical_company text,
  business_type text,
  city text,
  contact_name text,
  contact_position text,
  contact_confidence numeric(4,3),
  alternative_contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  personalization_fact text,
  fact_source_url text,
  fact_evidence text,
  source_pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules_version text NOT NULL,
  model text,
  prompt_version text,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, rules_version)
);

CREATE TABLE IF NOT EXISTS personalization_pilot_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_id uuid NOT NULL REFERENCES personalization_pilots(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  lead_enrichment_id uuid REFERENCES lead_enrichments(id) ON DELETE SET NULL,
  draft_id uuid REFERENCES outreach_drafts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','enriching','qualified','review','excluded','generating','ready','failed')),
  status_reason text NOT NULL DEFAULT '',
  last_error text,
  source_row_number integer NOT NULL,
  manually_overridden_at timestamptz,
  manual_override_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pilot_id, lead_id)
);

ALTER TABLE outreach_drafts
  ADD COLUMN IF NOT EXISTS lead_enrichment_id uuid UNIQUE REFERENCES lead_enrichments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manually_edited_at timestamptz;

CREATE INDEX IF NOT EXISTS personalization_pilots_status_idx
  ON personalization_pilots(status, created_at DESC);
CREATE INDEX IF NOT EXISTS personalization_pilot_items_status_idx
  ON personalization_pilot_items(pilot_id, status, source_row_number);
CREATE INDEX IF NOT EXISTS lead_enrichments_status_idx
  ON lead_enrichments(status, fit_score DESC);
