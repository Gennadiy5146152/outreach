CREATE TABLE IF NOT EXISTS company_research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_key text NOT NULL,
  rules_version text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','researching','review','ready','failed')),
  priority_tier integer NOT NULL CHECK (priority_tier BETWEEN 1 AND 4),
  priority_reason text NOT NULL,
  claimed_by text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_key, rules_version)
);

CREATE TABLE IF NOT EXISTS company_research_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES company_research_runs(id) ON DELETE CASCADE,
  canonical_url text NOT NULL,
  source_type text NOT NULL DEFAULT 'other',
  title text NOT NULL DEFAULT '',
  publisher text NOT NULL DEFAULT '',
  published_at timestamptz,
  excerpt text NOT NULL DEFAULT '' CHECK (char_length(excerpt) <= 500),
  trust_tier integer NOT NULL DEFAULT 5 CHECK (trust_tier BETWEEN 1 AND 5),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (research_run_id, canonical_url)
);

CREATE TABLE IF NOT EXISTS company_research_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES company_research_runs(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES company_research_sources(id) ON DELETE CASCADE,
  fact_type text NOT NULL DEFAULT 'other',
  fact_text text NOT NULL,
  evidence text NOT NULL CHECK (char_length(evidence) <= 500),
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  selected_for_copy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (research_run_id, source_id, fact_text)
);

CREATE TABLE IF NOT EXISTS company_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES company_research_runs(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES company_research_sources(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  email text,
  normalized_email text,
  email_status text NOT NULL DEFAULT 'needs_review'
    CHECK (email_status IN ('confirmed','needs_review','rejected')),
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  evidence text NOT NULL CHECK (char_length(evidence) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS company_contacts_email_unique
  ON company_contacts(research_run_id, normalized_email)
  WHERE normalized_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS company_research_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES company_research_runs(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES company_contacts(id) ON DELETE SET NULL,
  audience_key text NOT NULL,
  audience_type text NOT NULL CHECK (audience_type IN ('general','executive')),
  to_email text NOT NULL,
  contact_name text NOT NULL DEFAULT '',
  subject text NOT NULL,
  body_text text NOT NULL,
  followup_subject text NOT NULL,
  followup_body_text text NOT NULL,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','materialized','blocked')),
  materialized_draft_id uuid REFERENCES outreach_drafts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (research_run_id, audience_key)
);

CREATE INDEX IF NOT EXISTS company_research_runs_queue_idx
  ON company_research_runs(status, priority_tier, created_at);
CREATE INDEX IF NOT EXISTS company_research_sources_run_idx
  ON company_research_sources(research_run_id, trust_tier, created_at);
CREATE INDEX IF NOT EXISTS company_research_facts_run_idx
  ON company_research_facts(research_run_id, selected_for_copy DESC, confidence DESC);
CREATE INDEX IF NOT EXISTS company_contacts_run_idx
  ON company_contacts(research_run_id, email_status, confidence DESC);

