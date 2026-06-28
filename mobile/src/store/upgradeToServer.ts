import axios from 'axios';
import { generateId, canonicalizeServerOrigin } from '@jot/shared';

export interface UpgradeSession {
  serverUrl: string;
  sessionToken: string;
}

export type CapabilityFailReason =
  | 'CLIENT_ID_NOT_HONORED'
  | 'DEDUP_409_MISSING'
  | 'ENDPOINT_SHAPE_ERROR';

export type EmptinessFailReason =
  | 'NOTES_NOT_EMPTY'
  | 'LABELS_NOT_EMPTY'
  | 'FETCH_FAILED';

export type PreflightFailReason = CapabilityFailReason | EmptinessFailReason;

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: PreflightFailReason };

/** Thin HTTP wrapper injected into gate functions for testability. */
export interface UpgradeClient {
  post(path: string, data: unknown): Promise<{ status: number; data: unknown }>;
  get(path: string): Promise<{ status: number; data: unknown }>;
  delete(path: string, params?: Record<string, unknown>): Promise<{ status: number }>;
}

/** Build an UpgradeClient for a real server URL and session token. */
export function makeUpgradeClient(serverUrl: string, sessionToken: string): UpgradeClient {
  const instance = axios.create({
    baseURL: `${serverUrl}/api/v1`,
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `jot_session=${sessionToken}`,
    },
    validateStatus: () => true,
  });
  return {
    async post(path, data) {
      const res = await instance.post(path, data);
      return { status: res.status, data: res.data };
    },
    async get(path) {
      const res = await instance.get(path);
      return { status: res.status, data: res.data };
    },
    async delete(path, params) {
      const res = await instance.delete(path, { params });
      return { status: res.status };
    },
  };
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const match = header.match(/jot_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Register a new account on the target server using a standalone axios call
 * so the current local-mode session is never touched.
 */
export async function registerOnServer(
  serverUrl: string,
  username: string,
  password: string,
): Promise<UpgradeSession> {
  const canonical = canonicalizeServerOrigin(serverUrl);
  if (!canonical) {
    throw Object.assign(new Error('Invalid server URL'), { code: 'INVALID_URL' as const });
  }
  const res = await axios.post(
    `${canonical}/api/v1/register`,
    { username, password },
    {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    },
  );
  if (res.status === 409) {
    throw Object.assign(new Error('Username already taken'), { code: 'USERNAME_TAKEN' as const });
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = typeof res.data === 'string' && res.data ? res.data : 'Registration failed';
    throw Object.assign(new Error(msg), { code: 'REGISTRATION_FAILED' as const });
  }
  const sessionToken = extractSessionCookie(
    (res.headers as Record<string, string | string[] | undefined>)['set-cookie'],
  );
  if (!sessionToken) {
    throw Object.assign(new Error('No session in registration response'), { code: 'NO_SESSION' as const });
  }
  return { serverUrl: canonical, sessionToken };
}

/**
 * Gate 1: Verify the server honors client-supplied IDs on POST /notes,
 * POST /notes/{id}/items, and POST /labels, and returns 409 on duplicate.
 * Probe entities are cleaned up in a finally block regardless of outcome.
 */
export async function checkCapabilityGate(client: UpgradeClient): Promise<PreflightResult> {
  const probeNoteId = generateId();
  const probeItemId = generateId();
  const probeLabelId = generateId();
  const probeLabelName = `_jot_probe_${generateId()}`;

  try {
    // Note probe: create then duplicate
    const noteCreate1 = await client.post('/notes', {
      id: probeNoteId,
      note_type: 'list',
      title: '',
    });
    if (noteCreate1.status !== 200 && noteCreate1.status !== 201) {
      return { ok: false, reason: 'ENDPOINT_SHAPE_ERROR' };
    }
    const noteData = noteCreate1.data as { id?: string };
    if (noteData.id !== probeNoteId) {
      return { ok: false, reason: 'CLIENT_ID_NOT_HONORED' };
    }
    const noteCreate2 = await client.post('/notes', {
      id: probeNoteId,
      note_type: 'list',
      title: '',
    });
    if (noteCreate2.status !== 409) {
      return { ok: false, reason: 'DEDUP_409_MISSING' };
    }

    // Item probe: create then duplicate on the probe note
    const itemCreate1 = await client.post(`/notes/${probeNoteId}/items`, {
      id: probeItemId,
      text: '',
      position: 0,
    });
    if (itemCreate1.status !== 200 && itemCreate1.status !== 201) {
      return { ok: false, reason: 'ENDPOINT_SHAPE_ERROR' };
    }
    const itemData = itemCreate1.data as { id?: string };
    if (itemData.id !== probeItemId) {
      return { ok: false, reason: 'CLIENT_ID_NOT_HONORED' };
    }
    const itemCreate2 = await client.post(`/notes/${probeNoteId}/items`, {
      id: probeItemId,
      text: '',
      position: 0,
    });
    if (itemCreate2.status !== 409) {
      return { ok: false, reason: 'DEDUP_409_MISSING' };
    }

    // Label probe: create then duplicate
    const labelCreate1 = await client.post('/labels', {
      id: probeLabelId,
      name: probeLabelName,
    });
    if (labelCreate1.status !== 200 && labelCreate1.status !== 201) {
      return { ok: false, reason: 'ENDPOINT_SHAPE_ERROR' };
    }
    const labelData = labelCreate1.data as { id?: string };
    if (labelData.id !== probeLabelId) {
      return { ok: false, reason: 'CLIENT_ID_NOT_HONORED' };
    }
    const labelCreate2 = await client.post('/labels', {
      id: probeLabelId,
      name: probeLabelName,
    });
    if (labelCreate2.status !== 409) {
      return { ok: false, reason: 'DEDUP_409_MISSING' };
    }

    return { ok: true };
  } finally {
    // Best-effort cleanup — probe garbage is harmless on a fresh account but tidy to remove.
    await client.delete(`/notes/${probeNoteId}`, { permanent: true }).catch(() => {});
    await client.delete(`/labels/${probeLabelId}`).catch(() => {});
  }
}

/**
 * Gate 2: Verify the freshly registered account has no existing notes or labels.
 * Abort if non-empty — no merge support in this iteration.
 */
export async function checkEmptinessGate(client: UpgradeClient): Promise<PreflightResult> {
  const notesRes = await client.get('/notes').catch(() => null);
  if (!notesRes || notesRes.status !== 200) {
    return { ok: false, reason: 'FETCH_FAILED' };
  }
  if (!Array.isArray(notesRes.data)) {
    return { ok: false, reason: 'FETCH_FAILED' };
  }
  if (notesRes.data.length > 0) {
    return { ok: false, reason: 'NOTES_NOT_EMPTY' };
  }

  const labelsRes = await client.get('/labels').catch(() => null);
  if (!labelsRes || labelsRes.status !== 200) {
    return { ok: false, reason: 'FETCH_FAILED' };
  }
  if (!Array.isArray(labelsRes.data)) {
    return { ok: false, reason: 'FETCH_FAILED' };
  }
  if (labelsRes.data.length > 0) {
    return { ok: false, reason: 'LABELS_NOT_EMPTY' };
  }

  return { ok: true };
}

/**
 * Run both pre-flight gates in order.
 * Local mode is never mutated — any failure leaves the caller exactly as before.
 */
export async function runPreflightChecks(session: UpgradeSession): Promise<PreflightResult> {
  const client = makeUpgradeClient(session.serverUrl, session.sessionToken);

  const capResult = await checkCapabilityGate(client);
  if (!capResult.ok) return capResult;

  return checkEmptinessGate(client);
}
