-- 005_operations.sql — MAC-03 WP-10 Operations persistence (durable-before-effect, D11/D12).
-- Additive only. Does not modify 001_initial.sql.
-- Version 005 per WP-07 convergence next-migration rule: MAX(M2 001-004) + 1.
-- Creates operations/effects/leases/blocks/approval_details/schedules.

CREATE TABLE operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  revision INTEGER NOT NULL,
  requester_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  metadata_json TEXT,
  digest TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, step, revision),
  UNIQUE(requester_id, client_request_id)
) STRICT;
CREATE INDEX operations_task_id_idx ON operations(task_id);
CREATE INDEX operations_requester_idx ON operations(requester_id, client_request_id);

CREATE TABLE effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, kind, digest)
) STRICT;
CREATE INDEX effects_task_id_idx ON effects(task_id);
CREATE INDEX effects_operation_id_idx ON effects(operation_id);

CREATE TABLE leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE(operation_id, holder)
) STRICT;
CREATE INDEX leases_task_id_idx ON leases(task_id);
CREATE INDEX leases_operation_id_idx ON leases(operation_id);

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX blocks_task_id_idx ON blocks(task_id);
CREATE INDEX blocks_operation_id_idx ON blocks(operation_id);

CREATE TABLE approval_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_id INTEGER NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  approver TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at TEXT,
  note TEXT
) STRICT;
CREATE INDEX approval_details_task_id_idx ON approval_details(task_id);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_id INTEGER REFERENCES operations(id) ON DELETE CASCADE,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX schedules_task_id_idx ON schedules(task_id);
CREATE INDEX schedules_operation_id_idx ON schedules(operation_id);

-- NO NULL triggers: the domain forbids nulls on these columns. STRICT + NOT NULL
-- already rejects them, but explicit triggers give a stable domain-level error
-- and guard against future relaxations of the column definitions.

CREATE TRIGGER operations_no_null_task_id_insert BEFORE INSERT ON operations
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.task_id must not be null');
END;
CREATE TRIGGER operations_no_null_task_id_update BEFORE UPDATE ON operations
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.task_id must not be null');
END;
CREATE TRIGGER operations_no_null_step_insert BEFORE INSERT ON operations
WHEN NEW.step IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.step must not be null');
END;
CREATE TRIGGER operations_no_null_step_update BEFORE UPDATE ON operations
WHEN NEW.step IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.step must not be null');
END;
CREATE TRIGGER operations_no_null_revision_insert BEFORE INSERT ON operations
WHEN NEW.revision IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.revision must not be null');
END;
CREATE TRIGGER operations_no_null_revision_update BEFORE UPDATE ON operations
WHEN NEW.revision IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.revision must not be null');
END;
CREATE TRIGGER operations_no_null_requester_insert BEFORE INSERT ON operations
WHEN NEW.requester_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.requester_id must not be null');
END;
CREATE TRIGGER operations_no_null_requester_update BEFORE UPDATE ON operations
WHEN NEW.requester_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.requester_id must not be null');
END;
CREATE TRIGGER operations_no_null_client_request_insert BEFORE INSERT ON operations
WHEN NEW.client_request_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.client_request_id must not be null');
END;
CREATE TRIGGER operations_no_null_client_request_update BEFORE UPDATE ON operations
WHEN NEW.client_request_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'operations.client_request_id must not be null');
END;

CREATE TRIGGER effects_no_null_task_insert BEFORE INSERT ON effects
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.task_id must not be null');
END;
CREATE TRIGGER effects_no_null_task_update BEFORE UPDATE ON effects
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.task_id must not be null');
END;
CREATE TRIGGER effects_no_null_operation_insert BEFORE INSERT ON effects
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.operation_id must not be null');
END;
CREATE TRIGGER effects_no_null_operation_update BEFORE UPDATE ON effects
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.operation_id must not be null');
END;
CREATE TRIGGER effects_no_null_kind_insert BEFORE INSERT ON effects
WHEN NEW.kind IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.kind must not be null');
END;
CREATE TRIGGER effects_no_null_kind_update BEFORE UPDATE ON effects
WHEN NEW.kind IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.kind must not be null');
END;
CREATE TRIGGER effects_no_null_digest_insert BEFORE INSERT ON effects
WHEN NEW.digest IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.digest must not be null');
END;
CREATE TRIGGER effects_no_null_digest_update BEFORE UPDATE ON effects
WHEN NEW.digest IS NULL BEGIN
  SELECT RAISE(ABORT, 'effects.digest must not be null');
END;

