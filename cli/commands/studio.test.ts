import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStudio } from './studio.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('studio command: configuration errors', () => {
  it('prints an invalid AGENTINTAKE_CORS_ORIGINS entry and exits 1, without a stack trace', async () => {
    vi.stubEnv('AGENTINTAKE_CORS_ORIGINS', 'https://app.example.com/app');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Stops execution where the real exit would.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(runStudio({ open: false, port: '0' })).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledTimes(1);
    const printed = String(error.mock.calls[0][0]);
    expect(printed).toContain('https://app.example.com/app');
    expect(printed).not.toMatch(/\n\s+at /);
  });
});
