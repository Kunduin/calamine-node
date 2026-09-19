import { execFileSync } from 'node:child_process';

// Explicit dispatch starts checks without a PAT or approving bot-created PR runs.
const pullRequests = JSON.parse(process.env.RELEASE_PRS || '[]');
for (const pullRequest of pullRequests) {
  execFileSync('gh', ['workflow', 'run', 'CI.yml', '--ref', pullRequest.headBranchName], {
    stdio: 'inherit',
  });
}

if (process.env.RELEASE_TAG) {
  execFileSync(
    'gh',
    ['workflow', 'run', 'publish.yml', '--ref', process.env.RELEASE_TAG, '-f', 'mode=publish'],
    { stdio: 'inherit' },
  );
}
