import process from 'node:process';
import { release } from 'node:os';
import type { HostFacts } from './contracts.js';

export function readHostFacts(): HostFacts {
  return { platform: process.platform, arch: process.arch, release: release(), nodeVersion: process.versions.node };
}
