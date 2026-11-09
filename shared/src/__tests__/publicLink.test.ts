import { describe, expect, it } from 'vitest';
import { publicNoteUrl } from '../publicLink';

const token = 'q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw';

describe('publicNoteUrl', () => {
  it('builds the share URL from a base without a trailing slash', () => {
    expect(publicNoteUrl('https://jot.example.com', token)).toBe(`https://jot.example.com/share/${token}`);
  });

  it('builds the same URL from a base with a trailing slash', () => {
    expect(publicNoteUrl('https://jot.example.com/', token)).toBe(`https://jot.example.com/share/${token}`);
    expect(publicNoteUrl('https://jot.example.com///', token)).toBe(`https://jot.example.com/share/${token}`);
  });

  it('keeps a port and an IP host', () => {
    expect(publicNoteUrl('http://192.168.1.10:8080', token)).toBe(`http://192.168.1.10:8080/share/${token}`);
  });

  it('keeps base64url tokens as they are', () => {
    expect(publicNoteUrl('https://jot.example.com', 'a-b_c')).toBe('https://jot.example.com/share/a-b_c');
  });
});
