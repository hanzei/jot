import axios from 'axios';
import { generateId, canonicalizeServerOrigin } from '@jot/shared';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getAllLocalNotes } from '../db/noteQueries';
import { drainQueue, getPendingCount, getDeadLetterCount, insertQueueEntry } from '../db/syncQueue';
import type { LocalIdentity } from './localMode';
import { initializeServerContext, switchActiveServer } from '../api/client';
import { addServer, setServerStorageValue } from './serverAccounts';

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

export interface SeedResult {
  totalEnqueued: number;
}

/**
 * Phase 2 of the local→server upgrade: walk local SQLite and seed the sync
 * queue with a `create` op per entity in dependency order so the drain (Phase 3)
 * can replay every piece of local data onto the freshly registered server account.
 *
 * Dependency order:
 *   1. Labels           — must exist before note↔label links can reference them.
 *   2. Notes            — must exist before items, label links, or state changes.
 *   3. Note items       — items are included inline in the note create body; this
 *                         step covers any items not handled there (none in practice).
 *   4. Note↔label links — note and label must both already exist.
 *   5. Note state       — archived / pinned / checked_items_collapsed / trashed
 *                         states are applied after label links so labels can be
 *                         associated before a note is moved to trash.
 *   6. Settings/profile — enqueued as a normal op, not best-effort, so it drains
 *                         under the same gated flow as everything else.
 *
 * `insertQueueEntry` bypasses the local-mode guard (local mode is still active
 * at seeding time) and does NOT notify enqueue listeners (the drain will be
 * triggered by Phase 3 once local mode is disabled).
 *
 * Returns the total number of ops enqueued, for the Phase 3 progress UI.
 */
export async function seedReplayQueue(
  db: SQLiteDatabase,
  identity: LocalIdentity,
): Promise<SeedResult> {
  let totalEnqueued = 0;

  // Wrap in a single transaction so seeding is atomic: a mid-flight failure
  // rolls back all inserts and leaves the queue clean for a retry.
  await db.withTransactionAsync(async () => {
    const allNotes = await getAllLocalNotes(db);

    // Step 1: collect unique labels across all notes and enqueue createLabel ops first.
    const labelsById = new Map<string, { id: string; name: string }>();
    for (const note of allNotes) {
      for (const label of note.labels) {
        if (!labelsById.has(label.id)) {
          labelsById.set(label.id, { id: label.id, name: label.name });
        }
      }
    }

    for (const label of labelsById.values()) {
      await insertQueueEntry(db, {
        operation: 'createLabel',
        endpoint: '/labels',
        method: 'POST',
        body: { id: label.id, name: label.name },
      });
      totalEnqueued++;
    }

    // Step 2: enqueue a create op per note. List-note items are included inline so
    // the note body always satisfies the server's "title or content or items"
    // requirement even when a list note has no title. Client-supplied item IDs are
    // honored by the server (issue #475/#513). parent_id is converted to indent_level
    // (0 = top-level, 1 = nested) because the bulk-create path only supports those
    // two levels and reconstructs parent_id by attaching each indented item to the
    // nearest preceding top-level item — the full nesting depth the server supports.
    for (const note of allNotes) {
      const body: Record<string, unknown> = {
        id: note.id,
        note_type: note.note_type,
        color: note.color,
      };

      if (note.note_type === 'text') {
        body.content = note.content;
      } else {
        body.title = note.title;
        const items = note.items ?? [];
        if (items.length > 0) {
          body.items = items.map((item) => ({
            id: item.id,
            text: item.text,
            position: item.position,
            completed: item.completed,
            indent_level: item.parent_id !== null ? 1 : 0,
          }));
        }
      }

      await insertQueueEntry(db, {
        operation: 'create',
        endpoint: '/notes',
        method: 'POST',
        body,
      });
      totalEnqueued++;
    }

    // Step 3: note items not covered by the inline create above (none in practice,
    // since all items are included in the note body). Left as an explicit empty
    // step to match the design document's numbered sequence.

    // Step 4: enqueue note↔label links after both notes and labels exist.
    for (const note of allNotes) {
      for (const label of note.labels) {
        await insertQueueEntry(db, {
          operation: 'addLabelToNote',
          endpoint: `/notes/${note.id}/labels/${label.id}`,
          method: 'POST',
        });
        totalEnqueued++;
      }
    }

    // Step 5: apply note state (pinned / archived / checked_items_collapsed / trashed)
    // after label links so labels can be associated before a note is soft-deleted.
    for (const note of allNotes) {
      const patch: Record<string, unknown> = {};
      if (note.pinned) patch.pinned = true;
      if (note.archived) patch.archived = true;
      if (note.note_type === 'list' && note.checked_items_collapsed) {
        patch.checked_items_collapsed = true;
      }

      if (Object.keys(patch).length > 0) {
        await insertQueueEntry(db, {
          operation: 'update',
          endpoint: `/notes/${note.id}`,
          method: 'PATCH',
          body: patch,
        });
        totalEnqueued++;
      }

      if (note.deleted_at !== null) {
        await insertQueueEntry(db, {
          operation: 'delete',
          endpoint: `/notes/${note.id}`,
          method: 'DELETE',
        });
        totalEnqueued++;
      }
    }

    // Step 6: settings / profile — part of the gated drain, not best-effort.
    const { user, settings } = identity;
    const settingsBody: Record<string, unknown> = {
      language: settings.language,
      theme: settings.theme,
      note_sort: settings.note_sort,
    };
    if (user.first_name) settingsBody.first_name = user.first_name;
    if (user.last_name) settingsBody.last_name = user.last_name;

    await insertQueueEntry(db, {
      operation: 'updateSettings',
      endpoint: '/users/me',
      method: 'PATCH',
      body: settingsBody,
    });
    totalEnqueued++;
  });

  return { totalEnqueued };
}