CREATE TRIGGER leases_no_null_task_insert BEFORE INSERT ON leases
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.task_id must not be null');
END;
CREATE TRIGGER leases_no_null_task_update BEFORE UPDATE ON leases
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.task_id must not be null');
END;
CREATE TRIGGER leases_no_null_operation_insert BEFORE INSERT ON leases
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.operation_id must not be null');
END;
CREATE TRIGGER leases_no_null_operation_update BEFORE UPDATE ON leases
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.operation_id must not be null');
END;
CREATE TRIGGER leases_no_null_holder_insert BEFORE INSERT ON leases
WHEN NEW.holder IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.holder must not be null');
END;
CREATE TRIGGER leases_no_null_holder_update BEFORE UPDATE ON leases
WHEN NEW.holder IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.holder must not be null');
END;
CREATE TRIGGER leases_no_null_acquired_insert BEFORE INSERT ON leases
WHEN NEW.acquired_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.acquired_at must not be null');
END;
CREATE TRIGGER leases_no_null_acquired_update BEFORE UPDATE ON leases
WHEN NEW.acquired_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.acquired_at must not be null');
END;
CREATE TRIGGER leases_no_null_expires_insert BEFORE INSERT ON leases
WHEN NEW.expires_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.expires_at must not be null');
END;
CREATE TRIGGER leases_no_null_expires_update BEFORE UPDATE ON leases
WHEN NEW.expires_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'leases.expires_at must not be null');
END;

CREATE TRIGGER blocks_no_null_task_insert BEFORE INSERT ON blocks
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'blocks.task_id must not be null');
END;
CREATE TRIGGER blocks_no_null_task_update BEFORE UPDATE ON blocks
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'blocks.task_id must not be null');
END;
CREATE TRIGGER blocks_no_null_operation_insert BEFORE INSERT ON blocks
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'blocks.operation_id must not be null');
END;
CREATE TRIGGER blocks_no_null_operation_update BEFORE UPDATE ON blocks
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'blocks.operation_id must not be null');
END;
CREATE TRIGGER blocks_no_null_reason_insert BEFORE INSERT ON blocks
WHEN NEW.reason IS NULL BEGIN
  SELECT RAISE(ABORT, 'blocks.reason must not be null');
END;
CREATE TRIGGER blocks_no_null_reason_update BEFORE UPDATE ON blocks
WHEN NEW.reason IS NULL BEGIN
  SELECT RAISE(ABORT, 'blocks.reason must not be null');
END;

CREATE TRIGGER approval_details_no_null_task_insert BEFORE INSERT ON approval_details
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.task_id must not be null');
END;
CREATE TRIGGER approval_details_no_null_task_update BEFORE UPDATE ON approval_details
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.task_id must not be null');
END;
CREATE TRIGGER approval_details_no_null_operation_insert BEFORE INSERT ON approval_details
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.operation_id must not be null');
END;
CREATE TRIGGER approval_details_no_null_operation_update BEFORE UPDATE ON approval_details
WHEN NEW.operation_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.operation_id must not be null');
END;
CREATE TRIGGER approval_details_no_null_approver_insert BEFORE INSERT ON approval_details
WHEN NEW.approver IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.approver must not be null');
END;
CREATE TRIGGER approval_details_no_null_approver_update BEFORE UPDATE ON approval_details
WHEN NEW.approver IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.approver must not be null');
END;
CREATE TRIGGER approval_details_no_null_decision_insert BEFORE INSERT ON approval_details
WHEN NEW.decision IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.decision must not be null');
END;
CREATE TRIGGER approval_details_no_null_decision_update BEFORE UPDATE ON approval_details
WHEN NEW.decision IS NULL BEGIN
  SELECT RAISE(ABORT, 'approval_details.decision must not be null');
END;

CREATE TRIGGER schedules_no_null_task_insert BEFORE INSERT ON schedules
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'schedules.task_id must not be null');
END;
CREATE TRIGGER schedules_no_null_task_update BEFORE UPDATE ON schedules
WHEN NEW.task_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'schedules.task_id must not be null');
END;
CREATE TRIGGER schedules_no_null_run_at_insert BEFORE INSERT ON schedules
WHEN NEW.run_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'schedules.run_at must not be null');
END;
CREATE TRIGGER schedules_no_null_run_at_update BEFORE UPDATE ON schedules
WHEN NEW.run_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'schedules.run_at must not be null');
END;
CREATE TRIGGER schedules_no_null_status_insert BEFORE INSERT ON schedules
WHEN NEW.status IS NULL BEGIN
  SELECT RAISE(ABORT, 'schedules.status must not be null');
END;
CREATE TRIGGER schedules_no_null_status_update BEFORE UPDATE ON schedules
WHEN NEW.status IS NULL BEGIN
  SELECT RAISE(ABORT, 'schedules.status must not be null');
END;
