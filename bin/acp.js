#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const messages = require('../lib/messages');
const pkg = require('../package.json');

// ---------- output helpers ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');
const dim = paint('2');

const HELP = `
${cyan('acp')} — git add, commit and push in one go

Usage: acp [options]

Options:
  -u, --upstream          Push to origin, then open a pull request to "upstream"
  -ua, --upstream-allow   Same as -u, then merge it if you have write access
                          (--upstream-merge works too)
  -bpa, --branch-pr-auto  Push to a new branch on origin, open a pull request into
                          the default branch, merge it, then delete the branch
                          (-b <name> picks the branch name)
  -bopa, --branch-origin-pr-auto
                          Same as -bpa
  -b, --branch <name>     Push to <name> instead of "main"
  -m, --message <text>    Use your own commit message instead of a random one
  -c, --chunks            Split your changes into 10 smaller commits. With -u or
                          -ua, each commit is pushed with its own pull request
  -h, --help              Show this help
  -v, --version           Show the version

GitHub accounts:
  If the GitHub CLI (gh) is installed, acp picks the gh account that matches
  the repo owner (github.com/<owner>/...). If none matches, it uses the
  account you used last. Log in to each account once with: gh auth login

Pull requests:
  -u and -ua need the GitHub CLI (gh) and a remote called "upstream". The
  pull request goes from <branch> on origin (your fork) to the default
  branch of upstream. If one is already open, the push just updates it.
  -ua only merges if your account can write to upstream (write, maintain
  or admin role). Otherwise the pull request is left open.
  Without an "origin" remote, acp pushes the branch straight to upstream
  and opens the pull request from there. The branch is your current one,
  -b <name>, or a new acp-<date> branch when you are on upstream's default.

One repo (-bpa, -bopa):
  Needs the GitHub CLI (gh) and an "origin" remote on GitHub. The branch is
  named acp-<date> unless you give -b <name>. The merge needs write access to
  origin; without it the pull request stays open and the branch is kept.
  If you are on the default branch, it is updated after the merge.

git-multi-commit:
  If the repo root has a .git-multi-commit.json file, acp still adds and
  commits locally, then runs git-multi-commit instead of git push.
  With -u or -ua and an "upstream" remote, acp also pushes <branch> (to
  origin, or straight to upstream when there is no origin) and opens (and
  with -ua merges) the pull request. Without "upstream" it warns and skips
  that part. -b only applies when the pull request step runs.
  With -bpa, every repo in the config gets its own branch, pull request into
  its default branch, merge and branch delete. -b <name> works here too.

Examples:
  acp                      ${dim('# push to origin/main')}
  acp -u                   ${dim('# push to origin/main, open a PR to upstream')}
  acp -ua                  ${dim('# same, then merge the PR if you can')}
  acp -bpa                 ${dim('# push a new branch, PR into main, merge, delete the branch')}
  acp -bopa                ${dim('# same as -bpa')}
  acp -b dev               ${dim('# push to origin/dev')}
  acp -u --branch fix      ${dim('# push to origin/fix, open a PR to upstream')}
  acp -m "Fix login bug"   ${dim('# custom message, push to origin/main')}
  acp -c                   ${dim('# commit in 10 chunks, then push')}
  acp -c -ua               ${dim('# each chunk: push, open a PR, merge it')}
  acp -ua                  ${dim('# only "upstream" set: push a branch there, PR + merge')}
`;

function fail(message) {
  console.error(red(`✖ ${message}`));
  process.exit(1);
}

