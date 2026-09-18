import type { PolicyDecisionKind, PublishMode } from '@gram/domain';
import type { NormalizedOperation } from './command-parser.js';

export interface PolicyContext {
  taskId: string;
  protectedBranches?: readonly string[];
  directMainGranted?: boolean;
  targetBranch?: string;
  publishMode?: PublishMode;
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

interface GitPushRefspec {
  raw: string;
  destination: string | undefined;
  force: boolean;
  delete: boolean;
}

function stripHeadsPrefix(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function parseGitPushRefspec(rawRefspec: string): GitPushRefspec {
  const force = rawRefspec.startsWith('+');
  const withoutForce = force ? rawRefspec.slice(1) : rawRefspec;
  const separator = withoutForce.lastIndexOf(':');
  const source = separator >= 0 ? withoutForce.slice(0, separator) : withoutForce;
  const destinationRef = separator >= 0 ? withoutForce.slice(separator + 1) : withoutForce;
  const destination = destinationRef.length > 0 ? stripHeadsPrefix(destinationRef) : undefined;

  return {
    raw: rawRefspec,
    destination,
    force,
    delete: separator >= 0 && source.length === 0,
  };
}

function gitPushRefspecs(args: readonly string[]): GitPushRefspec[] {
  const positional = args.filter((argument) => !argument.startsWith('-'));
  return positional.slice(2).map(parseGitPushRefspec);
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
    const refspecs = gitPushRefspecs(args);
    const forceByFlag = args.some(
      (argument) => argument === '-f' || argument === '--force' || argument.startsWith('--force-with-lease'),
    );
    const deleteByFlag = args.includes('--delete') || args.includes('-d');
    const broadPush = args.includes('--all') || args.includes('--mirror');

    if (args.includes('--mirror')) {
      return deny('POL-GIT-MIRROR', 'git push --mirror can overwrite or delete protected branches');
    }
    if (broadPush && forceByFlag) {
      return deny('POL-GIT-BROAD-FORCE', 'forced broad push can overwrite protected branches');
    }
    if (broadPush) {
      return approve('POL-GIT-BROAD-PUSH', 'broad branch publishing requires approval');
    }
    if (refspecs.length === 0) {
      return approve('POL-GIT-PUSH-UNRESOLVED', 'push destination is not explicit enough to prove it is non-protected');
    }

    const wildcardRefspec = refspecs.some((refspec) => refspec.destination?.includes('*') === true);
    const forceByRefspec = refspecs.some((refspec) => refspec.force);
    const deleteByRefspec = refspecs.some((refspec) => refspec.delete);
    if (wildcardRefspec && (forceByFlag || forceByRefspec || deleteByFlag || deleteByRefspec)) {
      return deny('POL-GIT-WILDCARD-DESTRUCTIVE', 'destructive wildcard push can affect protected branches');
    }
    if (wildcardRefspec) {
      return approve('POL-GIT-WILDCARD-PUSH', 'wildcard branch publishing requires approval');
    }

    for (const refspec of refspecs) {
      const protectedDestination = isProtected(refspec.destination, context);
      if (protectedDestination && (forceByFlag || refspec.force)) {
        return deny('POL-GIT-PROTECTED-FORCE', 'force-pushing a protected branch is forbidden');
      }
      if (protectedDestination && (deleteByFlag || refspec.delete)) {
        return deny('POL-GIT-PROTECTED-DELETE', 'deleting a protected branch is forbidden');
      }
    }

    if (refspecs.some((refspec) => isProtected(refspec.destination, context)) && context.directMainGranted !== true) {
      return approve('POL-GIT-PROTECTED-PUSH', 'protected-branch push needs an explicit task grant');
    }

    if (deleteByFlag || deleteByRefspec) {
      return approve('POL-GIT-DELETE', 'non-protected branch deletion requires approval');
    }

    return allow('POL-GIT-PUSH', 'normal explicit non-protected branch publishing is allowed');
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
