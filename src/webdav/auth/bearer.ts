/** Bearer Token 认证（PRD FR-1.5 P1）。 */
import type { Credentials } from '../types.ts';

/** Bearer 场景下 token 存于 password 字段。 */
export function bearerHeader(cred: Credentials): string {
  return 'Bearer ' + cred.password;
}
