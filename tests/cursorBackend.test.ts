import { describe, expect, it } from 'vitest';
import { resolveCursorModelId } from '../src/backends/cursorBackend.js';

describe('cursorBackend', () => {
  it('resolveCursorModelId maps composer aliases for ACP', () => {
    expect(resolveCursorModelId('composer-latest')).toBe('default[]');
    expect(resolveCursorModelId('composer-2.5')).toBe('composer-2.5[fast=true]');
    expect(resolveCursorModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(resolveCursorModelId('composer-2[fast=true]')).toBe('composer-2[fast=true]');
  });
});
