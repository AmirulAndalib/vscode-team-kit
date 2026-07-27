PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS debug_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO debug_meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS debug_sessions (
  session_id TEXT PRIMARY KEY,
  collector_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'describing', 'hypothesizing', 'instrumenting',
    'awaiting_reproduction', 'analyzing', 'fixing',
    'awaiting_direction', 'awaiting_verification', 'cleaning_up',
    'resolved', 'aborted', 'failed'
  )),
  symptom TEXT NOT NULL,
  expected_behavior TEXT,
  actual_behavior TEXT,
  reproduction_steps TEXT,
  affected_subsystem TEXT,
  collector_config_path TEXT,
  collector_pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS debug_validations (
  session_id TEXT NOT NULL,
  validation_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'preflight', 'reproduction', 'automated_test', 'verification', 'cleanup'
  )),
  command_or_steps TEXT NOT NULL,
  result TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, validation_id)
);

CREATE TABLE IF NOT EXISTS debug_snapshots (
  session_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  collector_session_id TEXT NOT NULL,
  min_sequence INTEGER NOT NULL CHECK (min_sequence >= 0),
  max_sequence INTEGER NOT NULL CHECK (max_sequence >= min_sequence),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  rejected_events INTEGER NOT NULL CHECK (rejected_events >= 0),
  storage_failures INTEGER NOT NULL CHECK (storage_failures >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS debug_rounds (
  session_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'planning', 'authorized', 'awaiting_reproduction', 'analyzing', 'closed'
  )),
  reproduction_validation_id INTEGER,
  snapshot_id INTEGER,
  outcome TEXT CHECK (outcome IN (
    'evidence_sufficient', 'inconclusive', 'aborted'
  )),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK (
    (status = 'closed'
      AND outcome IS NOT NULL
      AND closed_at IS NOT NULL
      AND (
        outcome = 'aborted'
        OR (reproduction_validation_id IS NOT NULL AND snapshot_id IS NOT NULL)
      ))
    OR
    (status <> 'closed'
      AND outcome IS NULL
      AND closed_at IS NULL)
  ),
  FOREIGN KEY (session_id, reproduction_validation_id)
    REFERENCES debug_validations (session_id, validation_id),
  FOREIGN KEY (session_id, snapshot_id)
    REFERENCES debug_snapshots (session_id, snapshot_id),
  PRIMARY KEY (session_id, round)
);

CREATE TABLE IF NOT EXISTS debug_hypotheses (
  session_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 1),
  theory TEXT NOT NULL,
  failure_mode TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  static_support TEXT NOT NULL,
  expected_signal TEXT NOT NULL,
  disproof_condition TEXT NOT NULL,
  probe_plan TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  static_exclusion TEXT,
  supersedes_round INTEGER CHECK (supersedes_round >= 1 AND supersedes_round < round),
  classification TEXT NOT NULL DEFAULT 'unclassified' CHECK (classification IN (
    'unclassified', 'supported', 'weakened', 'falsified',
    'inconclusive', 'not_exercised'
  )),
  reasoning TEXT,
  CHECK (
    (active = 1 AND static_exclusion IS NULL)
    OR (active = 0 AND static_exclusion IS NOT NULL)
  ),
  FOREIGN KEY (session_id, round) REFERENCES debug_rounds (session_id, round),
  PRIMARY KEY (session_id, hypothesis_id, round)
);

-- One row owns one physical marker block for cleanup.
CREATE TABLE IF NOT EXISTS debug_probes (
  session_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  marker_session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  location TEXT NOT NULL,
  collected_fields TEXT NOT NULL,
  marker TEXT NOT NULL,
  file_created INTEGER NOT NULL DEFAULT 0 CHECK (file_created IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  PRIMARY KEY (session_id, probe_id)
);

-- One row describes how a physical probe is used in one investigation round.
CREATE TABLE IF NOT EXISTS debug_probe_rounds (
  session_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 1),
  hypothesis_ids TEXT NOT NULL,
  event_label TEXT NOT NULL,
  estimated_max_events INTEGER NOT NULL CHECK (estimated_max_events >= 0),
  observer_effect TEXT NOT NULL,
  PRIMARY KEY (session_id, probe_id, round),
  UNIQUE (session_id, event_label),
  FOREIGN KEY (session_id, probe_id) REFERENCES debug_probes (session_id, probe_id),
  FOREIGN KEY (session_id, round) REFERENCES debug_rounds (session_id, round)
);

