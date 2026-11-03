import { createJotApi } from '@jot/shared';
import api from './client';

/**
 * The shared endpoint functions, bound to the active-server client. The
 * modules beside this one wrap them in mobile's names and add what is
 * platform-specific (React Native multipart parts, timeouts, abort signals).
 */
export const jot = createJotApi(api);
