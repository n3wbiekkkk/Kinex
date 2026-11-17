const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function evsConfigured(env) {
  return Boolean(env.EVS_ACCOUNT_NAME && env.EVS_PASSWD);
}

async function afterPackForTest(context, env, execute) {
  if (context.packager.platform.name !== 'mac' || !evsConfigured(env)) return;
  await execute('python3', ['-m', 'castlabs_evs.vmp', 'sign-pkg', '--no-ask', context.appOutDir], {
    env: { ...env, EVS_NO_ASK: '1' }, maxBuffer: 1024 * 1024,
  });
}
async function afterPack(context) {
  return afterPackForTest(context, process.env, promisify(execFile));
}

module.exports = afterPack;
module.exports.evsConfigured = evsConfigured;
module.exports.afterPackForTest = afterPackForTest;
