/** HTTP Basic 认证（PRD FR-1.5 P0）。 */
import type { Credentials } from '../types.ts';

export function basicHeader(cred: Credentials): string {
  const raw = `${cred.username}:${cred.password}`;
  return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
}
