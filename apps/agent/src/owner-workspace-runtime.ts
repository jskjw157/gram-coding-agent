import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { LocalOperationRepository, openDatabase, type StoredRepository } from '@gram/persistence';
import type { SecretRedactor } from '@gram/secrets';
import type { LocalRepositoryInputValue } from '@gram/mcp';
import type { LocalDeveloperProject } from './local-developer.js';
import { LocalOwnerConsent } from './local-owner-consent.js';
import { LocalRecoveryStore } from './local-recovery-store.js';
import { OwnerWorkspaceCore, type OwnerWorkspaceRoot } from './owner-workspace-core.js';
import { FixedPosixWorkspaceTransport, PosixWorkspaceClient } from './posix-workspace-transport.js';
import { FixedWindowsWorkspaceTransport } from './windows-workspace-transport.js';
import { GIT_CHUNK_PATH, GIT_CHUNK_STAMP, WindowsWorkspaceClient, NativeWorkspaceDeniedError, NativeWorkspaceUnresolvedError, validateNativeWorkspaceOperation, type NativeWorkspaceOperation, type NativeWorkspaceReply, type NativeWorkspaceTransport } from './windows-workspace-client.js';
import { createWindowsOwnerConsentVerifier, createWindowsProtectedLocalViewer } from './windows-owner-consent-verifier.js';

interface Pin { path: string; sha256: string }
interface OwnerPin extends Pin { expectedOwnerSid: string }
export interface OwnerWorkspaceConfig {
  version: 1;
  roots: Record<string, OwnerWorkspaceRoot>;
  windows?: {
    helper: Pin; ownerPresence: OwnerPin; viewer?: OwnerPin;
    protectedPaths: string[]; protectedMutationPaths: string[];
    recoveryRoots: Record<string, { windowsPath: string; identity: string }>;
  };
  posix?: {
    artifacts: { bubblewrap: Pin; node: Pin; entry: Pin; worker: Pin; native: Pin };
    recoveryBase: string; recoveryRoots: Record<string, { path: string; identity: string }>;
  };
}
export interface OwnerWorkspaceRuntimeOptions {
  configPath: string; stateDirectory: string; secretDirectory: string; redactor: SecretRedactor;
  protectedReadPaths: string[]; protectedMutationPaths: string[];
  activeMutationPaths(): readonly string[];
}
export interface OwnerWorkspaceRuntime {
  core: OwnerWorkspaceCore;
  withProject<T>(input: LocalRepositoryInputValue, operation: (project: LocalDeveloperProject) => Promise<T>): Promise<T>;
  withRegisteredProject<T>(repository: StoredRepository, operation: (project: LocalDeveloperProject) => Promise<T>): Promise<T>;
  withRepositoryLeaseAdmission<T>(acquire: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const deny = () => new Error('Owner workspace runtime denied');
const inside = (parent: string, child: string) => parent === child || child.startsWith(parent === '/' ? '/' : `${parent}/`);
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
function canonical(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && posix.isAbsolute(value) &&
    posix.normalize(value) === value && !/[\\\p{Cc}\p{Cf}]/u.test(value);
}
function windowsPath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]:\\/u.test(value) && value.length <= 4096 &&
    !/[/\p{Cc}\p{Cf}<>"|?*]/u.test(value.slice(3).replaceAll('\\', '')) &&
    (value.length === 3 || value.slice(3).split('\\').every(p => p && p !== '.' && p !== '..' && !/[. :]$/u.test(p) && !p.includes(':')));
}
function linuxWindows(value: string): string {
  if (!windowsPath(value)) throw deny();
  return '/mnt/' + value[0]?.toLowerCase() + (value.length === 3 ? '' : '/' + value.slice(3).replaceAll('\\', '/'));
}
function toWindows(value: string): string | null {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/u.exec(value);
  return match?.[1] ? `${match[1].toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}` : null;
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw deny();
}
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  record(value);
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw deny();
}
function pin(value: unknown, owner = false): void {
  shape(value, ['path', 'sha256', ...(owner ? ['expectedOwnerSid'] : [])]);
  if (!canonical(value.path) || typeof value.sha256 !== 'string' || !GIT_CHUNK_STAMP.test(chunk.gitStamp) ||
                      (stamp !== undefined && chunk.gitStamp !== stamp) || typeof chunk.base64 !== 'string') throw deny();
                  const decoded = Buffer.from(chunk.base64, 'base64');
                  if (decoded.length !== length || decoded.toString('base64') !== chunk.base64) throw deny();
                  stamp = chunk.gitStamp;received += decoded.length;parts.push(decoded);
                }
                if (received !== entry.bytes) throw deny();
                const final = await backend.invoke(input.root, { operation: 'stat', path: relativePath });
                await verify();
                if (final.identity !== entry.identity || final.bytes !== entry.bytes) throw deny();
                bytes = Buffer.concat(parts, received);
              } else {
                const reply = await backend.invoke(input.root, { operation: 'read', path: relativePath });await verify();
                if (reply.base64 === undefined || reply.kind !== 'file' || reply.identity !== entry.identity) throw deny();
                bytes = Buffer.from(reply.base64, 'base64');
                if (bytes.length !== entry.bytes || bytes.toString('base64') !== reply.base64) throw deny();
              }
              // All bytes were admitted by the same native contained reader.
              const mode = root.kind === 'windows-drive' ? 0 : lstatSync(posix.join(root.wslPath, relativePath)).mode;
              return { bytes, executable: (mode & 0o111) !== 0 };
            },
          },
        });
        const after = await backend.invoke(input.root, { operation: 'stat', path: input.path });
        const current = directory(target, root.kind === 'wsl-directory');
        try {if (current.identity !== pinned.identity || after.identity !== before.identity || after.rootIdentity !== before.rootIdentity || realpathSync(`/proc/self/fd/${pinned.fd}`) !== target) throw deny();}
        finally {closeSync(current.fd);}
        if (mutations.some(path => overlap(path, target))) throw deny();return result;
      } finally {closeSync(pinned.fd);}
    }
    return { core,
      withRepositoryLeaseAdmission: acquire => run(() => reserveAdmission(acquire)),
      withProject: (input, operation) => run(() => project(input, operation)),
      withRegisteredProject: (repository, operation) => run(async () => {
        if (!canonical(repository.localBasePath)) throw deny();
        const entries = Object.entries(config.roots).filter(([, root]) => inside(root.wslPath, repository.localBasePath)).sort((a, b) => b[1].wslPath.length - a[1].wslPath.length);
        const match = entries[0];if (!match || !match[1].writable) throw deny();
        return project({ root: match[0], path: posix.relative(match[1].wslPath, repository.localBasePath) || '.' }, operation);
      }),
      close() {
        if (!closed) {closing = true;closed = (async () => {
          await Promise.allSettled([...pending]);db?.close();
          if (journalFd !== undefined) {closeSync(journalFd);journalFd = undefined;}
          for (const pin of rootPins.values()) closeSync(pin.fd);rootPins.clear();
        })();}return closed;
      },
    };
  } catch (error) {
    db?.close();if (journalFd !== undefined) closeSync(journalFd);
    for (const pin of rootPins.values()) closeSync(pin.fd);throw error;
  }
}
