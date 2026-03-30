import { getActiveServerId } from '../api/client';

export function currentQueryServerScope(): string {
  return getActiveServerId() ?? 'no-server';
}
