import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function temporaryDirectory(t) {
  // macOS /var and /tmp can be symlinks; scaffold requires canonical ancestors.
  const path = await realpath(await mkdtemp(join(tmpdir(), 'fastagent-test-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
