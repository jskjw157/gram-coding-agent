CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  local_base_path TEXT NOT NULL,
  project_type TEXT,
  language TEXT,
  package_manager TEXT,
  commands_json TEXT,
  profile_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner, name)
) STRICT;

CREATE TABLE task_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_value INTEGER NOT NULL
) STRICT;
INSERT INTO task_sequence(singleton, next_value) VALUES (1, 1);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  goal TEXT NOT NULL,
  repo_id INTEGER REFERENCES repositories(id),
  repo_selector TEXT,
  status TEXT NOT NULL,
  task_type TEXT NOT NULL,
  publish_mode TEXT NOT NULL,
  direct_main_grant INTEGER NOT NULL DEFAULT 0 CHECK (direct_main_grant IN (0, 1)),
  base_branch TEXT,
  working_branch TEXT,
  base_commit TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  failure_class TEXT,
  failure_message TEXT,
  result_code TEXT,
  result_summary TEXT
) STRICT;
CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_repo_id_idx ON tasks(repo_id);

CREATE TABLE task_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  durable_output_json TEXT,
  failure_message TEXT,
  UNIQUE(task_id, step_key, attempt)
) STRICT;

CREATE TABLE command_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id INTEGER REFERENCES task_steps(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  cwd TEXT NOT NULL,
  executable TEXT,
  args_json TEXT,
  shell_text TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  stdout_path TEXT,
  stderr_path TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
) STRICT;
CREATE INDEX command_runs_task_id_idx ON command_runs(task_id);

CREATE TABLE repo_locks (
  repo_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  owner_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_boot_id TEXT NOT NULL
) STRICT;

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  linux_path TEXT NOT NULL,
  windows_path TEXT,
  branch TEXT NOT NULL,
  head_sha TEXT,
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  unpushed INTEGER NOT NULL DEFAULT 0 CHECK (unpushed IN (0, 1)),
  recovery_state TEXT,
  cleanup_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX workspaces_repo_id_idx ON workspaces(repo_id);

CREATE TABLE verification_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  head_sha TEXT,
  change_class TEXT NOT NULL,
  risk TEXT,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE verification_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES verification_plans(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  status TEXT NOT NULL,
  command_run_id INTEGER REFERENCES command_runs(id) ON DELETE SET NULL,
  evidence_ref TEXT,
  reason TEXT,
  started_at TEXT,
  finished_at TEXT
) STRICT;
CREATE INDEX verification_checks_task_id_idx ON verification_checks(task_id);

CREATE TABLE git_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  remote_name TEXT NOT NULL DEFAULT 'origin',
  remote_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (remote_confirmed IN (0, 1)),
  remote_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(repo_id, sha)
) STRICT;

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider_id TEXT,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, number)
) STRICT;

CREATE TABLE ci_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  pull_request_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  provider_run_id TEXT,
  provider_check_id TEXT,
  workflow_name TEXT,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  url TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX ci_runs_task_id_idx ON ci_runs(task_id);

CREATE TABLE policy_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  operation_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  normalized_operation_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX policy_decisions_task_id_idx ON policy_decisions(task_id);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  policy_decision_id INTEGER REFERENCES policy_decisions(id) ON DELETE CASCADE,
  operation_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT
) STRICT;
CREATE INDEX approvals_task_id_idx ON approvals(task_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX audit_events_task_id_idx ON audit_events(task_id);