CREATE TABLE IF NOT EXISTS debug_evidence (
  session_id TEXT NOT NULL,
  collector_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  hypothesis_ids TEXT,
  event_kind TEXT NOT NULL,
  label TEXT NOT NULL,
  location TEXT,
  received_timestamp TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY (session_id, collector_session_id, sequence)
);

CREATE TABLE IF NOT EXISTS debug_decisions (
  session_id TEXT NOT NULL,
  decision_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  decision TEXT NOT NULL,
  evidence_sequences TEXT,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, decision_id)
);

CREATE TABLE IF NOT EXISTS debug_cleanup (
  session_id TEXT NOT NULL,
  cleanup_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, cleanup_id)
);

CREATE TRIGGER IF NOT EXISTS debug_rounds_insert_guard
BEFORE INSERT ON debug_rounds
WHEN NEW.status <> 'planning'
BEGIN
  SELECT RAISE(ABORT, 'new debug rounds must begin in planning');
END;

CREATE TRIGGER IF NOT EXISTS debug_rounds_transition_guard
BEFORE UPDATE OF status ON debug_rounds
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'planning' AND NEW.status = 'authorized')
  OR (OLD.status IN ('awaiting_reproduction', 'analyzing') AND NEW.status = 'authorized')
  OR (OLD.status = 'authorized' AND NEW.status = 'awaiting_reproduction')
  OR (OLD.status = 'awaiting_reproduction' AND NEW.status = 'analyzing')
  OR (OLD.status = 'analyzing' AND NEW.status IN ('awaiting_reproduction', 'closed'))
  OR (OLD.status IN ('planning', 'authorized', 'awaiting_reproduction') AND NEW.status = 'closed'
      AND NEW.outcome = 'aborted')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid debug round transition');
END;

CREATE TRIGGER IF NOT EXISTS debug_rounds_authorization_guard
BEFORE UPDATE OF status ON debug_rounds
WHEN NEW.status = 'authorized' AND (
  (SELECT COUNT(*) FROM debug_hypotheses
    WHERE session_id = NEW.session_id AND round = NEW.round AND active = 1) < 2
  OR
  (SELECT COUNT(DISTINCT failure_mode) FROM debug_hypotheses
    WHERE session_id = NEW.session_id AND round = NEW.round AND active = 1) < 2
  OR
  EXISTS (
    SELECT 1 FROM debug_hypotheses
    WHERE session_id = NEW.session_id
      AND round = NEW.round
      AND active = 1
      AND (
        trim(expected_signal) = ''
        OR trim(disproof_condition) = ''
        OR trim(probe_plan) = ''
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'debug round does not satisfy hypothesis breadth');
END;

CREATE TRIGGER IF NOT EXISTS debug_rounds_evidence_closure_guard
BEFORE UPDATE ON debug_rounds
WHEN NEW.status = 'closed'
  AND NEW.outcome IN ('evidence_sufficient', 'inconclusive')
  AND (
    NOT EXISTS (
      SELECT 1 FROM debug_validations
      WHERE session_id = NEW.session_id
        AND validation_id = NEW.reproduction_validation_id
        AND kind = 'reproduction'
        AND result = 'reproduced'
    )
    OR
    NOT EXISTS (
      SELECT 1 FROM debug_snapshots
      WHERE session_id = NEW.session_id
        AND snapshot_id = NEW.snapshot_id
        AND complete = 1
        AND rejected_events = 0
        AND storage_failures = 0
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'debug round requires reproduced validation and complete evidence');
END;

CREATE TRIGGER IF NOT EXISTS debug_rounds_closed_update_guard
BEFORE UPDATE ON debug_rounds
WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_rounds_closed_delete_guard
BEFORE DELETE ON debug_rounds
WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_probe_rounds_insert_guard
BEFORE INSERT ON debug_probe_rounds
WHEN NOT EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = NEW.session_id
    AND round = NEW.round
    AND status = 'authorized'
)
BEGIN
  SELECT RAISE(ABORT, 'probe plans require an authorized debug round');
END;

CREATE TRIGGER IF NOT EXISTS debug_hypotheses_closed_insert_guard
BEFORE INSERT ON debug_hypotheses
WHEN EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = NEW.session_id AND round = NEW.round AND status = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'closed debug rounds cannot accept hypotheses');
END;

CREATE TRIGGER IF NOT EXISTS debug_hypotheses_closed_update_guard
BEFORE UPDATE ON debug_hypotheses
WHEN EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = OLD.session_id AND round = OLD.round AND status = 'closed'
)
OR EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = NEW.session_id AND round = NEW.round AND status = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'hypotheses from closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_hypotheses_closed_delete_guard
BEFORE DELETE ON debug_hypotheses
WHEN EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = OLD.session_id AND round = OLD.round AND status = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'hypotheses from closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_probe_rounds_closed_update_guard
BEFORE UPDATE ON debug_probe_rounds
WHEN EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = OLD.session_id AND round = OLD.round AND status = 'closed'
)
OR EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = NEW.session_id AND round = NEW.round AND status = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'probe plans from closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_probe_rounds_closed_delete_guard
BEFORE DELETE ON debug_probe_rounds
WHEN EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = OLD.session_id AND round = OLD.round AND status = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'probe plans from closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_snapshots_closed_update_guard
BEFORE UPDATE ON debug_snapshots
WHEN EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = OLD.session_id
    AND snapshot_id = OLD.snapshot_id
    AND status = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'snapshots referenced by closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_snapshots_closed_delete_guard
