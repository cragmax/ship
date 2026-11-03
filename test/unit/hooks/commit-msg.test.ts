import { describe, expect, it } from 'vitest';

import { checkCommit, type CommitFacts } from '../../../hooks/lib/commit-msg.js';

const ON_MASTER = { branch: 'master', headVersion: '3.2.1', stagedVersion: '3.2.1' };

describe('checkCommit — format', () => {
  it('refuses a free-form first line, naming the format and every type and scope', () => {
    const [problem, ...rest] = check({ message: 'update stuff\n' });

    expect(rest).toEqual([]);
    expect(problem).toContain("'<type>(<scope>): <subject>'");
    expect(problem).toContain('types: fix, feat, refactor, test, docs, chore');
    expect(problem).toContain('scopes: workflow, cli, agents, build, tests, docs');
  });

  it.each(['# a comment git strips\n\ndocs(docs): x\n\nbody\n', 'chore(build): bump version'])(
    'accepts %j',
    (message) => {
      expect(check({ message })).toEqual([]);
    },
  );

  it.each(['feature(docs): x', 'docs(website): x', 'docs(docs):x', 'docs: x', 'Docs(docs): x', ''])(
    'refuses %j',
    (message) => {
      expect(check({ message })).toHaveLength(1);
    },
  );
});

function check(facts: Partial<CommitFacts> & Pick<CommitFacts, 'message'>): string[] {
  return checkCommit({ ...ON_MASTER, ...facts });
}

describe('checkCommit — bump on master', () => {
  it('refuses a fix without a patch bump, naming npm version patch', () => {
    expect(check({ message: 'fix(workflow): x' })).toEqual([
      "a fix commit on master stages version 3.2.2 over HEAD's 3.2.1, not 3.2.1: " +
        'run `npm version patch --no-git-tag-version`, then stage package.json and package-lock.json',
    ]);
  });

  it('accepts a fix one patch step up, and refuses two', () => {
    expect(check({ message: 'fix(workflow): x', stagedVersion: '3.2.2' })).toEqual([]);
    expect(check({ message: 'fix(workflow): x', stagedVersion: '3.2.3' })).toHaveLength(1);
  });

  it('needs a minor step with patch reset for a feat, naming npm version minor', () => {
    expect(check({ message: 'feat(cli): x', stagedVersion: '3.3.0' })).toEqual([]);
    const [problem] = check({ message: 'feat(cli): x', stagedVersion: '3.2.2' });
    expect(problem).toContain('stages version 3.3.0');
    expect(problem).toContain('npm version minor --no-git-tag-version');
  });

  it('refuses a docs commit that changes the version', () => {
    expect(check({ message: 'docs(docs): x', stagedVersion: '3.2.2' })).toEqual([
      "a docs commit on master stages version 3.2.1 over HEAD's 3.2.1, not 3.2.2: " +
        "a docs commit does not bump: stage package.json at HEAD's version",
    ]);
  });

  it.each([
    { branch: 'ship/epic-1', why: 'a branch' },
    { branch: null, why: 'a detached HEAD' },
  ])('skips the bump check on $why', ({ branch }) => {
    expect(check({ message: 'fix(workflow): x', branch })).toEqual([]);
    expect(check({ message: 'update stuff', branch })).toHaveLength(1);
  });

  it('skips the bump check when HEAD has no version', () => {
    expect(check({ message: 'fix(workflow): x', headVersion: null })).toEqual([]);
  });
});
