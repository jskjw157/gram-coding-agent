import type { PolicyDecisionKind } from '@gram/domain';
import type { NormalizedOperation } from './command-parser.js';

export interface PolicyContext {
  taskId: string;
  protectedBranches?: readonly string[];
  directMainGranted?: boolean;
}

export interface ClassifiedRisk {
  kind: PolicyDecisionKind;
  ruleId: string;
  reason: string;
}

const allow = (ruleId: string, reason: string): ClassifiedRisk => ({ kind: 'ALLOW', ruleId, reason });
const approve = (ruleId: string, reason: string): ClassifiedRisk => ({ kind: 'NEEDS_APPROVAL', ruleId, reason });
const deny = (ruleId: string, reason: string): ClassifiedRisk => ({ kind: 'DENY', ruleId, reason });

function isProtected(branch: string | undefined, context: PolicyContext): boolean {
  if (branch === undefined) return false;
  const protectedBranches = context.protectedBranches ?? ['main', 'master'];
  return protectedBranches.includes(branch);
}

function gitPushTarget(args: readonly string[]): string | undefined {
  const positional = args.filter((argument) => !argument.startsWith('-'));
  return positional[2] ?? positional[1];
}

function classifyGit(args: readonly string[], context: PolicyContext): ClassifiedRisk {
  const subcommand = args[0];
  if (subcommand === undefined) return approve('POL-GIT-UNKNOWN', 'git invocation without a subcommand requires approval');

  if (subcommand === 'reset' && args.includes('--hard')) {
    return approve('POL-GIT-RESET-HARD', 'hard reset can discard local work');
  }
  if (subcommand === 'clean' && args.some((argument) => argument.includes('f'))) {
    return approve('POL-GIT-CLEAN', 'git clean can irreversibly delete untracked files');
  }
  if (subcommand === 'push') {
    const target = gitPushTarget(args);
    const force = args.some((argument) => argument === '-f' || argument === '--force' || argument.startsWith('--force-with-lease'));
    const deletes = args.includes('--delete') || target?.startsWith(':') === true;
    const normalizedTarget = target?.startsWith(':') === true ? target.slice(1) : target;

    if (force && isProtected(normalizedTarget, context)) {
      return deny('POL-GIT-PROTECTED-FORCE', 'force-pushing a protected branch is forbidden');
    }
    if (deletes && isProtected(normalizedTarget, context)) {
      return deny('POL-GIT-PROTECTED-DELETE', 'deleting a protected branch is forbidden');
    }
    if (isProtected(normalizedTarget, context) && context.directMainGranted !== true) {
      return approve('POL-GIT-PROTECTED-PUSH', 'protected-branch push needs an explicit task grant');
    }
    return allow('POL-GIT-PUSH', 'normal non-protected branch publishing is allowed');
  }

  if (['status', 'diff', 'log', 'blame', 'fetch', 'pull', 'branch', 'show', 'rev-parse'].includes(subcommand)) {
    return allow('POL-GIT-READ-NORMAL', 'normal Git inspection and synchronization is allowed');
  }
  if (['add', 'commit', 'checkout', 'switch'].includes(subcommand)) {
    return allow('POL-GIT-TASK-MUTATION', 'normal task-branch Git mutation is allowed');
  }
  return approve('POL-GIT-OTHER', 'unclassified Git mutation requires approval');
}

function classifyPackageManager(executable: string, args: readonly string[]): ClassifiedRisk {
  const action = args[0];
  const safeActions = new Set(['install', 'i', 'test', 'build', 'lint', 'typecheck', 'check', 'run', 'exec', 'dlx']);
  if (action === undefined || safeActions.has(action)) {
    return allow('POL-DEV-PACKAGE', `${executable} development workflow is allowed`);
  }
  return approve('POL-DEV-PACKAGE-OTHER', `unclassified ${executable} operation requires approval`);
}

export function classifyRisk(operation: NormalizedOperation, context: PolicyContext): ClassifiedRisk {
  const { executable, args } = operation;

  if (executable === 'powershell.exe' || executable === 'pwsh.exe' || executable === 'cmd.exe' || executable.endsWith('.exe')) {
    return approve('POL-WIN-RAW-EXEC', 'raw Windows executable invocation is approval-gated');
  }
  if (executable === 'mkfs' || executable.startsWith('mkfs.') || executable === 'wipefs') {
    return deny('POL-BLOCK-DEVICE-DESTRUCTIVE', 'filesystem/block-device destructive operations are forbidden');
  }
  if (executable === 'rm' || executable === 'rmdir') {
    const recursive = args.some((argument) => argument === '-r' || argument === '-R' || argument.includes('r'));
    const rootDestructive = operation.canonicalTargets.some((target) => target === '/' || target === '/mnt/c');
    if (recursive && rootDestructive) return deny('POL-RM-ROOT', 'recursive deletion of a protected root is forbidden');
    if (operation.pathResolutionFailed) return approve('POL-PATH-UNRESOLVED', 'destructive target could not be canonicalized');
    if (recursive) return approve('POL-RM-RECURSIVE', 'recursive deletion requires approval');
    return allow('POL-RM-FILE', 'non-recursive file removal is allowed');
  }
  if (executable === 'git') return classifyGit(args, context);
  if (executable === 'pnpm' || executable === 'npm' || executable === 'yarn') return classifyPackageManager(executable, args);
  if (executable === 'apt' || executable === 'apt-get') {
    if (args[0] === 'install') return allow('POL-APT-INSTALL', 'ordinary package installation is allowed');
    if (args[0] === 'remove' || args[0] === 'purge') return approve('POL-APT-REMOVE', 'package removal requires approval');
    return approve('POL-APT-OTHER', 'unclassified package-manager operation requires approval');
  }
  if (['echo', 'printf', 'cat', 'grep', 'rg', 'find', 'ls', 'pwd', 'which', 'node', 'npx', 'python', 'python3', 'pytest', 'java', 'gradle', 'mvn'].includes(executable)) {
    return allow('POL-DEV-NORMAL', 'ordinary development/read operation is allowed');
  }

  return approve('POL-UNKNOWN-COMMAND', 'unclassified executable requires approval');
}
