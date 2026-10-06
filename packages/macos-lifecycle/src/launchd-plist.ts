import { labels, root, type Role, type ServiceConfig } from './contracts.js';
import { parseConfig } from './config.js';

export function xmlText(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  };
  return value.replace(/[&<>"']/g, character => entities[character] ?? character);
}
/** Rendering only: does not validate a release, install a job, or enable a tunnel. */
export function renderPlist(config: ServiceConfig, role: Role): string {
  const normalized = parseConfig(config);
  if ((role !== 'core' && role !== 'tunnel') || (role === 'tunnel' && !normalized.tunnel.enabled)) {
    throw new Error('INVALID_CONFIG');
  }
  const release = `${root}/releases/${normalized.releaseId}`;
  const text = (value: string) => `<string>${xmlText(value)}</string>`;
  const argumentsXml = [
    `${release}/bin/node`, `${release}/packages/macos-lifecycle/dist/supervisor-cli.js`,
    '--role', role, '--config', `${root}/config/service.json`,
  ].map(text).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>\n'
    + `<key>Label</key>${text(labels[role])}\n`
    + `<key>UserName</key>${text(normalized.runtimeUser)}\n`
    + `<key>ProgramArguments</key><array>${argumentsXml}</array>\n`
    + `<key>WorkingDirectory</key>${text(release)}\n`
    + '<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n'
    + '<key>ThrottleInterval</key><integer>30</integer>\n'
    + '<key>ExitTimeOut</key><integer>30</integer>\n<key>Umask</key><integer>63</integer>\n'
    + '<key>StandardOutPath</key><string>/dev/null</string>\n'
    + '<key>StandardErrorPath</key><string>/dev/null</string>\n'
    + '</dict></plist>\n';
}
