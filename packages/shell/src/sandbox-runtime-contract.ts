// Derived from fixed official artifacts; shared with scripts/stage-sandbox-node.py.
// Canonical manifest: ASCII sorted paths; compact JSON five-tuples, no newline.
export const RUNTIME_RECEIPT = {
  "schemaVersion": 1,
  "policyVersion": "linux-node-v1-runtime-1",
  "nodeVersion": "24.21.0",
  "nodeArchiveSha256": "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6",
  "pnpmVersion": "10.34.5",
  "pnpmTarballSha512": "pO4F8vc2WCVb1qiYWcBlpFwopX2u+uLIk6Fo7itzFow3uR6D5X6mdlStA/AwMXRkMOi84442LgQmBfuKvIAZLg==",
  "fileCount": 3705,
  "treeSha256": "2e89512825a43334ef6e73a62bd71b777b029042eecbca361d9c7a62df6ebc61"
} as const;

export const SANDBOX_RUNTIME_MANIFEST_GOLDEN = "[[\"bin\",\"directory\",493,0,\"\"],[\"bin/node\",\"file\",493,3,\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\"],[\"bin/npm\",\"symlink\",511,38,\"../lib/node_modules/npm/bin/npm-cli.js\"]]";
export const SANDBOX_RUNTIME_MANIFEST_GOLDEN_SHA256 = "a9bd2aa0ecc4481eacb10dae6bd7c84cf1e6a748466374915943260f7ae7f363";

export const RUNTIME_ROOT = '/opt/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified';
export const RUNTIME_NODE_SHA256 = '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c';
export const RUNTIME_LINKS = {
  'bin/npm': '../lib/node_modules/npm/bin/npm-cli.js',
  'bin/npx': '../lib/node_modules/npm/bin/npx-cli.js',
  'bin/pnpm': '../lib/node_modules/pnpm/bin/pnpm.cjs',
} as const;
