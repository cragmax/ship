// Run by worktree-fixture-template.integration.test.ts in a child vitest with a temp directory of
// its own, which the parent reads once this file's last test is over.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { makeGitRepo } from '../../../../helpers/worktree-fixture-git.js';

test('builds a template repo in the temp directory', () => {
  makeGitRepo(mkdtempSync(join(tmpdir(), 'repo-')), { 'a.txt': 'a\n' });
  const templates = readdirSync(tmpdir()).filter((name) => name.startsWith('ph-repo-templates-'));
  expect(templates).toHaveLength(1);
});
