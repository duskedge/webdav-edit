/** 认证方式聚合出口（PRD FR-1.5）。 */
import type { AuthType } from '../../connection/types.ts';

export { basicHeader } from './basic.ts';
export { bearerHeader } from './bearer.ts';
export { digestHeader, parseDigestChallenge } from './digest.ts';

/** 该认证方式在首个请求即可携带凭据（无需先吃一个 401 质询）。 */
export function canPreAuthenticate(authType: AuthType): boolean {
  return authType === 'basic' || authType === 'bearer';
}
