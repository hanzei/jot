import { describe, it, expect } from 'vitest';
import { REDIRECT_PARAM, authPathWithRedirect, safeRedirectTarget } from '@/utils/authRedirect';

describe('safeRedirectTarget', () => {
  it('keeps same-origin paths, with their query and hash', () => {
    expect(safeRedirectTarget('/notes/abc123')).toBe('/notes/abc123');
    expect(safeRedirectTarget('/admin')).toBe('/admin');
    expect(safeRedirectTarget('/?label=work')).toBe('/?label=work');
    expect(safeRedirectTarget('/settings#sessions')).toBe('/settings#sessions');
  });

  it('falls back to the dashboard when there is no target', () => {
    expect(safeRedirectTarget(null)).toBe('/');
    expect(safeRedirectTarget(undefined)).toBe('/');
    expect(safeRedirectTarget('')).toBe('/');
  });

  it('rejects targets that leave the origin', () => {
    expect(safeRedirectTarget('https://evil.example/steal')).toBe('/');
    expect(safeRedirectTarget('//evil.example/steal')).toBe('/');
    expect(safeRedirectTarget('/\\evil.example/steal')).toBe('/');
    expect(safeRedirectTarget('javascript:alert(1)')).toBe('/');
    expect(safeRedirectTarget('notes/abc123')).toBe('/');
  });

  it('rejects the auth pages, which would bounce the user right back', () => {
    expect(safeRedirectTarget('/login')).toBe('/');
    expect(safeRedirectTarget(`/login?${REDIRECT_PARAM}=%2Flogin`)).toBe('/');
    expect(safeRedirectTarget('/register')).toBe('/');
  });

  // The router matches these case-insensitively and ignores trailing slashes,
  // so they reach an auth page just as "/login" does.
  it('rejects auth pages spelled the other ways the router accepts', () => {
    expect(safeRedirectTarget('/login/')).toBe('/');
    expect(safeRedirectTarget('/login//')).toBe('/');
    expect(safeRedirectTarget('/LOGIN')).toBe('/');
    expect(safeRedirectTarget('/Login/')).toBe('/');
    expect(safeRedirectTarget('/Register')).toBe('/');
    expect(safeRedirectTarget('/register/')).toBe('/');
  });

  it('keeps a path that merely starts with an auth page name', () => {
    expect(safeRedirectTarget('/logins')).toBe('/logins');
    expect(safeRedirectTarget('/notes/login')).toBe('/notes/login');
  });
});

describe('authPathWithRedirect', () => {
  it('appends the sanitized target', () => {
    expect(authPathWithRedirect('/login', '/notes/abc123')).toBe('/login?continue=%2Fnotes%2Fabc123');
    expect(authPathWithRedirect('/register', '/?label=work')).toBe('/register?continue=%2F%3Flabel%3Dwork');
  });

  it('omits the parameter for the dashboard and for rejected targets', () => {
    expect(authPathWithRedirect('/login', '/')).toBe('/login');
    expect(authPathWithRedirect('/login', null)).toBe('/login');
    expect(authPathWithRedirect('/login', 'https://evil.example')).toBe('/login');
    expect(authPathWithRedirect('/register', '/login')).toBe('/register');
  });
});