BEFORE DELETE ON debug_snapshots
WHEN EXISTS (
  SELECT 1 FROM debug_rounds
  WHERE session_id = OLD.session_id
    AND snapshot_id = OLD.snapshot_id
    AND status = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'snapshots referenced by closed debug rounds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_evidence_closed_insert_guard
BEFORE INSERT ON debug_evidence
WHEN EXISTS (
  SELECT 1
  FROM debug_rounds AS r
  JOIN debug_snapshots AS s
    ON s.session_id = r.session_id AND s.snapshot_id = r.snapshot_id
  WHERE r.session_id = NEW.session_id
    AND r.status = 'closed'
    AND s.collector_session_id = NEW.collector_session_id
    AND NEW.sequence BETWEEN s.min_sequence AND s.max_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'closed debug snapshot evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_evidence_closed_update_guard
BEFORE UPDATE ON debug_evidence
WHEN EXISTS (
  SELECT 1
  FROM debug_rounds AS r
  JOIN debug_snapshots AS s
    ON s.session_id = r.session_id AND s.snapshot_id = r.snapshot_id
  WHERE r.session_id = OLD.session_id
    AND r.status = 'closed'
    AND s.collector_session_id = OLD.collector_session_id
    AND OLD.sequence BETWEEN s.min_sequence AND s.max_sequence
)
OR EXISTS (
  SELECT 1
  FROM debug_rounds AS r
  JOIN debug_snapshots AS s
    ON s.session_id = r.session_id AND s.snapshot_id = r.snapshot_id
  WHERE r.session_id = NEW.session_id
    AND r.status = 'closed'
    AND s.collector_session_id = NEW.collector_session_id
    AND NEW.sequence BETWEEN s.min_sequence AND s.max_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'closed debug snapshot evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS debug_evidence_closed_delete_guard
BEFORE DELETE ON debug_evidence
WHEN EXISTS (
  SELECT 1
  FROM debug_rounds AS r
  JOIN debug_snapshots AS s
    ON s.session_id = r.session_id AND s.snapshot_id = r.snapshot_id
  WHERE r.session_id = OLD.session_id
    AND r.status = 'closed'
    AND s.collector_session_id = OLD.collector_session_id
    AND OLD.sequence BETWEEN s.min_sequence AND s.max_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'closed debug snapshot evidence is immutable');
END;
