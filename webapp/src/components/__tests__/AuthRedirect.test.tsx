import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { LoginRedirect, PostAuthRedirect } from '@/components/AuthRedirect';

// Renders wherever the redirect landed, so a test can read it back.
function LandedOn() {
  const location = useLocation();
  return <div data-testid="landed-on">{location.pathname + location.search}</div>;
}

// Mounts the redirect at `initialEntry` only, so wherever it sends the user
// renders LandedOn rather than the redirect a second time.
const renderAt = (initialEntry: string, element: React.ReactElement) => {
  const entryPath = initialEntry.split('?')[0]!; // split always yields an entry
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path={entryPath} element={element} />
        <Route path="*" element={<LandedOn />} />
      </Routes>
    </MemoryRouter>
  );
};

const landedOn = () => screen.getByTestId('landed-on').textContent;

describe('LoginRedirect', () => {
  it('remembers the page the visitor asked for', () => {
    renderAt('/settings', <LoginRedirect />);
    expect(landedOn()).toBe('/login?continue=%2Fsettings');
  });

  it('keeps the query string of the page they asked for', () => {
    renderAt('/notes/abc123?edit=1', <LoginRedirect />);
    expect(landedOn()).toBe('/login?continue=%2Fnotes%2Fabc123%3Fedit%3D1');
  });
});

describe('PostAuthRedirect', () => {
  it('hands back the page the visitor was bounced from', () => {
    renderAt(`/login?continue=${encodeURIComponent('/settings')}`, <PostAuthRedirect />);
    expect(landedOn()).toBe('/settings');
  });

  it('falls back to the dashboard without a target', () => {
    renderAt('/login', <PostAuthRedirect />);
    expect(landedOn()).toBe('/');
  });

  it('falls back to the dashboard for an off-site target', () => {
    renderAt(`/login?continue=${encodeURIComponent('https://evil.example/')}`, <PostAuthRedirect />);
    expect(landedOn()).toBe('/');
  });
});
