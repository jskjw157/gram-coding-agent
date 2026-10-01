CREATE TABLE verification_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  workspace_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES verification_plans(id),
  check_id INTEGER NOT NULL REFERENCES verification_checks(id),
  check_name TEXT NOT NULL CHECK(check_name IN ('secret-scan','diff-review')),
  head_sha TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','ACCEPTED','FAILED','INTERRUPTED')),
  decision TEXT CHECK(decision IN ('PASS','FAIL')),
  views_json TEXT NOT NULL DEFAULT '[]',
  approved_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE UNIQUE INDEX verification_reviews_active_task ON verification_reviews(task_id) WHERE state='PENDING';
CREATE UNIQUE INDEX verification_reviews_accepted_check ON verification_reviews(check_id) WHERE state='ACCEPTED';
