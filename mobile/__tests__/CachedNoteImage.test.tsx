import React from 'react';
import { render } from '@testing-library/react-native';
import CachedNoteImage from '../src/components/CachedNoteImage';

// Control the two hooks the component depends on so we can drive the
// cache-hit / cache-miss and auth-ready / auth-pending combinations directly.
let mockLocalUri: string | null = null;
jest.mock('../src/hooks/useNoteImageCache', () => ({
  useCachedNoteImageUri: () => mockLocalUri,
}));

let mockAuth: { headers?: Record<string, string>; ready: boolean } = { ready: false };
jest.mock('../src/hooks/useImageAuthHeaders', () => ({
  useImageAuthHeaders: () => mockAuth,
}));

const NETWORK_URL = 'http://server/api/v1/images/img-1/thumbnail';
const AUTH_HEADER = { Cookie: 'jot_session=test-token' };

beforeEach(() => {
  mockLocalUri = null;
  mockAuth = { ready: false };
});

function renderImage() {
  return render(
    <CachedNoteImage
      imageId="img-1"
      variant="thumbnail"
      networkUrl={NETWORK_URL}
      testID="cached-image"
    />,
  );
}

describe('CachedNoteImage', () => {
  it('attaches the session cookie to the network fallback once auth is ready', () => {
    mockAuth = { headers: AUTH_HEADER, ready: true };

    const { getByTestId } = renderImage();

    expect(getByTestId('cached-image').props.source).toEqual({ uri: NETWORK_URL, headers: AUTH_HEADER });
  });

  it('does not load the network URL until the session token has resolved', () => {
    mockAuth = { ready: false };

    const { getByTestId } = renderImage();

    // No source means no request fires — avoids an unauthenticated 401 on first render.
    expect(getByTestId('cached-image').props.source).toBeUndefined();
  });

  it('renders the local cache file without auth headers when cached', () => {
    mockLocalUri = 'file:///cache/note-images/img-1_thumb';
    mockAuth = { headers: AUTH_HEADER, ready: true };

    const { getByTestId } = renderImage();

    expect(getByTestId('cached-image').props.source).toEqual({ uri: mockLocalUri });
  });
});
