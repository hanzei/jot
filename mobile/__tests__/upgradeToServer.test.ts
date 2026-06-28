import axios from 'axios';
import {
  checkCapabilityGate,
  checkEmptinessGate,
  runPreflightChecks,
} from '../src/store/upgradeToServer';
import type { UpgradeClient, UpgradeSession } from '../src/store/upgradeToServer';
import { isLocalModeEnabled } from '../src/store/localMode';
import * as SecureStore from 'expo-secure-store';

// ------------------------------------------------------------------
// SecureStore mock — used to verify local mode is never mutated
// ------------------------------------------------------------------
const mockSecureStore = SecureStore as unknown as {
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  jest.clearAllMocks();
  mockSecureStore.getItemAsync.mockImplementation(async (key: string) => memory.get(key) ?? null);
  mockSecureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
    memory.set(key, value);
  });
  mockSecureStore.deleteItemAsync.mockImplementation(async (key: string) => {
    memory.delete(key);
  });
});

// ------------------------------------------------------------------
// Mock axios so makeUpgradeClient tests don't hit the network
// ------------------------------------------------------------------
const mockAxiosInstance = {
  post: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => mockAxiosInstance),
    post: jest.fn(),
  },
}));

// Keep a typed reference to the mock so we can verify create was called
void (axios as unknown as { create: jest.Mock }).create;

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Build a capability-gate-passing mock client. */
function makeCapableClient(overrides?: Partial<{
  noteCreate1Status: number;
  noteCreate1Id: string;
  noteCreate2Status: number;
  itemCreate1Status: number;
  itemCreate1Id: string;
  itemCreate2Status: number;
  labelCreate1Status: number;
  labelCreate1Id: string;
  labelCreate2Status: number;
}>): UpgradeClient {
  const probeNoteId = 'captured-note-id';
  const probeItemId = 'captured-item-id';
  const probeLabelId = 'captured-label-id';

  // We can't predict the exact IDs generated inside checkCapabilityGate,
  // so we capture what was posted and echo it back.
  const noteCreate1Status = overrides?.noteCreate1Status ?? 201;
  const noteCreate2Status = overrides?.noteCreate2Status ?? 409;
  const itemCreate1Status = overrides?.itemCreate1Status ?? 201;
  const itemCreate2Status = overrides?.itemCreate2Status ?? 409;
  const labelCreate1Status = overrides?.labelCreate1Status ?? 201;
  const labelCreate2Status = overrides?.labelCreate2Status ?? 409;

  let capturedNoteId = '';
  let capturedItemId = '';
  let capturedLabelId = '';
  let noteCallCount = 0;
  let itemCallCount = 0;
  let labelCallCount = 0;

  return {
    async post(path, data) {
      const body = data as Record<string, unknown>;
      if (path === '/notes') {
        noteCallCount++;
        capturedNoteId = capturedNoteId || (body.id as string) || probeNoteId;
        if (noteCallCount === 1) {
          return {
            status: noteCreate1Status,
            data: { id: overrides?.noteCreate1Id ?? capturedNoteId },
          };
        }
        return { status: noteCreate2Status, data: '' };
      }
      if (path.endsWith('/items')) {
        itemCallCount++;
        capturedItemId = capturedItemId || (body.id as string) || probeItemId;
        if (itemCallCount === 1) {
          return {
            status: itemCreate1Status,
            data: { id: overrides?.itemCreate1Id ?? capturedItemId },
          };
        }
        return { status: itemCreate2Status, data: '' };
      }
      if (path === '/labels') {
        labelCallCount++;
        capturedLabelId = capturedLabelId || (body.id as string) || probeLabelId;
        if (labelCallCount === 1) {
          return {
            status: labelCreate1Status,
            data: { id: overrides?.labelCreate1Id ?? capturedLabelId },
          };
        }
        return { status: labelCreate2Status, data: '' };
      }
      return { status: 404, data: '' };
    },
    async get() {
      return { status: 200, data: [] };
    },
    async delete() {
      return { status: 200 };
    },
  };
}

/** Build an emptiness-gate-passing mock client. */
function makeEmptyClient(overrides?: {
  notesStatus?: number;
  notesData?: unknown;
  labelsStatus?: number;
  labelsData?: unknown;
}): UpgradeClient {
  return {
    async post() { return { status: 201, data: {} }; },
    async get(path) {
      if (path === '/notes') {
        return { status: overrides?.notesStatus ?? 200, data: overrides?.notesData ?? [] };
      }
      if (path === '/labels') {
        return { status: overrides?.labelsStatus ?? 200, data: overrides?.labelsData ?? [] };
      }
      return { status: 200, data: [] };
    },
    async delete() { return { status: 200 }; },
  };
}

