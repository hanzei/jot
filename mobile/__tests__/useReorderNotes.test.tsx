import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReorderNotes } from '../src/hooks/useNotes';
import * as notesApi from '../src/api/notes';

jest.mock('../src/api/notes');

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const mockNotesApi = notesApi as jest.Mocked<typeof notesApi>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useReorderNotes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls reorderNotes API with note IDs', async () => {
    mockNotesApi.reorderNotes.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useReorderNotes(), { wrapper: createWrapper() });

    result.current.mutate(['id-1', 'id-2', 'id-3']);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockNotesApi.reorderNotes).toHaveBeenCalledWith(['id-1', 'id-2', 'id-3']);
  });

  it('handles reorder failure', async () => {
    mockNotesApi.reorderNotes.mockRejectedValueOnce(new Error('Failed'));

    const { result } = renderHook(() => useReorderNotes(), { wrapper: createWrapper() });

    result.current.mutate(['id-1']);

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
