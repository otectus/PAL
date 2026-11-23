// The job ledger contains references only. Every model-written string lives in an
// assessment linked to its inputs and is deleted with any of those inputs.
export const curationMigrationSql = `
ALTER TABLE extraction_runs ADD COLUMN covered_codepoints INTEGER NOT NULL DEFAULT 0;
CREATE TABLE memory_statements(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id)) STRICT;
CREATE TABLE memory_statement_versions(
 version_id TEXT PRIMARY KEY,logical_id TEXT NOT NULL REFERENCES memory_statements(id),scope_id TEXT NOT NULL REFERENCES scopes(id),
 category TEXT NOT NULL,text TEXT NOT NULL,subject_id TEXT REFERENCES entities(id),status TEXT NOT NULL,modality TEXT NOT NULL,
 epistemic_type TEXT NOT NULL,valid_mode TEXT NOT NULL,valid_from_us INTEGER,valid_to_us INTEGER,conflict_set_id TEXT,
 known_from_us INTEGER NOT NULL,known_from_revision INTEGER NOT NULL,known_to_revision INTEGER,aggregate_revision INTEGER NOT NULL,
 sensitivity TEXT NOT NULL,expires_at_us INTEGER,erased INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX statements_scope ON memory_statement_versions(scope_id,status,expires_at_us);
CREATE INDEX statements_logical ON memory_statement_versions(logical_id,known_to_revision);
CREATE TABLE memory_statement_evidence(version_id TEXT NOT NULL REFERENCES memory_statement_versions(version_id),evidence_id TEXT NOT NULL REFERENCES evidence(id),PRIMARY KEY(version_id,evidence_id)) STRICT;
CREATE INDEX statement_support ON memory_statement_evidence(evidence_id,version_id);
CREATE TABLE memory_extractor_hints(version_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES extraction_runs(id),importance REAL NOT NULL,durability REAL NOT NULL,PRIMARY KEY(version_id,run_id)) STRICT;

CREATE TABLE memory_curation_jobs(
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id), kind TEXT NOT NULL, version_id TEXT NOT NULL, logical_id TEXT NOT NULL,
 config_revision INTEGER NOT NULL, policy_epoch INTEGER NOT NULL, erasure_epoch INTEGER NOT NULL, input_hash TEXT,
 state TEXT NOT NULL, created_us INTEGER NOT NULL, due_us INTEGER NOT NULL, priority_us INTEGER NOT NULL,
 lease_token TEXT,lease_until_us INTEGER,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,
 UNIQUE(version_id,config_revision,policy_epoch,erasure_epoch)
) STRICT;
CREATE INDEX curation_due ON memory_curation_jobs(state,due_us,priority_us);
CREATE INDEX curation_scope ON memory_curation_jobs(scope_id,state,created_us);
CREATE INDEX curation_target ON memory_curation_jobs(version_id);
CREATE INDEX assertion_curation ON assertion_versions(scope_id,status,expires_at_us) WHERE erased=0 AND known_to_revision IS NULL;
CREATE TABLE memory_assessments(
 id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES memory_curation_jobs(id) ON DELETE CASCADE,version_id TEXT NOT NULL,
 output TEXT NOT NULL,verdict TEXT,producer TEXT NOT NULL,input_hash TEXT NOT NULL,rubric TEXT NOT NULL,
 assessed_value REAL,created_us INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX assessment_version ON memory_assessments(version_id);
CREATE TABLE memory_assessment_inputs(assessment_id TEXT NOT NULL REFERENCES memory_assessments(id) ON DELETE CASCADE,input_id TEXT NOT NULL,PRIMARY KEY(assessment_id,input_id)) STRICT;
CREATE INDEX assessment_dependency ON memory_assessment_inputs(input_id);
CREATE TABLE memory_curation_decisions(
 id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_curation_jobs(id) ON DELETE CASCADE,assessment_id TEXT REFERENCES memory_assessments(id) ON DELETE SET NULL,producer_ref TEXT,
 actor TEXT NOT NULL,rule TEXT NOT NULL,action TEXT NOT NULL,before_id TEXT NOT NULL,after_id TEXT,hold_id TEXT,revision INTEGER NOT NULL,created_us INTEGER NOT NULL,undone_revision INTEGER
) STRICT;
CREATE INDEX decisions_target ON memory_curation_decisions(job_id,created_us);
CREATE TABLE memory_curation_usage(id TEXT PRIMARY KEY,day TEXT NOT NULL,task TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cost_micros INTEGER,state TEXT NOT NULL,route TEXT,input_price INTEGER,output_price INTEGER) STRICT;
CREATE INDEX usage_day ON memory_curation_usage(day);
CREATE TABLE memory_synthesis(episode_id TEXT NOT NULL REFERENCES episodes(id),generation INTEGER NOT NULL,config_revision INTEGER NOT NULL,
 state TEXT NOT NULL,lease_us INTEGER NOT NULL,lease_token TEXT,artifact_id TEXT,producer TEXT,sentence_links TEXT,error_code TEXT,PRIMARY KEY(episode_id,generation,config_revision)) STRICT;
CREATE INDEX synthesis_artifact ON memory_synthesis(artifact_id);
CREATE TABLE memory_model_evaluations(fingerprint TEXT NOT NULL,rubric TEXT NOT NULL,dataset TEXT NOT NULL,result TEXT NOT NULL,evaluated_us INTEGER NOT NULL,PRIMARY KEY(fingerprint,rubric,dataset)) STRICT;
`;