// ------------------------------------------------------------------
// checkCapabilityGate
// ------------------------------------------------------------------

describe('checkCapabilityGate', () => {
  it('returns ok when server honors client IDs and returns 409 on duplicate', async () => {
    const result = await checkCapabilityGate(makeCapableClient());
    expect(result.ok).toBe(true);
  });

  it('fails with ENDPOINT_SHAPE_ERROR when POST /notes returns non-200/201', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ noteCreate1Status: 500 }));
    expect(result).toEqual({ ok: false, reason: 'ENDPOINT_SHAPE_ERROR' });
  });

  it('fails with CLIENT_ID_NOT_HONORED when note ID in response differs from probe ID', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ noteCreate1Id: 'different-id' }));
    expect(result).toEqual({ ok: false, reason: 'CLIENT_ID_NOT_HONORED' });
  });

  it('fails with DEDUP_409_MISSING when second POST /notes returns non-409', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ noteCreate2Status: 201 }));
    expect(result).toEqual({ ok: false, reason: 'DEDUP_409_MISSING' });
  });

  it('fails with ENDPOINT_SHAPE_ERROR when POST /notes/{id}/items returns non-200/201', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ itemCreate1Status: 400 }));
    expect(result).toEqual({ ok: false, reason: 'ENDPOINT_SHAPE_ERROR' });
  });

  it('fails with CLIENT_ID_NOT_HONORED when item ID in response differs from probe ID', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ itemCreate1Id: 'wrong-item-id' }));
    expect(result).toEqual({ ok: false, reason: 'CLIENT_ID_NOT_HONORED' });
  });

  it('fails with DEDUP_409_MISSING when second POST items returns non-409', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ itemCreate2Status: 200 }));
    expect(result).toEqual({ ok: false, reason: 'DEDUP_409_MISSING' });
  });

  it('fails with ENDPOINT_SHAPE_ERROR when POST /labels returns non-200/201', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ labelCreate1Status: 500 }));
    expect(result).toEqual({ ok: false, reason: 'ENDPOINT_SHAPE_ERROR' });
  });

  it('fails with CLIENT_ID_NOT_HONORED when label ID in response differs from probe ID', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ labelCreate1Id: 'wrong-label-id' }));
    expect(result).toEqual({ ok: false, reason: 'CLIENT_ID_NOT_HONORED' });
  });

  it('fails with DEDUP_409_MISSING when second POST /labels returns non-409', async () => {
    const result = await checkCapabilityGate(makeCapableClient({ labelCreate2Status: 200 }));
    expect(result).toEqual({ ok: false, reason: 'DEDUP_409_MISSING' });
  });

  it('runs cleanup (delete) even when a capability check fails', async () => {
    const deleted: string[] = [];
    const client: UpgradeClient = {
      async post(path, data) {
        const body = data as Record<string, unknown>;
        if (path === '/notes') return { status: 201, data: { id: body.id } };
        if (path.endsWith('/items')) return { status: 201, data: { id: (data as Record<string, unknown>).id } };
        // Labels fail
        return { status: 500, data: '' };
      },
      async get() { return { status: 200, data: [] }; },
      async delete(path) {
        deleted.push(path);
        return { status: 200 };
      },
    };
    await checkCapabilityGate(client);
    // cleanup should have been attempted
    expect(deleted.some((p) => p.startsWith('/notes/'))).toBe(true);
  });

  it('does not mutate local mode on capability failure', async () => {
    // Seed a local mode identity
    memory.set('jot_local_mode_v1', JSON.stringify({
      user: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'local', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' },
      settings: { user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', language: 'en', theme: 'system', note_sort: 'manual', updated_at: '' },
    }));

    await checkCapabilityGate(makeCapableClient({ noteCreate1Status: 500 }));

    // Local mode identity should be untouched
    expect(await isLocalModeEnabled()).toBe(true);
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// checkEmptinessGate
// ------------------------------------------------------------------

describe('checkEmptinessGate', () => {
  it('returns ok when both notes and labels are empty', async () => {
    const result = await checkEmptinessGate(makeEmptyClient());
    expect(result.ok).toBe(true);
  });

  it('fails with NOTES_NOT_EMPTY when notes list is non-empty', async () => {
    const result = await checkEmptinessGate(makeEmptyClient({
      notesData: [{ id: 'note1', content: 'hi' }],
    }));
    expect(result).toEqual({ ok: false, reason: 'NOTES_NOT_EMPTY' });
  });

  it('fails with LABELS_NOT_EMPTY when labels list is non-empty', async () => {
    const result = await checkEmptinessGate(makeEmptyClient({
      labelsData: [{ id: 'label1', name: 'work' }],
    }));
    expect(result).toEqual({ ok: false, reason: 'LABELS_NOT_EMPTY' });
  });

  it('fails with FETCH_FAILED when GET /notes returns non-200', async () => {
    const result = await checkEmptinessGate(makeEmptyClient({ notesStatus: 500 }));
    expect(result).toEqual({ ok: false, reason: 'FETCH_FAILED' });
  });

  it('fails with FETCH_FAILED when GET /labels returns non-200', async () => {
    const result = await checkEmptinessGate(makeEmptyClient({ labelsStatus: 500 }));
    expect(result).toEqual({ ok: false, reason: 'FETCH_FAILED' });
  });

  it('does not mutate local mode on emptiness failure', async () => {
    memory.set('jot_local_mode_v1', JSON.stringify({
      user: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'local', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' },
      settings: { user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', language: 'en', theme: 'system', note_sort: 'manual', updated_at: '' },
    }));

    await checkEmptinessGate(makeEmptyClient({ notesData: [{ id: 'note1' }] }));

    expect(await isLocalModeEnabled()).toBe(true);
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// runPreflightChecks
// ------------------------------------------------------------------

describe('runPreflightChecks', () => {
  const session: UpgradeSession = {
    serverUrl: 'http://localhost:8080',
    sessionToken: 'test-token',
  };

  it('passes when capability and emptiness gates both pass', async () => {
    // runPreflightChecks calls makeUpgradeClient which calls axios.create;
    // mockAxiosInstance is what axios.create returns.
    let noteCallCount = 0;
    let itemCallCount = 0;
    let labelCallCount = 0;
    let capturedNoteId = '';
    let capturedItemId = '';
    let capturedLabelId = '';

    mockAxiosInstance.post.mockImplementation(async (path: string, data: Record<string, unknown>) => {
      if (path === '/notes') {
        noteCallCount++;
        capturedNoteId = capturedNoteId || (data.id as string);
        if (noteCallCount === 1) return { status: 201, data: { id: capturedNoteId }, headers: {} };
        return { status: 409, data: '', headers: {} };
      }
      if (path.includes('/items')) {
        itemCallCount++;
        capturedItemId = capturedItemId || (data.id as string);
        if (itemCallCount === 1) return { status: 201, data: { id: capturedItemId }, headers: {} };
        return { status: 409, data: '', headers: {} };
      }
      if (path === '/labels') {
        labelCallCount++;
        capturedLabelId = capturedLabelId || (data.id as string);
        if (labelCallCount === 1) return { status: 201, data: { id: capturedLabelId }, headers: {} };
        return { status: 409, data: '', headers: {} };
      }
      return { status: 404, data: '', headers: {} };
    });
    mockAxiosInstance.get.mockResolvedValue({ status: 200, data: [], headers: {} });
    mockAxiosInstance.delete.mockResolvedValue({ status: 200, data: '', headers: {} });

    const result = await runPreflightChecks(session);
    expect(result.ok).toBe(true);
  });

  it('aborts with capability reason and does not run emptiness check when capability fails', async () => {
    mockAxiosInstance.post.mockResolvedValue({ status: 500, data: '', headers: {} });
    mockAxiosInstance.delete.mockResolvedValue({ status: 200, data: '', headers: {} });

    const result = await runPreflightChecks(session);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ENDPOINT_SHAPE_ERROR');
    }
    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
  });

  it('does not mutate local mode on any abort', async () => {
    memory.set('jot_local_mode_v1', JSON.stringify({
      user: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'local', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' },
      settings: { user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', language: 'en', theme: 'system', note_sort: 'manual', updated_at: '' },
    }));

    mockAxiosInstance.post.mockResolvedValue({ status: 500, data: '', headers: {} });
    mockAxiosInstance.delete.mockResolvedValue({ status: 200, data: '', headers: {} });

    await runPreflightChecks(session);

    expect(await isLocalModeEnabled()).toBe(true);
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});
