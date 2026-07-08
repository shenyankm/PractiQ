import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeSource = readFileSync('../internal/db/runtime.go', 'utf8');

describe('database bootstrap schema ownership', () => {
  it('keeps the Go runtime helpers focused on applying split SQL, prerequisite checks, and seed data', () => {
    expect(runtimeSource).toContain('CollectSQLFiles');
    expect(runtimeSource).toContain('Database bootstrap prerequisites are missing');
    expect(runtimeSource).toContain('Database seed prerequisites are missing');
  });

  it('does not embed duplicate product schema definitions in runtime helpers', () => {
    expect(runtimeSource).not.toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(runtimeSource).not.toMatch(/ALTER TABLE users/);
  });
});
