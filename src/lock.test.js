// node --test src/lock.test.js    (or: npm test)

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { acquireLock, lockMessage } from './lock.js';

const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('a second copy is refused while the first is running', () => {
  const path = join(dir, 'a.lock');
  const first = acquireLock(path, { pid: 100, name: 'npm start', alive: () => true });
  assert.equal(first.ok, true);
  const second = acquireLock(path, { pid: 200, name: 'npm run auto', alive: () => true });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, 100);
  assert.match(lockMessage(second.holder, path), /npm start \(process 100/);
});

test("a lock left by a copy that died is taken over, not obeyed", () => {
  const path = join(dir, 'b.lock');
  acquireLock(path, { pid: 100, alive: () => true });
  const next = acquireLock(path, { pid: 200, alive: (pid) => pid !== 100 });
  assert.equal(next.ok, true);
  assert.equal(next.took.pid, 100);
});

test('releasing removes only our own lock', () => {
  const path = join(dir, 'c.lock');
  const mine = acquireLock(path, { pid: 100, alive: () => true });
  mine.release();
  assert.equal(existsSync(path), false);

  const theirs = acquireLock(path, { pid: 300, alive: () => true });
  mine.release(); // a stale handle must not delete someone else's lock
  assert.equal(existsSync(path), true);
  theirs.release();
});
