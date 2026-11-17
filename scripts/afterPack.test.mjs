import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { afterPackForTest } = require('./afterPack.cjs');

describe('EVS post-packaging hook', () => {
  it('skips unsigned development builds, signs with configured EVS credentials, and preserves failures', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const env = {};
    const context = { packager: { platform: { name: 'mac' } }, appOutDir: '/tmp/package' };
    await afterPackForTest(context, env, exec);
    expect(exec).not.toHaveBeenCalled();
    env.EVS_ACCOUNT_NAME = 'organization';
    env.EVS_PASSWD = 'secret';
    await afterPackForTest(context, env, exec);
    expect(exec).toHaveBeenCalledWith('python3', ['-m', 'castlabs_evs.vmp', 'sign-pkg', '--no-ask', '/tmp/package'], {
      env: { ...env, EVS_NO_ASK: '1' }, maxBuffer: 1048576,
    });
    exec.mockRejectedValueOnce(new Error('EVS secret failure'));
    await expect(afterPackForTest(context, env, exec)).rejects.toThrow('EVS secret failure');
  });
});
