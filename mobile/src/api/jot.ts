import { createJotApi } from '@jot/shared';
import api from './client';

/**
 * The shared endpoint functions, bound to the active-server client. Call them
 * directly (`jot.notes.getAll()`); the modules beside this one hold only what
 * is platform-specific (React Native multipart bodies, downloads, session
 * capture). In tests, `jest.mock('../src/api/jot')` and `jest.mocked(jot)`.
 */
export const jot = createJotApi(api);