// ---------- argument parsing ----------
function parseArgs(argv) {
  const options = { branch: 'main', branchGiven: false, message: null, pr: false, merge: false, chunks: false, bpa: false };

  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let inlineValue;

    // Support --branch=dev and --message="text"
    if (flag.startsWith('--') && flag.includes('=')) {
      inlineValue = flag.slice(flag.indexOf('=') + 1);
      flag = flag.slice(0, flag.indexOf('='));
    }

    const takeValue = () => {
      if (inlineValue !== undefined) {
        if (!inlineValue) fail(`${flag} needs a value`);
        return inlineValue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) fail(`${flag} needs a value`);
      i++;
      return next;
    };

    switch (flag) {
      case '-u':
      case '--upstream':
        options.pr = true;
        break;
      case '-ua':
      case '--upstream-allow':
      case '--upstream-merge':
        options.pr = true;
        options.merge = true;
        break;
      case '-bpa':
      case '--branch-pr-auto':
      case '-bopa':
      case '--branch-origin-pr-auto':
        options.bpa = true;
        options.pr = true;
        options.merge = true;
        break;
      case '-b':
      case '--branch':
        options.branch = takeValue();
        options.branchGiven = true;
        break;
      case '-m':
      case '--message':
        options.message = takeValue();
        break;
      case '-c':
      case '--chunks':
        options.chunks = true;
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      case '-v':
      case '--version':
        console.log(pkg.version);
        process.exit(0);
        break;
      default:
        fail(`Unknown option "${flag}". Run "acp --help" to see all options.`);
    }
  }

  return options;
}

// ---------- process helpers ----------
// Arguments are passed as an array (no shell), so commit messages with
// quotes, spaces or special characters are always safe. Only pass
// `shell: true` for commands that take no user input.
function run(cmd, args, { quiet = false, env, stdio, shell = false } = {}) {
  return spawnSync(cmd, args, {
    stdio: stdio || (quiet ? 'pipe' : 'inherit'),
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    shell,
  });
}

function git(args, options) {
  const result = run('git', args, options);
  if (result.error) {
    if (result.error.code === 'ENOENT') fail('git is not installed or not on your PATH.');
    fail(result.error.message);
  }
  return result;
}

function step(args, { extraArgs = [], env, hint } = {}) {
  const shown = args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  console.log(cyan(`› git ${shown}`));
  // When a hint is set, capture git's error output so we can tell whether
  // the push failed because of permissions (403, denied, auth failed).
  const result = git([...extraArgs, ...args], {
    env,
    stdio: hint ? ['inherit', 'inherit', 'pipe'] : undefined,
  });
  if (hint && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const authError = /\b403\b|permission|denied|authentication failed|could not read username|repository not found/i;
    if (hint && authError.test(result.stderr || '')) console.error(yellow(hint));
    fail(`"git ${args[0]}" failed (exit code ${result.status}).`);
  }
}

function randomMessage() {
  return messages[Math.floor(Math.random() * messages.length)];
}

// ---------- chunked commits ----------
const MAX_CHUNKS = 10;

// The changes that are still uncommitted, as a list of units: each hunk of
// a tracked file's diff, any change without hunks (binary, mode change), and
// each untracked file as a whole. Units of one file stay in file order.
function changeUnits() {
  const diff = git(['diff', '--no-color', '--no-renames', '--binary', '-U0'], { quiet: true }).stdout;
  const units = [];

  for (const section of diff.split(/^(?=diff --git )/m).filter(Boolean)) {
    const at = section.search(/^@@ /m);
    if (at === -1) {
      units.push({ patch: section });
      continue;
    }
    const header = section.slice(0, at);
    for (const hunk of section.slice(at).split(/^(?=@@ )/m)) units.push({ patch: header + hunk });
  }

  const untracked = git(['ls-files', '-o', '--exclude-standard', '-z'], { quiet: true }).stdout;
  for (const file of untracked.split('\0').filter(Boolean)) units.push({ file });
  return units;
}

