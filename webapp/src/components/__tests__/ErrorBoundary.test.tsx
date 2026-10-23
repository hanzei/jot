import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ErrorBoundary from '../ErrorBoundary';
import ErrorFallback from '../ErrorFallback';
import { about } from '@/utils/api';

vi.mock('@/utils/api', () => ({
  about: { get: vi.fn(() => Promise.resolve({ version: '1.2.3' })) },
}));

let shouldThrow = true;

function Thrower() {
  if (shouldThrow) {
    throw new Error('render exploded');
  }
  return <p>recovered</p>;
}

function renderBoundary(resetKey = 'a', variant: 'root' | 'section' = 'section') {
  return render(
    <ErrorBoundary name="test" resetKey={resetKey} fallback={(props) => <ErrorFallback {...props} variant={variant} />}>
      <Thrower />
    </ErrorBoundary>,
  );
}

describe('ErrorBoundary', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    shouldThrow = true;
    // React and the boundary both report the caught error; both are expected here.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeText.mockReset().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the fallback and logs the error', () => {
    renderBoundary();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByText('render exploded')).toBeInTheDocument();
    expect(console.error).toHaveBeenCalledWith('Render error caught by test error boundary:', expect.any(Error));
    // The first fallback in this file fetches the version; later ones reuse it.
    // Never the redirecting 401 path: it would navigate away from the fallback.
    expect(about.get).toHaveBeenCalledExactlyOnceWith({ skipAuthRedirect: true });
  });

  it('fetches the server version at most once per page load', () => {
    renderBoundary();
    expect(about.get).not.toHaveBeenCalled();
  });

  it('re-renders the subtree on "Try again"', () => {
    renderBoundary();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('clears the error when the reset key changes', () => {
    const { rerender } = renderBoundary('a');
    shouldThrow = false;
    rerender(
      <ErrorBoundary name="test" resetKey="b" fallback={(props) => <ErrorFallback {...props} variant="section" />}>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('offers a reload at the root', () => {
    renderBoundary('a', 'root');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('copies the version, route, message and stacks', async () => {
    window.history.pushState({}, '', '/notes/abc?q=secret');
    renderBoundary();
    // Let the version fetch settle before copying.
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Copy error details' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const details = writeText.mock.lastCall![0];
    expect(details).toContain('Server version: 1.2.3');
    expect(details).toContain('Route: /notes/abc');
    expect(details).not.toContain('secret');
    expect(details).toContain('Error: Error: render exploded');
    expect(details).toContain('Stack:');
    expect(details).toContain('Component stack:');
    expect(details).toContain('Thrower');
    expect(await screen.findByText('Error details copied')).toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('says so when the clipboard is unavailable', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderBoundary();
    fireEvent.click(screen.getByRole('button', { name: 'Copy error details' }));
    expect(await screen.findByText('Could not copy error details')).toBeInTheDocument();
  });
});
