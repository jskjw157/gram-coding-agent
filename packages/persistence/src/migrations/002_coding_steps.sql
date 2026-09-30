CREATE TABLE coding_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  workspace_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('INSTRUCTIONS', 'ANALYZE', 'MODIFY')),
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'APPLYING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE UNIQUE INDEX coding_steps_live_task_idx ON coding_steps(task_id)
  WHERE state IN ('PENDING', 'APPLYING');
