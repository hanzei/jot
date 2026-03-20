import { describe, expect, it } from 'vitest';
import {
  applyBold,
  applyItalic,
  applyStrikethrough,
  applyHeading,
  applyBulletList,
  applyOrderedList,
  applyCode,
  applyLink,
  insertHorizontalRule,
} from '@/utils/noteMarkdownFormatting';

describe('noteMarkdownFormatting', () => {
  describe('inline wrappers', () => {
    it.each([
      ['bold', applyBold, '**hello**'],
      ['italic', applyItalic, '*hello*'],
      ['strikethrough', applyStrikethrough, '~~hello~~'],
    ])('applies %s with a selection', (_label, formatter, expectedValue) => {
      const result = formatter('hello', { start: 0, end: 5 });

      expect(result.value).toBe(expectedValue);
      expect(result.selectionStart).toBe(expectedValue.length);
      expect(result.selectionEnd).toBe(expectedValue.length);
    });

    it.each([
      ['bold', applyBold, 'hello**** world', 7],
      ['italic', applyItalic, 'hello** world', 6],
      ['strikethrough', applyStrikethrough, 'hello~~~~ world', 7],
    ])('applies %s without a selection', (_label, formatter, expectedValue, cursorPosition) => {
      const result = formatter('hello world', { start: 5, end: 5 });

      expect(result.value).toBe(expectedValue);
      expect(result.selectionStart).toBe(cursorPosition);
      expect(result.selectionEnd).toBe(cursorPosition);
    });
  });

  describe('heading toggles', () => {
    it('adds a heading prefix on the current line without a selection', () => {
      const result = applyHeading('Title', { start: 5, end: 5 }, 2);

      expect(result.value).toBe('## Title');
      expect(result.selectionStart).toBe(8);
      expect(result.selectionEnd).toBe(8);
    });

    it('toggles the same heading prefix off', () => {
      const result = applyHeading('### Title', { start: 9, end: 9 }, 3);

      expect(result.value).toBe('Title');
      expect(result.selectionStart).toBe(5);
      expect(result.selectionEnd).toBe(5);
    });

    it('replaces a different heading level across a selection', () => {
      const result = applyHeading('# First\nSecond', { start: 0, end: 14 }, 4);

      expect(result.value).toBe('#### First\n#### Second');
      expect(result.selectionStart).toBe(0);
      expect(result.selectionEnd).toBe(result.value.length);
    });
  });

  describe('list formatting', () => {
    it('adds bullet list markers to selected lines', () => {
      const result = applyBulletList('Alpha\nBeta', { start: 0, end: 10 });

      expect(result.value).toBe('- Alpha\n- Beta');
      expect(result.selectionStart).toBe(0);
      expect(result.selectionEnd).toBe(result.value.length);
    });

    it('adds a bullet list marker without a selection', () => {
      const result = applyBulletList('Alpha', { start: 5, end: 5 });

      expect(result.value).toBe('- Alpha');
      expect(result.selectionStart).toBe(7);
      expect(result.selectionEnd).toBe(7);
    });

    it('adds ordered list markers to selected lines', () => {
      const result = applyOrderedList('Alpha\nBeta', { start: 0, end: 10 });

      expect(result.value).toBe('1. Alpha\n1. Beta');
      expect(result.selectionStart).toBe(0);
      expect(result.selectionEnd).toBe(result.value.length);
    });

    it('adds an ordered list marker without a selection', () => {
      const result = applyOrderedList('Alpha', { start: 5, end: 5 });

      expect(result.value).toBe('1. Alpha');
      expect(result.selectionStart).toBe(8);
      expect(result.selectionEnd).toBe(8);
    });
  });

  describe('code formatting', () => {
    it('wraps single-line selections in inline code', () => {
      const result = applyCode('hello', { start: 0, end: 5 });

      expect(result.value).toBe('`hello`');
      expect(result.selectionStart).toBe(7);
      expect(result.selectionEnd).toBe(7);
    });

    it('adds inline code markers without a selection', () => {
      const result = applyCode('hello world', { start: 5, end: 5 });

      expect(result.value).toBe('hello`` world');
      expect(result.selectionStart).toBe(6);
      expect(result.selectionEnd).toBe(6);
    });

    it('wraps multi-line selections in fenced code blocks', () => {
      const result = applyCode('line 1\nline 2', { start: 0, end: 13 });

      expect(result.value).toBe('```\nline 1\nline 2\n```');
      expect(result.selectionStart).toBe(result.value.length);
      expect(result.selectionEnd).toBe(result.value.length);
    });
  });

  describe('link formatting', () => {
    it('wraps selected text in a markdown link', () => {
      const result = applyLink('hello', { start: 0, end: 5 });

      expect(result.value).toBe('[hello](url)');
      expect(result.selectionStart).toBe(8);
      expect(result.selectionEnd).toBe(11);
    });

    it('inserts an empty markdown link without a selection', () => {
      const result = applyLink('hello world', { start: 5, end: 5 });

      expect(result.value).toBe('hello[](url) world');
      expect(result.selectionStart).toBe(8);
      expect(result.selectionEnd).toBe(11);
    });
  });

  describe('horizontal rules', () => {
    it('inserts a horizontal rule at the cursor position', () => {
      const result = insertHorizontalRule('Alpha', { start: 5, end: 5 });

      expect(result.value).toBe('Alpha\n---');
      expect(result.selectionStart).toBe(9);
      expect(result.selectionEnd).toBe(9);
    });

    it('inserts a horizontal rule before an active selection', () => {
      const result = insertHorizontalRule('Alpha\nBeta', { start: 6, end: 10 });

      expect(result.value).toBe('Alpha\n---\nBeta');
      expect(result.selectionStart).toBe(9);
      expect(result.selectionEnd).toBe(9);
    });
  });
});
