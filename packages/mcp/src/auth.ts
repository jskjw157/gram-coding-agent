import { timingSafeEqual } from 'node:crypto';

export function verifyInternalSecret(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;

  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  if (expectedBytes.length !== suppliedBytes.length) return false;
  return timingSafeEqual(expectedBytes, suppliedBytes);
}
