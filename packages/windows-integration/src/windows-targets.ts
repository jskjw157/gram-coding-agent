import { WindowsIntegrationError } from './windows-integration-error.js';

export function isBoundedPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8192 &&
    value.trim().length > 0 &&
    !/\p{Cc}/u.test(value) &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}

export function validateWindowsPath(value: unknown): string {
  if (!isBoundedPath(value) || /["<>|?*,%]/u.test(value) || value.includes('/')) {
    throw new WindowsIntegrationError('INVALID_PATH');
  }

  const driveRooted = /^[a-z]:\\/i.test(value);
  const unc = value.startsWith('\\\\');
  if (!driveRooted && !unc) throw new WindowsIntegrationError('INVALID_PATH');
  let remainder = value.slice(driveRooted ? 3 : 2);
  if (remainder.endsWith('\\')) remainder = remainder.slice(0, -1);
  const segments = remainder === '' && driveRooted ? [] : remainder.split('\\');
  if (unc && segments.length < 2) throw new WindowsIntegrationError('INVALID_PATH');

  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      /[ .]$/u.test(segment) ||
      segment.includes(':') ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment) ||
      /\.\{[0-9a-f-]+\}$/i.test(segment)
    ) {
      throw new WindowsIntegrationError('INVALID_PATH');
    }
  }
  return value;
}

export function normalizeHttpUrl(value: unknown): string {
  if (!isBoundedPath(value) || /[\s",\\]/u.test(value)) throw new WindowsIntegrationError('INVALID_URL');
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) throw new WindowsIntegrationError('INVALID_URL');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WindowsIntegrationError('INVALID_URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    !isBoundedPath(url.href)
  ) {
    throw new WindowsIntegrationError('INVALID_URL');
  }
  return url.href;
}
