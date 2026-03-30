import type { GetNotesParams } from '@jot/shared';
import { currentQueryServerScope } from './queryScope';

export function notesQueryScopeKey(): [string, string] {
  return ['notes', currentQueryServerScope()];
}

export function notesQueryKey(params?: GetNotesParams): [string, string, GetNotesParams | undefined] {
  return ['notes', currentQueryServerScope(), params];
}

export function noteQueryScopeKey(): [string, string] {
  return ['note', currentQueryServerScope()];
}

export function noteQueryKey(noteId: string | null): [string, string, string | null] {
  return ['note', currentQueryServerScope(), noteId];
}

export function notesLocalQueryScopeKey(): [string, string] {
  return ['notes-local', currentQueryServerScope()];
}

export function notesLocalQueryKey(params?: GetNotesParams): [string, string, GetNotesParams | undefined] {
  return ['notes-local', currentQueryServerScope(), params];
}

export function noteLocalQueryScopeKey(): [string, string] {
  return ['note-local', currentQueryServerScope()];
}

export function noteLocalQueryKey(noteId: string | null): [string, string, string | null] {
  return ['note-local', currentQueryServerScope(), noteId];
}

export function labelsQueryKey(): [string, string] {
  return ['labels', currentQueryServerScope()];
}

export function noteSharesQueryKey(noteId: string | null): [string, string, string | null] {
  return ['noteShares', currentQueryServerScope(), noteId];
}
