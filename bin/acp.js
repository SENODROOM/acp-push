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
  -ua, --upstream-merge   Same as -u, then merge it if you have write access
  -b, --branch <name>     Push to <name> instead of "main"
  -m, --message <text>    Use your own commit message instead of a random one
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

git-multi-commit:
  If the repo root has a .git-multi-commit.json file, acp still adds and
  commits locally, then runs git-multi-commit instead of git push.
  -u, -ua and -b are ignored in that case.

Examples:
  acp                      ${dim('# push to origin/main')}
  acp -u                   ${dim('# push to origin/main, open a PR to upstream')}
  acp -ua                  ${dim('# same, then merge the PR if you can')}
  acp -b dev               ${dim('# push to origin/dev')}
  acp -u --branch fix      ${dim('# push to origin/fix, open a PR to upstream')}
  acp -m "Fix login bug"   ${dim('# custom message, push to origin/main')}
`;

function fail(message) {
  console.error(red(`✖ ${message}`));
  process.exit(1);
}

// ---------- argument parsing ----------
function parseArgs(argv) {
  const options = { branch: 'main', message: null, pr: false, merge: false };

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
      case '--upstream-merge':
        options.pr = true;
        options.merge = true;
        break;
      case '-b':
      case '--branch':
        options.branch = takeValue();
        break;
      case '-m':
      case '--message':
        options.message = takeValue();
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
function githubAuth(remoteUrl) {
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
  const account = match || gh.active;

  if (match) {
    console.log(cyan(`• Using GitHub account "${account}" (owner of this repo)`));
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
function pullRequestTarget(originUrl) {
  const upstreamUrl = git(['remote', 'get-url', 'upstream'], { quiet: true });
  if (upstreamUrl.status !== 0) {
    fail('Remote "upstream" does not exist. Add it with: git remote add upstream <url>');
  }

  const head = githubRepo(originUrl);
  const base = githubRepo(upstreamUrl.stdout.trim());
  if (!head || !base) fail('Pull requests need "origin" and "upstream" to both be GitHub repos.');

  if (run('gh', ['--version'], { quiet: true }).status !== 0) {
    fail('Pull requests need the GitHub CLI (gh). Install it from https://cli.github.com');
  }

  return { repo: `${base.owner}/${base.name}`, baseOwner: base.owner, headOwner: head.owner };
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

  const opener = accountFor(target.headOwner);
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
  if (!merge) return;

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
    return;
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
}

// ---------- git-multi-commit ----------
// Projects set up with git-multi-commit keep this file in the repo root
// (the same place git-multi-commit looks for it). For those, acp runs
// git-multi-commit instead of git push.
const MULTI_COMMIT_CONFIG = '.git-multi-commit.json';

function usesMultiCommit() {
  const root = git(['rev-parse', '--show-toplevel'], { quiet: true }).stdout.trim();
  return fs.existsSync(path.join(root, MULTI_COMMIT_CONFIG));
}

function multiCommit() {
  const notInstalled = 'git-multi-commit is not installed. Install it with: npm install -g git-multi-commit';
  // npm installs global CLIs as .cmd shims on Windows, which only start
  // through a shell. No arguments are passed, so no user input reaches it.
  // cmd.exe's "not found" exit code isn't reliable, so look it up first.
  const isWindows = process.platform === 'win32';
  if (isWindows && run('where', ['git-multi-commit'], { quiet: true }).status !== 0) fail(notInstalled);

  console.log(cyan('› git-multi-commit'));
  const result = run('git-multi-commit', [], { shell: isWindows });
  if (result.error) fail(result.error.code === 'ENOENT' ? notInstalled : result.error.message);
  if (result.status !== 0) fail(`"git-multi-commit" failed (exit code ${result.status}).`);
}

// ---------- main ----------
function main() {
  const { branch, message, pr, merge } = parseArgs(process.argv.slice(2));
  const remote = 'origin';

  if (git(['rev-parse', '--is-inside-work-tree'], { quiet: true }).status !== 0) {
    fail('Not inside a git repository.');
  }

  const multi = usesMultiCommit();
  let remoteUrl;
  let target;
  if (multi) {
    console.log(cyan(`• Found ${MULTI_COMMIT_CONFIG}, pushing with git-multi-commit instead of git push.`));
    if (pr || branch !== 'main') console.log(yellow('⚠ -u, -ua and -b are ignored for git-multi-commit.'));
  } else {
    remoteUrl = git(['remote', 'get-url', remote], { quiet: true });
    if (remoteUrl.status !== 0) {
      fail(`Remote "${remote}" does not exist. Add it with: git remote add ${remote} <url>`);
    }
    if (pr) target = pullRequestTarget(remoteUrl.stdout.trim());
  }

  step(['add', '.']);

  // "git diff --cached --quiet" exits 0 when nothing is staged.
  if (git(['diff', '--cached', '--quiet'], { quiet: true }).status === 0) {
    console.log(yellow('• Nothing new to commit, pushing existing commits.'));
  } else {
    step(['commit', '-m', message || randomMessage()]);
  }

  if (multi) {
    multiCommit();
    console.log(green('✔ Pushed with git-multi-commit'));
    return;
  }

  const auth = githubAuth(remoteUrl.stdout.trim()) || {};

  // "HEAD:<branch>" pushes whatever branch you're on (main, master, anything)
  // to <branch> on the remote, so the default always lands on "main".
  step(['push', remote, `HEAD:${branch}`], auth);
  console.log(green(`✔ Pushed to ${remote}/${branch}`));

  if (pr) pullRequest(target, branch, merge);
}

main();
