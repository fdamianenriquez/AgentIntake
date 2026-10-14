import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStudioConfigStore } from './studioConfig.js';

describe('createStudioConfigStore', () => {
  it('loads the config at start, resolves its path, and swaps it in memory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentintake-studio-config-'));
    writeFileSync(path.join(dir, 'agentintake.config.json'), JSON.stringify({ guidance: { tone: 'Formal.' } }));
    const store = createStudioConfigStore({}, dir);

    expect(store.path).toBe(path.join(dir, 'agentintake.config.json'));
    expect(store.get()).toEqual({ guidance: { tone: 'Formal.' } });
    store.set({ guidance: { tone: 'Casual.' } });
    expect(store.get()).toEqual({ guidance: { tone: 'Casual.' } });
  });

  it('starts empty, with the path a save would write to, when there is no file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentintake-studio-config-'));
    const store = createStudioConfigStore({}, dir);

    expect(store.get()).toBeNull();
    expect(store.path).toBe(path.join(dir, 'agentintake.config.json'));
  });
});