/**
 * Register the migration server in the server account registry and configure
 * the main api singleton to authenticate against it. Must be called once before
 * running the migration drain so drainQueue sends requests to the right server
 * under the right session.
 *
 * If the server was already registered (e.g. from a previous aborted migration
 * attempt), the existing registration is reused and the session token is updated.
 *
 * Returns the registered serverId.
 */
export async function configureMigrationApiClient(session: UpgradeSession): Promise<string> {
  await initializeServerContext();
  const addResult = await addServer(session.serverUrl);
  let serverId: string;
  if (addResult.success) {
    serverId = addResult.serverId;
  } else if (addResult.code === 'DUPLICATE' && addResult.existingServerId) {
    serverId = addResult.existingServerId;
  } else {
    throw new Error(`Failed to register migration server: ${addResult.message}`);
  }
  await setServerStorageValue(serverId, 'session', session.sessionToken);
  await switchActiveServer(serverId);
  return serverId;
}

export type MigrationDrainStatus = 'success' | 'dead_letter' | 'stalled';

export interface MigrationDrainPassResult {
  status: MigrationDrainStatus;
  processed: number;
  remaining: number;
  deadLetterCount: number;
}

/**
 * Run one pass of the sync-queue drain during a local→server migration.
 * Calls drainQueue to process whatever the queue currently holds, then inspects
 * the remaining depth and dead-letter count to determine the outcome.
 *
 * The caller is responsible for:
 *   - retrying on 'stalled' (transient failure, retry with backoff)
 *   - halting on 'dead_letter' to surface the resolution UX
 *   - proceeding to Phase 4 on 'success'
 */
export async function runMigrationDrainPass(
  db: SQLiteDatabase,
  total: number,
): Promise<MigrationDrainPassResult> {
  await drainQueue(db);
  const remaining = await getPendingCount(db);
  const deadLetterCount = await getDeadLetterCount(db);
  const processed = total - remaining;
  const status: MigrationDrainStatus =
    deadLetterCount > 0 ? 'dead_letter' : remaining === 0 ? 'success' : 'stalled';
  return { status, processed, remaining, deadLetterCount };
}
