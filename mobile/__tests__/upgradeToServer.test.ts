import axios from 'axios';
import {
  checkCapabilityGate,
  checkEmptinessGate,
  runPreflightChecks,
  seedReplayQueue,
  configureMigrationApiClient,
  runMigrationDrainPass,
  flipToServerMode,
  runBackgroundReconcileScopes,
} from '../src/store/upgradeToServer';
import type { UpgradeClient, UpgradeSession, SeedResult } from '../src/store/upgradeToServer';
import { isLocalModeEnabled, isLocalModeActive, setLocalModeActive } from '../src/store/localMode';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ListNote, TextNote, Note } from '@jot/shared';
import * as noteQueries from '../src/db/noteQueries';
import * as syncQueue from '../src/db/syncQueue';
import * as apiClient from '../src/api/client';
import * as serverAccounts from '../src/store/serverAccounts';
import * as notesApi from '../src/api/notes';

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

  it('fails with FETCH_FAILED when GET /notes returns a non-array payload', async () => {
    const result = await checkEmptinessGate(makeEmptyClient({ notesData: { notes: [], total: 0 } }));
    expect(result).toEqual({ ok: false, reason: 'FETCH_FAILED' });
  });

  it('fails with FETCH_FAILED when GET /labels returns a non-array payload', async () => {
    const result = await checkEmptinessGate(makeEmptyClient({ labelsData: { labels: [], total: 0 } }));
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

// ------------------------------------------------------------------
// seedReplayQueue
// ------------------------------------------------------------------

jest.mock('../src/db/noteQueries', () => ({
  getAllLocalNotes: jest.fn(),
}));

jest.mock('../src/db/syncQueue', () => ({
  insertQueueEntry: jest.fn().mockResolvedValue(undefined),
  drainQueue: jest.fn().mockResolvedValue(undefined),
  getPendingCount: jest.fn().mockResolvedValue(0),
  getDeadLetterCount: jest.fn().mockResolvedValue(0),
  saveServerNotesScope: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/api/notes', () => ({
  getNotes: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/api/client', () => ({
  initializeServerContext: jest.fn().mockResolvedValue(undefined),
  switchActiveServer: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/serverAccounts', () => ({
  addServer: jest.fn(),
  setServerStorageValue: jest.fn().mockResolvedValue(undefined),
}));

const mockGetAllLocalNotes = noteQueries.getAllLocalNotes as jest.MockedFunction<typeof noteQueries.getAllLocalNotes>;
const mockInsertQueueEntry = syncQueue.insertQueueEntry as jest.MockedFunction<typeof syncQueue.insertQueueEntry>;
const mockDrainQueue = syncQueue.drainQueue as jest.MockedFunction<typeof syncQueue.drainQueue>;
const mockGetPendingCount = syncQueue.getPendingCount as jest.MockedFunction<typeof syncQueue.getPendingCount>;
const mockGetDeadLetterCount = syncQueue.getDeadLetterCount as jest.MockedFunction<typeof syncQueue.getDeadLetterCount>;
const mockSaveServerNotesScope = syncQueue.saveServerNotesScope as jest.MockedFunction<typeof syncQueue.saveServerNotesScope>;
const mockInitializeServerContext = apiClient.initializeServerContext as jest.MockedFunction<typeof apiClient.initializeServerContext>;
const mockSwitchActiveServer = apiClient.switchActiveServer as jest.MockedFunction<typeof apiClient.switchActiveServer>;
const mockAddServer = serverAccounts.addServer as jest.MockedFunction<typeof serverAccounts.addServer>;
const mockSetServerStorageValue = serverAccounts.setServerStorageValue as jest.MockedFunction<typeof serverAccounts.setServerStorageValue>;
const mockGetNotes = notesApi.getNotes as jest.MockedFunction<typeof notesApi.getNotes>;

const BASE_IDENTITY = {
  user: {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    username: 'local',
    first_name: 'Alice',
    last_name: 'Smith',
    role: 'user' as const,
    has_profile_icon: false,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  },
  settings: {
    user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    language: 'en',
    theme: 'dark' as const,
    note_sort: 'updated_at' as const,
    updated_at: '2025-01-01T00:00:00.000Z',
  },
};

const LABEL_A = { id: 'labelaaaaaaaaaaaaaaaaaa', user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Work', created_at: '', updated_at: '' };
const LABEL_B = { id: 'labelbbbbbbbbbbbbbbbbbb', user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Personal', created_at: '', updated_at: '' };

function makeTextNote(overrides: Partial<TextNote> = {}): TextNote {
  return {
    id: 'noteaaaaaaaaaaaaaaaaaaa1',
    user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    note_type: 'text',
    content: 'Hello world',
    version: 1,
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: false,
    labels: [],
    deleted_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeListNote(overrides: Partial<ListNote> = {}): ListNote {
  return {
    id: 'noteaaaaaaaaaaaaaaaaaaa2',
    user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    note_type: 'list',
    title: 'Shopping',
    items: [],
    checked_items_collapsed: false,
    version: 1,
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 1,
    is_shared: false,
    labels: [],
    deleted_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mockDb = {
  withTransactionAsync: jest.fn((task: () => Promise<void>) => task()),
} as unknown as SQLiteDatabase;

describe('seedReplayQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsertQueueEntry.mockResolvedValue(undefined);
  });

  it('returns zero totalEnqueued when there are no local notes', async () => {
    mockGetAllLocalNotes.mockResolvedValue([]);

    const result: SeedResult = await seedReplayQueue(mockDb, BASE_IDENTITY);

    // Only the settings op is enqueued when there are no notes.
    expect(result.totalEnqueued).toBe(1);
    expect(mockInsertQueueEntry).toHaveBeenCalledTimes(1);
    const [, params] = mockInsertQueueEntry.mock.calls[0];
    expect(params.operation).toBe('updateSettings');
  });

  it('enqueues labels before notes', async () => {
    const note = makeTextNote({ labels: [LABEL_A] });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const calls = mockInsertQueueEntry.mock.calls.map(([, p]) => p.operation);
    const labelIdx = calls.indexOf('createLabel');
    const createIdx = calls.indexOf('create');
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(labelIdx);
  });

  it('enqueues note creates before note↔label links', async () => {
    const note = makeTextNote({ labels: [LABEL_A] });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const calls = mockInsertQueueEntry.mock.calls.map(([, p]) => p.operation);
    const createIdx = calls.indexOf('create');
    const linkIdx = calls.indexOf('addLabelToNote');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeGreaterThan(createIdx);
  });

  it('enqueues settings/profile last', async () => {
    const note = makeTextNote({ labels: [LABEL_A] });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const calls = mockInsertQueueEntry.mock.calls.map(([, p]) => p.operation);
    const settingsIdx = calls.lastIndexOf('updateSettings');
    expect(settingsIdx).toBe(calls.length - 1);
  });

  it('enqueues one createLabel op per unique label', async () => {
    const note1 = makeTextNote({ id: 'noteaaaaaaaaaaaaaaaaaaa1', labels: [LABEL_A, LABEL_B] });
    const note2 = makeTextNote({ id: 'noteaaaaaaaaaaaaaaaaaaa3', labels: [LABEL_A] });
    mockGetAllLocalNotes.mockResolvedValue([note1, note2]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const labelCalls = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.operation === 'createLabel');
    expect(labelCalls).toHaveLength(2);
    const names = labelCalls.map((p) => (p.body as Record<string, unknown>).name);
    expect(names).toContain('Work');
    expect(names).toContain('Personal');
  });

  it('includes client-supplied note ID in the create body', async () => {
    const note = makeTextNote({ id: 'noteaaaaaaaaaaaaaaaaaaa1' });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const createCall = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .find((p) => p.operation === 'create');
    expect((createCall?.body as Record<string, unknown>).id).toBe('noteaaaaaaaaaaaaaaaaaaa1');
  });

  it('includes inline items with client-supplied IDs for list notes', async () => {
    const note = makeListNote({
      items: [
        { id: 'item1aaaaaaaaaaaaaaaaaaaa', note_id: 'noteaaaaaaaaaaaaaaaaaaa2', text: 'Milk', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
        { id: 'item2aaaaaaaaaaaaaaaaaaaa', note_id: 'noteaaaaaaaaaaaaaaaaaaa2', text: 'Eggs', completed: true, position: 1, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
      ],
    });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const createCall = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .find((p) => p.operation === 'create');
    const body = createCall?.body as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('item1aaaaaaaaaaaaaaaaaaaa');
    expect(items[1].id).toBe('item2aaaaaaaaaaaaaaaaaaaa');
  });

  it('sets indent_level=1 for nested items and indent_level=0 for top-level items', async () => {
    const note = makeListNote({
      items: [
        { id: 'item1aaaaaaaaaaaaaaaaaaaa', note_id: 'noteaaaaaaaaaaaaaaaaaaa2', text: 'Parent', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
        { id: 'item2aaaaaaaaaaaaaaaaaaaa', note_id: 'noteaaaaaaaaaaaaaaaaaaa2', text: 'Child', completed: false, position: 1, parent_id: 'item1aaaaaaaaaaaaaaaaaaaa', assigned_to: '', created_at: '', updated_at: '' },
      ],
    });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const createCall = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .find((p) => p.operation === 'create');
    const items = (createCall?.body as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(items[0].indent_level).toBe(0);
    expect(items[1].indent_level).toBe(1);
  });

  it('enqueues addLabelToNote for each note-label pair', async () => {
    const note = makeTextNote({ labels: [LABEL_A, LABEL_B] });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const linkCalls = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.operation === 'addLabelToNote');
    expect(linkCalls).toHaveLength(2);
    const endpoints = linkCalls.map((p) => p.endpoint);
    expect(endpoints).toContain(`/notes/${note.id}/labels/${LABEL_A.id}`);
    expect(endpoints).toContain(`/notes/${note.id}/labels/${LABEL_B.id}`);
  });

  it('enqueues a PATCH update for archived notes after the label links', async () => {
    const note = makeTextNote({ archived: true, labels: [LABEL_A] });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const calls = mockInsertQueueEntry.mock.calls.map(([, p]) => p);
    const linkIdx = calls.findIndex((p) => p.operation === 'addLabelToNote');
    const updateIdx = calls.findIndex((p) => p.operation === 'update');
    expect(updateIdx).toBeGreaterThan(linkIdx);
    expect((calls[updateIdx].body as Record<string, unknown>).archived).toBe(true);
  });

  it('enqueues a PATCH update for pinned notes', async () => {
    const note = makeTextNote({ pinned: true });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const updateCall = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .find((p) => p.operation === 'update');
    expect((updateCall?.body as Record<string, unknown>).pinned).toBe(true);
  });

  it('enqueues a PATCH update for checked_items_collapsed list notes', async () => {
    const note = makeListNote({ checked_items_collapsed: true });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const updateCall = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .find((p) => p.operation === 'update');
    expect((updateCall?.body as Record<string, unknown>).checked_items_collapsed).toBe(true);
  });

  it('enqueues a DELETE op for trashed notes after label links', async () => {
    const note = makeTextNote({ deleted_at: '2025-06-01T00:00:00.000Z', labels: [LABEL_A] });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const calls = mockInsertQueueEntry.mock.calls.map(([, p]) => p);
    const linkIdx = calls.findIndex((p) => p.operation === 'addLabelToNote');
    const deleteIdx = calls.findIndex((p) => p.operation === 'delete');
    expect(deleteIdx).toBeGreaterThan(linkIdx);
    expect(calls[deleteIdx].method).toBe('DELETE');
    expect(calls[deleteIdx].endpoint).toBe(`/notes/${note.id}`);
  });

  it('includes settings and profile in the updateSettings body', async () => {
    mockGetAllLocalNotes.mockResolvedValue([]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const settingsCall = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .find((p) => p.operation === 'updateSettings');
    const body = settingsCall?.body as Record<string, unknown>;
    expect(body.language).toBe('en');
    expect(body.theme).toBe('dark');
    expect(body.note_sort).toBe('updated_at');
    expect(body.first_name).toBe('Alice');
    expect(body.last_name).toBe('Smith');
  });

  it('returns the correct total op count', async () => {
    const note1 = makeTextNote({ id: 'noteaaaaaaaaaaaaaaaaaaa1', labels: [LABEL_A] });
    const note2 = makeListNote({
      id: 'noteaaaaaaaaaaaaaaaaaaa2',
      labels: [LABEL_B],
      archived: true,
      items: [
        { id: 'item1aaaaaaaaaaaaaaaaaaaa', note_id: 'noteaaaaaaaaaaaaaaaaaaa2', text: 'Task', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
      ],
    });
    mockGetAllLocalNotes.mockResolvedValue([note1, note2]);

    const result = await seedReplayQueue(mockDb, BASE_IDENTITY);

    // 2 createLabel + 2 create (items inline) + 2 addLabelToNote + 1 update (archived) + 1 updateSettings = 8
    expect(result.totalEnqueued).toBe(8);
    expect(mockInsertQueueEntry).toHaveBeenCalledTimes(8);
  });

  it('does not enqueue a state update for default-state notes', async () => {
    const note = makeTextNote({ pinned: false, archived: false, deleted_at: null });
    mockGetAllLocalNotes.mockResolvedValue([note]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    const updateCalls = mockInsertQueueEntry.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.operation === 'update' || p.operation === 'delete');
    expect(updateCalls).toHaveLength(0);
  });

  it('uses insertQueueEntry (not enqueueOperation) so local mode does not block seeding', async () => {
    mockGetAllLocalNotes.mockResolvedValue([]);

    await seedReplayQueue(mockDb, BASE_IDENTITY);

    expect(mockInsertQueueEntry).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// configureMigrationApiClient
// ------------------------------------------------------------------

const MIGRATION_SESSION: UpgradeSession = {
  serverUrl: 'http://jot.example.com',
  sessionToken: 'migration-token-abc',
};

describe('configureMigrationApiClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInitializeServerContext.mockResolvedValue(undefined);
    mockSwitchActiveServer.mockResolvedValue(true);
    mockSetServerStorageValue.mockResolvedValue(undefined);
  });

  it('registers the server, stores the session token, and switches the active server on success', async () => {
    mockAddServer.mockResolvedValue({ success: true, serverId: 'server-abc' });

    const serverId = await configureMigrationApiClient(MIGRATION_SESSION);

    expect(serverId).toBe('server-abc');
    expect(mockInitializeServerContext).toHaveBeenCalledTimes(1);
    expect(mockAddServer).toHaveBeenCalledWith(MIGRATION_SESSION.serverUrl);
    expect(mockSetServerStorageValue).toHaveBeenCalledWith('server-abc', 'session', MIGRATION_SESSION.sessionToken);
    expect(mockSwitchActiveServer).toHaveBeenCalledWith('server-abc');
    // Storage must be written before the server switch so the session is available
    // when switchActiveServer triggers the auth handshake.
    expect(mockSetServerStorageValue.mock.invocationCallOrder[0])
      .toBeLessThan(mockSwitchActiveServer.mock.invocationCallOrder[0]);
  });

  it('reuses the existing server ID when addServer returns DUPLICATE', async () => {
    mockAddServer.mockResolvedValue({
      success: false,
      code: 'DUPLICATE',
      existingServerId: 'server-existing',
      message: 'already registered',
      retryable: false,
    });

    const serverId = await configureMigrationApiClient(MIGRATION_SESSION);

    expect(serverId).toBe('server-existing');
    expect(mockSetServerStorageValue).toHaveBeenCalledWith('server-existing', 'session', MIGRATION_SESSION.sessionToken);
    expect(mockSwitchActiveServer).toHaveBeenCalledWith('server-existing');
  });

  it('throws when addServer returns a non-DUPLICATE failure', async () => {
    mockAddServer.mockResolvedValue({
      success: false,
      code: 'NETWORK_ERROR',
      message: 'connection refused',
      retryable: true,
    });

    await expect(configureMigrationApiClient(MIGRATION_SESSION)).rejects.toThrow(
      'Failed to register migration server',
    );
    expect(mockSetServerStorageValue).not.toHaveBeenCalled();
    expect(mockSwitchActiveServer).not.toHaveBeenCalled();
  });

  it('throws when addServer returns DUPLICATE without an existingServerId', async () => {
    mockAddServer.mockResolvedValue({
      success: false,
      code: 'DUPLICATE',
      message: 'duplicate but no id',
      retryable: false,
    });

    await expect(configureMigrationApiClient(MIGRATION_SESSION)).rejects.toThrow(
      'Failed to register migration server',
    );
    expect(mockSetServerStorageValue).not.toHaveBeenCalled();
    expect(mockSwitchActiveServer).not.toHaveBeenCalled();
  });

  it('throws when switchActiveServer returns false', async () => {
    mockAddServer.mockResolvedValue({ success: true, serverId: 'server-abc' });
    mockSwitchActiveServer.mockResolvedValue(false);

    await expect(configureMigrationApiClient(MIGRATION_SESSION)).rejects.toThrow(
      'Failed to switch active server for migration',
    );
  });
});

// ------------------------------------------------------------------
// runMigrationDrainPass
// ------------------------------------------------------------------

const DRAIN_RESULT_EMPTY = { idMappings: [], discardedOperations: [], syncedSettings: false };

describe('runMigrationDrainPass', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDrainQueue.mockResolvedValue(DRAIN_RESULT_EMPTY);
  });

  it('returns success status when queue is empty and no dead letters', async () => {
    mockGetPendingCount.mockResolvedValue(0);
    mockGetDeadLetterCount.mockResolvedValue(0);

    const result = await runMigrationDrainPass(mockDb, 10);

    expect(result.status).toBe('success');
    expect(result.processed).toBe(10);
    expect(result.remaining).toBe(0);
    expect(result.deadLetterCount).toBe(0);
    expect(mockDrainQueue).toHaveBeenCalledWith(mockDb);
  });

  it('returns dead_letter status when dead-letter count is non-zero', async () => {
    mockGetPendingCount.mockResolvedValue(3);
    mockGetDeadLetterCount.mockResolvedValue(2);

    const result = await runMigrationDrainPass(mockDb, 10);

    expect(result.status).toBe('dead_letter');
    expect(result.deadLetterCount).toBe(2);
    expect(result.remaining).toBe(3);
    expect(result.processed).toBe(7);
  });

  it('returns stalled status when items remain but no dead letters', async () => {
    mockGetPendingCount.mockResolvedValue(4);
    mockGetDeadLetterCount.mockResolvedValue(0);

    const result = await runMigrationDrainPass(mockDb, 10);

    expect(result.status).toBe('stalled');
    expect(result.remaining).toBe(4);
    expect(result.processed).toBe(6);
    expect(result.deadLetterCount).toBe(0);
  });

  it('computes processed as total minus remaining', async () => {
    mockGetPendingCount.mockResolvedValue(3);
    mockGetDeadLetterCount.mockResolvedValue(0);

    const result = await runMigrationDrainPass(mockDb, 15);

    expect(result.processed).toBe(12);
    expect(result.remaining).toBe(3);
  });

  it('prioritises dead_letter over stalled when both conditions hold', async () => {
    mockGetPendingCount.mockResolvedValue(5);
    mockGetDeadLetterCount.mockResolvedValue(1);

    const result = await runMigrationDrainPass(mockDb, 10);

    expect(result.status).toBe('dead_letter');
  });
});

// ------------------------------------------------------------------
// flipToServerMode
// ------------------------------------------------------------------

describe('flipToServerMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Start in local mode so the success test validates the transition, not a no-op.
    setLocalModeActive(true);
    // Seed a local identity so disableLocalMode has something to delete.
    memory.set('jot_local_mode_v1', JSON.stringify({
      user: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'local', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' },
      settings: { user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', language: 'en', theme: 'system', note_sort: 'manual', updated_at: '' },
    }));
    mockSecureStore.getItemAsync.mockImplementation(async (key: string) => memory.get(key) ?? null);
    mockSecureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      memory.delete(key);
    });
  });

  it('returns DIRTY_DRAIN when pending queue items exist', async () => {
    mockGetPendingCount.mockResolvedValue(3);
    mockGetDeadLetterCount.mockResolvedValue(0);

    const result = await flipToServerMode(mockDb);

    expect(result).toEqual({ ok: false, reason: 'DIRTY_DRAIN' });
    expect(await isLocalModeEnabled()).toBe(true);
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('returns DIRTY_DRAIN when dead-letter items exist', async () => {
    mockGetPendingCount.mockResolvedValue(0);
    mockGetDeadLetterCount.mockResolvedValue(2);

    const result = await flipToServerMode(mockDb);

    expect(result).toEqual({ ok: false, reason: 'DIRTY_DRAIN' });
    expect(await isLocalModeEnabled()).toBe(true);
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('returns DIRTY_DRAIN when both pending and dead-letter items exist', async () => {
    mockGetPendingCount.mockResolvedValue(1);
    mockGetDeadLetterCount.mockResolvedValue(1);

    const result = await flipToServerMode(mockDb);

    expect(result).toEqual({ ok: false, reason: 'DIRTY_DRAIN' });
  });

  it('returns ok and disables local mode when drain is clean', async () => {
    mockGetPendingCount.mockResolvedValue(0);
    mockGetDeadLetterCount.mockResolvedValue(0);

    const result = await flipToServerMode(mockDb);

    expect(result).toEqual({ ok: true });
    expect(await isLocalModeEnabled()).toBe(false);
    expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
  });

  it('updates the synchronous local-mode flag to false on success', async () => {
    mockGetPendingCount.mockResolvedValue(0);
    mockGetDeadLetterCount.mockResolvedValue(0);

    await flipToServerMode(mockDb);

    expect(isLocalModeActive()).toBe(false);
  });
});

// ------------------------------------------------------------------
// runBackgroundReconcileScopes
// ------------------------------------------------------------------

describe('runBackgroundReconcileScopes', () => {
  const NOTE_A = { id: 'noteaaaaaaaaaaaaaaaaaaa1', note_type: 'text', content: 'hello' } as unknown as Note;
  const NOTE_B = { id: 'noteaaaaaaaaaaaaaaaaaaa2', note_type: 'text', content: 'archived' } as unknown as Note;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveServerNotesScope.mockResolvedValue(undefined);
  });

  it('fetches all three scopes and reconciles each into local SQLite', async () => {
    mockGetNotes
      .mockResolvedValueOnce([NOTE_A])     // active
      .mockResolvedValueOnce([NOTE_B])     // archived
      .mockResolvedValueOnce([]);          // trashed

    await runBackgroundReconcileScopes(mockDb);

    expect(mockGetNotes).toHaveBeenCalledTimes(3);
    // Active scope (undefined params)
    expect(mockGetNotes).toHaveBeenNthCalledWith(1, undefined);
    // Archived scope
    expect(mockGetNotes).toHaveBeenNthCalledWith(2, { archived: true });
    // Trashed scope
    expect(mockGetNotes).toHaveBeenNthCalledWith(3, { trashed: true });

    expect(mockSaveServerNotesScope).toHaveBeenCalledTimes(3);
    expect(mockSaveServerNotesScope).toHaveBeenNthCalledWith(1, mockDb, [NOTE_A], undefined);
    expect(mockSaveServerNotesScope).toHaveBeenNthCalledWith(2, mockDb, [NOTE_B], { archived: true });
    expect(mockSaveServerNotesScope).toHaveBeenNthCalledWith(3, mockDb, [], { trashed: true });
  });

  it('throws when a scope fetch fails, without reconciling subsequent scopes', async () => {
    mockGetNotes
      .mockResolvedValueOnce([NOTE_A])     // active — succeeds
      .mockRejectedValueOnce(new Error('network error')); // archived — fails

    await expect(runBackgroundReconcileScopes(mockDb)).rejects.toThrow('network error');

    expect(mockGetNotes).toHaveBeenCalledTimes(2);
    expect(mockSaveServerNotesScope).toHaveBeenCalledTimes(1);
  });
});