function stage(unit) {
  if (unit.file) {
    git(['add', '--', unit.file], { quiet: true });
    return;
  }
  const result = spawnSync('git', ['apply', '--cached', '--unidiff-zero', '--binary'], {
    input: unit.patch,
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(`Could not stage a change: ${(result.stderr || '').trim()}`);
}

// Commits the changes as MAX_CHUNKS commits (fewer if there are fewer separate
// changes), splitting the individual changes (hunks) as evenly as possible,
// even within one file. afterCommit runs after each commit. Returns false when there was nothing to commit.
function commitInChunks(message, afterCommit) {
  // Start from a clean index so each commit holds only its own chunk.
  git(['reset', '-q'], { quiet: true });

  const total = changeUnits().length;
  if (!total) return false;

  const count = Math.min(MAX_CHUNKS, total);
  console.log(cyan(`• Splitting ${total} change(s) into ${count} commit(s)`));

  const pool = [...messages];
  for (let i = 0; i < count; i++) {
    // The diff is read again after every commit, so line numbers stay right.
    const units = changeUnits();
    const take = Math.ceil(units.length / (count - i));
    units.slice(0, take).forEach(stage);

    let text;
    if (message) {
      text = `${message} (${i + 1}/${count})`;
    } else {
      // Draw without repeats so the log doesn't show the same message twice.
      text = pool.length ? pool.splice(Math.floor(Math.random() * pool.length), 1)[0] : randomMessage();
    }
    step(['commit', '-m', text]);
    if (afterCommit) afterCommit(i + 1, count);
  }
  return true;
}

// ---------- GitHub account picking (via gh CLI) ----------
// Returns { owner, name } for a GitHub remote URL (HTTPS or SSH), or null.
function githubRepo(url) {
  const match = url.match(
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  );
  return match ? { owner: match[1], name: match[2] } : null;
}

// Returns { accounts: [...logins], active: login } or null.
function ghAccounts() {
  const json = run('gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], { quiet: true });
  if (json.error) return null; // gh is not installed

  try {
    const list = JSON.parse(json.stdout).hosts['github.com'] || [];
    if (list.length) {
      const active = list.find((a) => a.active) || list[0];
      return { accounts: list.map((a) => a.login), active: active.login };
    }
    return null;
  } catch (_) {
    // Older gh without --json: read the plain-text status instead.
  }

  const plain = run('gh', ['auth', 'status', '--hostname', 'github.com'], { quiet: true });
  const text = `${plain.stdout || ''}\n${plain.stderr || ''}`;
  const found = [...text.matchAll(/github\.com (?:account|as) ([A-Za-z0-9-]+)/g)];
  if (!found.length) return null;

  const accounts = found.map((m) => m[1]);
  let active = accounts[0];
  found.forEach((m, i) => {
    const block = text.slice(m.index, found[i + 1] ? found[i + 1].index : undefined);
    if (/Active account: true/.test(block)) active = m[1];
  });
  return { accounts, active };
}

function ghToken(login, isActive) {
  let result = run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], { quiet: true });
  if (result.status !== 0 && isActive) {
    result = run('gh', ['auth', 'token', '--hostname', 'github.com'], { quiet: true });
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

// Works out which gh account to push with and returns the extra git
// arguments + env needed to use it. Returns null to use normal git login.
// With `writeRepo` ("owner/name"), an account that can push to that repo is
// preferred, because the owner's account may not exist (an organisation).
function githubAuth(remoteUrl, writeRepo) {
  if (/^(ssh:\/\/)?git@github\.com[:/]/i.test(remoteUrl)) {
    console.log(dim('• SSH remote, using your SSH key.'));
    return null;
  }

  const repo = githubRepo(remoteUrl);
  if (!repo) return null; // not a GitHub https remote
  const owner = repo.owner;

  const gh = ghAccounts();
  if (!gh) {
    console.log(dim('• GitHub CLI not found or not logged in, using your normal git login.'));
    return null;
  }

  // GitHub usernames are case-insensitive (Gobibahu === GobiBahu).
  const match = gh.accounts.find((a) => a.toLowerCase() === owner.toLowerCase());
  let account = match || gh.active;
  let writer = null;

  if (writeRepo) {
    const candidates = [match, gh.active, ...gh.accounts].filter(Boolean);
    writer = candidates.find((a) => {
      const token = ghToken(a, a === gh.active);
      return token && canPush(writeRepo, { GH_TOKEN: token });
    });
    if (writer) account = writer;
  }

  if (match && account === match) {
    console.log(cyan(`• Using GitHub account "${account}" (owner of this repo)`));
  } else if (writer) {
    console.log(cyan(`• Using GitHub account "${account}" (has write access to ${writeRepo})`));
  } else {
    console.log(cyan(`• No gh account for "${owner}", using last used account "${account}"`));
  }

  // Make it gh's active account, so it becomes the "last used" one.
  if (account !== gh.active) {
    const switched = run('gh', ['auth', 'switch', '--hostname', 'github.com', '--user', account], { quiet: true });
    if (switched.status !== 0) console.log(yellow(`⚠ Could not switch gh to "${account}", continuing anyway.`));
  }

  const token = ghToken(account, account === gh.active);
  if (!token) {
    console.log(yellow(`⚠ Could not get a token for "${account}", using your normal git login.`));
    return null;
  }

  // A one-off credential helper just for this push: it clears any saved
  // helpers (like Windows Credential Manager) and hands git the gh token.
  // The token travels in an env var, never on the command line.
  const helper =
    '!f() { if [ "$1" = get ]; then echo "username=$ACP_GH_USER"; echo "password=$ACP_GH_TOKEN"; fi; }; f';

  return {
    extraArgs: ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`],
    env: { ACP_GH_USER: account, ACP_GH_TOKEN: token },
    hint:
      `⚠ GitHub account "${account}" may not have push access to this repo.\n` +
      `  Log in to an account that does with: gh auth login`,
  };
}

// ---------- pull requests (via gh CLI) ----------
// Checks everything -u needs before anything is committed. Returns the
// upstream repo ("owner/name") plus the owners of upstream and the fork.
// With no originUrl there is no fork: the branch goes straight to upstream
// (`direct`), so the pull request's head and base are the same repo.
// `baseRemote` is the remote the pull request goes into ("upstream", or
// "origin" for -bpa, where the branch and the pull request live in one repo).
function pullRequestTarget(originUrl, baseRemote = 'upstream') {
  const upstreamUrl = git(['remote', 'get-url', baseRemote], { quiet: true });
  if (upstreamUrl.status !== 0) {
    fail(`Remote "${baseRemote}" does not exist. Add it with: git remote add ${baseRemote} <url>`);
  }

  const head = originUrl ? githubRepo(originUrl) : null;
  const base = githubRepo(upstreamUrl.stdout.trim());
  if (!base || (originUrl && !head)) {
    fail(
      originUrl
        ? 'Pull requests need "origin" and "upstream" to both be GitHub repos.'
        : `Pull requests need "${baseRemote}" to be a GitHub repo.`
    );
  }

  if (run('gh', ['--version'], { quiet: true }).status !== 0) {
    fail('Pull requests need the GitHub CLI (gh). Install it from https://cli.github.com');
  }

  return {
    repo: `${base.owner}/${base.name}`,
    baseOwner: base.owner,
    headOwner: head ? head.owner : base.owner,
    direct: !originUrl,
  };
}

// The branch to push to upstream when there is no fork: -b if given, else the
// branch you are on, else a new acp-<date> one (a pull request can't go from
// upstream's default branch into itself).
// With `fresh` (-bpa) it is always a new acp-<date> branch unless -b names one,
// because the branch is deleted after the merge.
// Also stores the default branch as target.base.
function directBranch(target, requested, fresh = false) {
  const result = run('gh', ['api', `repos/${target.repo}`, '--jq', '.default_branch'], { quiet: true, env: target.env });
  const base = result.status === 0 ? result.stdout.trim() : '';
  if (!base) fail(`Could not read the default branch of ${target.repo} with gh. Is gh logged in?`);
  target.base = base;

  if (requested) {
    if (requested === base) fail(`-b ${requested} is the default branch of ${target.repo}, a pull request needs another one.`);
    return requested;
  }

  if (!fresh) {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).stdout.trim();
    if (current && current !== 'HEAD' && current !== base) return current;
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `acp-${stamp}`;
}

// True when the gh account behind `env` has write access to `repo`
// (the write, maintain or admin role), which is what merging needs.
function canPush(repo, env) {
  const result = run('gh', ['api', `repos/${repo}`], { quiet: true, env });
  try {
    return JSON.parse(result.stdout).permissions.push === true;
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Opens a pull request from <branch> on the fork to upstream's default
// branch, and merges it when `merge` is set.
function pullRequest(target, branch, merge) {
  const gh = ghAccounts();
  const accountFor = (owner) => gh && gh.accounts.find((a) => a.toLowerCase() === owner.toLowerCase());
  // GH_TOKEN makes gh act as that account. Without it gh uses its active one.
  const envFor = (login) => {
    const token = login && ghToken(login, login === gh.active);
    return token ? { GH_TOKEN: token } : undefined;
  };

  const opener = target.opener || accountFor(target.headOwner);
  const head = `${target.headOwner}:${branch}`;
  const title = git(['log', '-1', '--pretty=%s'], { quiet: true }).stdout.trim();

  console.log(cyan(`› gh pr create --repo ${target.repo} --head ${head}`));
  const created = run(
    'gh',
    ['pr', 'create', '--repo', target.repo, '--head', head, '--title', title, '--body', ''],
    { quiet: true, env: envFor(opener) }
  );
  // gh prints the new PR's URL, or the open one's when it already exists.
  const output = `${created.stdout || ''}\n${created.stderr || ''}`;
  const found = output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
  if (!found || (created.status !== 0 && !/already exists/i.test(output))) {
    if (created.stderr) process.stderr.write(created.stderr);
    fail(`"gh pr create" failed (exit code ${created.status}).`);
  }

  const url = found[0];
  if (created.status === 0) {
    console.log(green(`✔ Pull request opened: ${url}`));
  } else {
    console.log(yellow(`• Pull request already open, updated by this push: ${url}`));
  }
  if (!merge) return false;

  // Only merge with write access to upstream (write, maintain or admin).
  // The fork's owner often doesn't have it, so the gh account that owns
  // upstream is tried first when there is one.
  const owner = accountFor(target.baseOwner);
  let merger = owner || opener;
  let env = envFor(merger);
  let allowed = canPush(target.repo, env);
  if (!allowed && merger !== opener) {
    merger = opener;
    env = envFor(merger);
    allowed = canPush(target.repo, env);
  }
  if (!allowed) {
    console.log(yellow(`• No write access to ${target.repo}, so the pull request stays open for a maintainer to merge.`));
    return false;
  }
  if (merger && merger !== opener) {
    console.log(cyan(`• Merging with GitHub account "${merger}" (owner of upstream)`));
  }

  console.log(cyan(`› gh pr merge ${url} --merge`));
  let merged;
  for (let attempt = 1; attempt <= 3; attempt++) {
    merged = run('gh', ['pr', 'merge', url, '--merge'], { quiet: true, env });
    // GitHub needs a moment to work out whether a brand new PR can be merged.
    if (merged.status === 0 || !/GraphQL: .*not mergeable/i.test(merged.stderr || '')) break;
    if (attempt < 3) sleep(2000);
  }
  if (merged.status !== 0) {
    if (merged.stderr) process.stderr.write(merged.stderr);
    console.error(yellow(`⚠ The pull request is still open: ${url}`));
    fail(`"gh pr merge" failed (exit code ${merged.status}).`);
  }
  console.log(green(`✔ Merged into ${target.repo}`));
  return true;
}

// -bpa, after the merge: deletes the pull request's branch on the remote and,
// when you are on the default branch, fast-forwards it to the merged result.
// The pull request is already merged, so problems here only warn.
function cleanUp(remote, branch, base, auth) {
  const extraArgs = auth.extraArgs || [];
  const quietly = (args) => git([...extraArgs, ...args], { env: auth.env, stdio: ['inherit', 'inherit', 'pipe'] });

  console.log(cyan(`› git push ${remote} --delete ${branch}`));
  const deleted = quietly(['push', remote, '--delete', branch]);
  if (deleted.status === 0) {
    console.log(green(`✔ Deleted ${remote}/${branch}`));
  } else if (/remote ref does not exist/i.test(deleted.stderr || '')) {
    console.log(dim(`• ${remote}/${branch} was already deleted.`));
  } else {
    if (deleted.stderr) process.stderr.write(deleted.stderr);
    console.log(yellow(`⚠ Could not delete ${remote}/${branch}, delete it yourself.`));
  }

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).stdout.trim();
  if (current !== base) return;

  console.log(cyan(`› git pull --ff-only ${remote} ${base}`));
  const pulled = quietly(['pull', '--ff-only', remote, base]);
  if (pulled.status === 0) return;
  if (pulled.stderr) process.stderr.write(pulled.stderr);
  console.log(yellow(`⚠ Could not update local ${base}, run: git pull ${remote} ${base}`));
}

// ---------- git-multi-commit ----------
// Projects set up with git-multi-commit keep this file in the repo root
// (the same place git-multi-commit looks for it). For those, acp runs
// git-multi-commit instead of git push.
const MULTI_COMMIT_CONFIG = '.git-multi-commit.json';

const MULTI_COMMIT_NOT_INSTALLED = 'git-multi-commit is not installed. Install it with: npm install -g git-multi-commit';
const isWindows = process.platform === 'win32';

function multiCommitConfigPath() {
  const root = git(['rev-parse', '--show-toplevel'], { quiet: true }).stdout.trim();
  return path.join(root, MULTI_COMMIT_CONFIG);
}

function usesMultiCommit() {
  return fs.existsSync(multiCommitConfigPath());
}

// cmd.exe's "not found" exit code isn't reliable, so look it up first.
function requireMultiCommit() {
  if (isWindows && run('where', ['git-multi-commit'], { quiet: true }).status !== 0) fail(MULTI_COMMIT_NOT_INSTALLED);
}

// npm installs global CLIs as .cmd shims on Windows, which only start
// through a shell. No arguments are passed, so no user input reaches it.
function runMultiCommit() {
  console.log(cyan('› git-multi-commit'));
  return run('git-multi-commit', [], { shell: isWindows });
}

// What went wrong with a git-multi-commit run, or null if nothing did.
function multiCommitProblem(result) {
  if (result.error) return result.error.code === 'ENOENT' ? MULTI_COMMIT_NOT_INSTALLED : result.error.message;
  return result.status === 0 ? null : `"git-multi-commit" failed (exit code ${result.status}).`;
}

function multiCommit() {
  requireMultiCommit();
  const problem = multiCommitProblem(runMultiCommit());
  if (problem) fail(problem);
}

// ---------- -bpa with git-multi-commit ----------
// Each pair is its own repo with its own history, so every one gets its own
// branch, pull request and merge. Checks everything before anything is committed.
function pairTargets(requested) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(multiCommitConfigPath(), 'utf8'));
  } catch (error) {
    fail(`Could not read ${MULTI_COMMIT_CONFIG}: ${error.message}`);
  }
  const pairs = (config && config.pairs) || [];
  if (!pairs.length) fail(`${MULTI_COMMIT_CONFIG} has no pairs. Set them up with: git-multi-commit --config`);

  const gh = ghAccounts();
  if (!gh) fail('-bpa needs the GitHub CLI (gh), logged in. Install it from https://cli.github.com');

  let branch = requested;
  const targets = pairs.map((pair) => {
    const repo = githubRepo(pair.repoUrl || '');
    if (!repo) fail(`Pull requests need every pair to be a GitHub repo, "${pair.repoUrl}" is not.`);

    const account = String(pair.account).toLowerCase();
    const login = gh.accounts.find((a) => a.toLowerCase() === account);
    const token = login && ghToken(login, login === gh.active);
    if (!token) fail(`GitHub account "${pair.account}" is not logged in. Log in with: gh auth login`);

    const target = {
      repo: `${repo.owner}/${repo.name}`,
      baseOwner: repo.owner,
      headOwner: repo.owner,
      direct: true,
      opener: login,
      env: { GH_TOKEN: token },
    };
    branch = directBranch(target, branch, true);
    if (!canPush(target.repo, target.env)) fail(`GitHub account "${login}" can't push to ${target.repo}.`);

    const tip = run('gh', ['api', `repos/${target.repo}/git/ref/heads/${target.base}`, '--jq', '.object.sha'], {
      quiet: true,
      env: target.env,
    });
    if (tip.status !== 0) fail(`Could not read ${target.base} of ${target.repo}. A pull request needs a repo with commits.`);
    target.baseSha = tip.stdout.trim();
    return target;
  });
  return { targets, branch };
}

// Creates <branch> from the default branch. Returns false when it failed.
// A branch that already exists is used as it is, and is not ours to delete.
function createPairBranch(target, branch) {
  const created = run(
    'gh',
    ['api', '-X', 'POST', `repos/${target.repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${target.baseSha}`],
    { quiet: true, env: target.env }
  );
  target.createdBranch = created.status === 0;
  if (created.status === 0 || /already exists/i.test(created.stderr || '')) return true;
  if (created.stderr) process.stderr.write(created.stderr);
  return false;
}

function deletePairBranch(target, branch) {
  console.log(cyan(`› gh api -X DELETE repos/${target.repo}/git/refs/heads/${branch}`));
  const deleted = run('gh', ['api', '-X', 'DELETE', `repos/${target.repo}/git/refs/heads/${branch}`], {
    quiet: true,
    env: target.env,
  });
  if (deleted.status === 0) {
    console.log(green(`✔ Deleted ${target.repo}:${branch}`));
  } else if (/reference does not exist/i.test(deleted.stderr || '')) {
    console.log(dim(`• ${target.repo}:${branch} was already deleted.`));
  } else {
    if (deleted.stderr) process.stderr.write(deleted.stderr);
    console.log(yellow(`⚠ Could not delete ${target.repo}:${branch}, delete it yourself.`));
  }
}

// How many commits <branch> is ahead of the default branch, or null if unknown.
function commitsAhead(target, branch) {
  const compared = run('gh', ['api', `repos/${target.repo}/compare/${target.base}...${branch}`, '--jq', '.ahead_by'], {
    quiet: true,
    env: target.env,
  });
  return compared.status === 0 ? Number(compared.stdout.trim()) : null;
}

// git-multi-commit has no branch option and only reads the branch from its
// config, so the config points at <branch> just for this one run. The branch
// has to exist first: on a missing branch git-multi-commit starts from nothing,
// and a pull request can't be opened between unrelated histories.
function runMultiCommitOnBranch(branch) {
  const file = multiCommitConfigPath();
  const original = fs.readFileSync(file, 'utf8');
  const config = JSON.parse(original);
  config.branch = branch;
  config.pairs.forEach((pair) => {
    pair.branch = branch;
  });

  // Ctrl+C must stop git-multi-commit but not acp, or the config stays changed.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  try {
    return runMultiCommit();
  } finally {
    fs.writeFileSync(file, original);
    process.removeListener('SIGINT', ignore);
  }
}

function branchPrAutoPairs(targets, branch) {
  for (const target of targets) {
    if (createPairBranch(target, branch)) continue;
    targets.filter((t) => t.createdBranch).forEach((t) => deletePairBranch(t, branch));
    fail(`Could not create branch "${branch}" on ${target.repo}.`);
  }

  const result = runMultiCommitOnBranch(branch);

  // 0xC000013A is how Windows reports a process stopped with Ctrl+C.
  if (result.signal === 'SIGINT' || result.status === 130 || result.status === 0xc000013a) {
    fail(`Interrupted, nothing was merged. Branch "${branch}" may be left on the repos.`);
  }

  // A pair with nothing new, or one that failed, has an empty branch. A failed
  // pair doesn't stop the others, so the ones that were pushed still go through.
  for (const target of targets) {
    console.log(cyan(`• ${target.repo}`));
    const ahead = commitsAhead(target, branch);
    if (ahead === null) {
      console.log(yellow(`⚠ Could not compare "${branch}" with ${target.base}, leaving it for you to check.`));
    } else if (ahead === 0) {
      console.log(dim('• No new commits, skipping the pull request.'));
      if (target.createdBranch) deletePairBranch(target, branch);
    } else if (pullRequest(target, branch, true)) {
      deletePairBranch(target, branch);
    }
  }

  const problem = multiCommitProblem(result);
  if (problem) fail(problem);
}

// ---------- main ----------
function main() {
  const { branch: requestedBranch, branchGiven, message, pr, merge, chunks, bpa } = parseArgs(process.argv.slice(2));
  let branch = requestedBranch;
  let remote = 'origin';

  if (git(['rev-parse', '--is-inside-work-tree'], { quiet: true }).status !== 0) {
    fail('Not inside a git repository.');
  }

  const remoteUrlOf = (name) => git(['remote', 'get-url', name], { quiet: true });
  const multi = usesMultiCommit();
  let remoteUrl;
  let target;
  let pairs;
  if (multi) {
    console.log(cyan(`• Found ${MULTI_COMMIT_CONFIG}, pushing with git-multi-commit instead of git push.`));
    if (bpa) {
      requireMultiCommit();
      ({ targets: pairs, branch } = pairTargets(branchGiven ? requestedBranch : null));
      console.log(cyan(`• Using branch "${branch}" on ${pairs.length} repo(s)`));
    } else if (pr) {
      // git-multi-commit pushes to its own repos, so -u/-ua only apply when
      // "upstream" exists. Without "origin" the branch goes straight to it.
      const hasOrigin = remoteUrlOf('origin');
      const hasUpstream = remoteUrlOf('upstream');
      if (hasUpstream.status === 0) {
        if (hasOrigin.status !== 0) remote = 'upstream';
        remoteUrl = hasOrigin.status === 0 ? hasOrigin : hasUpstream;
        target = pullRequestTarget(hasOrigin.status === 0 ? remoteUrl.stdout.trim() : null);
        console.log(cyan(`• Found remote "upstream", will also push to ${remote} and open a pull request.`));
      } else {
        console.log(yellow('⚠ Remote "upstream" does not exist, skipping -u/-ua (git-multi-commit only).'));
      }
    }
    if (!target && !bpa && branch !== 'main') console.log(yellow('⚠ -b is ignored for git-multi-commit.'));
  } else {
    remoteUrl = remoteUrlOf('origin');
    if (remoteUrl.status !== 0) {
      const upstream = pr && !bpa ? remoteUrlOf('upstream') : null;
      if (!upstream || upstream.status !== 0) {
        fail(`Remote "${remote}" does not exist. Add it with: git remote add ${remote} <url>`);
      }
      console.log(cyan('• No "origin" remote, pushing a branch straight to "upstream".'));
      remote = 'upstream';
      remoteUrl = upstream;
      target = pullRequestTarget(null);
    } else if (bpa) {
      // One repo: the branch and the pull request both live on origin.
      target = pullRequestTarget(null, 'origin');
    } else if (pr) {
      target = pullRequestTarget(remoteUrl.stdout.trim());
    }
  }

  if (target && target.direct) {
    branch = directBranch(target, branchGiven ? requestedBranch : null, bpa);
    if (bpa) console.log(cyan(`• Using branch "${branch}"`));
  }

  if (multi && chunks) console.log(yellow('⚠ -c is ignored for git-multi-commit.'));

  const auth = remoteUrl ? githubAuth(remoteUrl.stdout.trim(), target && target.direct ? target.repo : null) || {} : null;
  // Without a fork, the account that pushed the branch also opens the pull request.
  if (target && target.direct && auth && auth.env) target.opener = auth.env.ACP_GH_USER;

  // "HEAD:<branch>" pushes whatever branch you're on (main, master, anything)
  // to <branch> on the remote, so the default always lands on "main".
  const push = () => {
    step(['push', remote, `HEAD:${branch}`], auth);
    console.log(green(`✔ Pushed to ${remote}/${branch}`));
  };

  const openPullRequest = () => {
    const merged = pullRequest(target, branch, merge);
    if (bpa && merged) cleanUp(remote, branch, target.base, auth);
  };

  // With -c and -u/-ua, every chunk is pushed and gets its own pull request
  // (merged right away with -ua), instead of one push at the end.
  let pushedPerChunk = false;

  if (chunks && !multi) {
    const afterCommit = pr
      ? (n, count) => {
          console.log(cyan(`• Chunk ${n}/${count}`));
          push();
          openPullRequest();
        }
      : undefined;
    const done = commitInChunks(message, afterCommit);
    pushedPerChunk = done && pr;
    if (!done) console.log(yellow('• Nothing new to commit, pushing existing commits.'));
  } else {
    step(['add', '.']);

    // "git diff --cached --quiet" exits 0 when nothing is staged.
    if (git(['diff', '--cached', '--quiet'], { quiet: true }).status === 0) {
      console.log(yellow('• Nothing new to commit, pushing existing commits.'));
    } else {
      step(['commit', '-m', message || randomMessage()]);
    }
  }

  if (pairs) {
    branchPrAutoPairs(pairs, branch);
    return;
  }

  if (multi) {
    multiCommit();
    console.log(green('✔ Pushed with git-multi-commit'));
    if (target) {
      push();
      openPullRequest();
    }
    return;
  }

  if (pushedPerChunk) return;

  push();
  if (pr) openPullRequest();
}

main();
