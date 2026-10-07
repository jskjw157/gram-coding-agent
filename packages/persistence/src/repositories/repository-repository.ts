import type Database from 'better-sqlite3';

export type RepositoryCommandName = 'lint' | 'test' | 'build' | 'dev';
export type RepositoryCommands = Partial<Record<RepositoryCommandName, string>>;

export interface StoredRepository {
  githubRepositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  localBasePath: string;
  projectType?: string;
  language?: string;
  packageManager?: string;
  commands: RepositoryCommands;
  profile: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRepositoryInput {
  githubRepositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  localBasePath: string;
  projectType?: string;
  language?: string;
  packageManager?: string;
  commands?: RepositoryCommands;
  profile?: Record<string, unknown>;
}

interface RepositoryRow {
  id: number;
  owner: string;
  name: string;
  default_branch: string;
  local_base_path: string;
  project_type: string | null;
  language: string | null;
  package_manager: string | null;
  commands_json: string | null;
  profile_json: string | null;
  created_at: string;
  updated_at: string;
}

export class AmbiguousRepositorySelectorError extends Error {
  constructor(selector: string) {
    super(`Repository selector is ambiguous: ${selector}`);
    this.name = 'AmbiguousRepositorySelectorError';
  }
}

function decode(row: RepositoryRow): StoredRepository {
  return {
    githubRepositoryId: row.id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    localBasePath: row.local_base_path,
    ...(row.project_type === null ? {} : { projectType: row.project_type }),
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.package_manager === null ? {} : { packageManager: row.package_manager }),
    commands: row.commands_json === null ? {} : (JSON.parse(row.commands_json) as RepositoryCommands),
    profile:
      row.profile_json === null ? {} : (JSON.parse(row.profile_json) as Record<string, unknown>),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RepositoryRepository {
  constructor(private readonly db: Database.Database) {}

  getById(githubRepositoryId: number): StoredRepository | undefined {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE id = ?')
      .get(githubRepositoryId) as RepositoryRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  findBySelector(selector: string): StoredRepository | undefined {
    const normalized = selector.trim();
    if (normalized.length === 0) return undefined;

    const slash = normalized.indexOf('/');
    if (slash > 0 && slash < normalized.length - 1) {
      const owner = normalized.slice(0, slash);
      const name = normalized.slice(slash + 1);
      const row = this.db
        .prepare(
          'SELECT * FROM repositories WHERE owner = ? COLLATE NOCASE AND name = ? COLLATE NOCASE',
        )
        .get(owner, name) as RepositoryRow | undefined;
      return row === undefined ? undefined : decode(row);
    }

    const rows = this.db
      .prepare('SELECT * FROM repositories WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 2')
      .all(normalized) as RepositoryRow[];
    if (rows.length > 1) throw new AmbiguousRepositorySelectorError(selector);
    return rows[0] === undefined ? undefined : decode(rows[0]);
  }

  upsert(input: UpsertRepositoryInput): StoredRepository {
    if (!Number.isSafeInteger(input.githubRepositoryId) || input.githubRepositoryId <= 0) {
      throw new Error('githubRepositoryId must be a positive safe integer');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO repositories (
          id, owner, name, default_branch, local_base_path, project_type, language,
          package_manager, commands_json, profile_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          owner = excluded.owner,
          name = excluded.name,
          default_branch = excluded.default_branch,
          local_base_path = excluded.local_base_path,
          project_type = excluded.project_type,
          language = excluded.language,
          package_manager = excluded.package_manager,
          commands_json = excluded.commands_json,
          profile_json = excluded.profile_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.githubRepositoryId,
        input.owner,
        input.name,
        input.defaultBranch,
        input.localBasePath,
        input.projectType ?? null,
        input.language ?? null,
        input.packageManager ?? null,
        JSON.stringify(input.commands ?? {}),
        JSON.stringify(input.profile ?? {}),
        now,
        now,
      );

    const stored = this.getById(input.githubRepositoryId);
    if (stored === undefined) throw new Error('Repository row was not persisted');
    return stored;
  }
}
