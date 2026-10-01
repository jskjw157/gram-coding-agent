-- 002: harden the approvals table.
--
-- Adds a nullable expires_at instant (set at approval time as
-- approved_at + APPROVAL_TTL_MS; NULL while PENDING), a CHECK limiting
-- status to the five lifecycle states, and a partial unique index that
-- forbids duplicate LIVE (PENDING, APPROVED) pairs while still allowing
-- a re-request after a TERMINAL (CONSUMED, DENIED, EXPIRED) state.
--
-- SQLite ALTER TABLE cannot ADD CONSTRAINT, so the status CHECK requires
-- a table rebuild with the CHECK defined inline. Every existing column,
-- the STRICT table option, the INTEGER PRIMARY KEY AUTOINCREMENT key, and
-- both FOREIGN KEY clauses are carried over verbatim, and every existing
-- row is copied over unchanged: if a row somehow exists the upgrade
-- preserves it (an out-of-range status or a duplicate live pair fails the
-- migration loudly instead of discarding rows). No category column is
-- added: the category is not obtainable at approval-creation time, and
-- consumption security is fully covered by task_id + operation_hash.
--
-- The rebuild runs inside the migrator's transaction with foreign keys
-- enforced, which is safe here: approvals is a pure child table (nothing
-- references it), so DROP/RENAME never orphans a parent row, and the
-- copied rows already satisfy the carried-over foreign keys.

CREATE TABLE approvals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  policy_decision_id INTEGER REFERENCES policy_decisions(id) ON DELETE CASCADE,
  operation_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'CONSUMED', 'DENIED', 'EXPIRED')),
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  expires_at TEXT
) STRICT;

INSERT INTO approvals_new (id, task_id, policy_decision_id, operation_hash, status, requested_at, approved_at, consumed_at)
  SELECT id, task_id, policy_decision_id, operation_hash, status, requested_at, approved_at, consumed_at FROM approvals;

-- Dropping the original table deletes its sqlite_sequence row, resetting the
-- AUTOINCREMENT watermark (e.g. after rows were inserted then deleted). Carry
-- the higher watermark onto the replacement before the swap so the next id
-- continues monotonically. No-op when the replacement already leads.
UPDATE sqlite_sequence
  SET seq = max(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'approvals'), seq))
  WHERE name = 'approvals_new';

DROP TABLE approvals;

ALTER TABLE approvals_new RENAME TO approvals;

-- DROP TABLE removed the v1 index; recreate it alongside the new one.
CREATE INDEX approvals_task_id_idx ON approvals(task_id);

CREATE UNIQUE INDEX approvals_live_pair_idx
  ON approvals(task_id, operation_hash)
  WHERE status IN ('PENDING', 'APPROVED');
