#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
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
  -u, --upstream          Push to the "upstream" remote instead of "origin"
  -b, --branch <name>     Push to <name> instead of "main"
  -m, --message <text>    Use your own commit message instead of a random one
  -h, --help              Show this help
  -v, --version           Show the version

GitHub accounts:
  If the GitHub CLI (gh) is installed, acp picks the gh account that matches
  the repo owner (github.com/<owner>/...). If none matches, it uses the
  account you used last. Log in to each account once with: gh auth login

Examples:
  acp                      ${dim('# push to origin/main')}
  acp -u                   ${dim('# push to upstream/main')}
  acp -b dev               ${dim('# push to origin/dev')}
  acp -u --branch staging  ${dim('# push to upstream/staging')}
  acp -m "Fix login bug"   ${dim('# custom message, push to origin/main')}
`;

function fail(message) {
  console.error(red(`✖ ${message}`));
  process.exit(1);
}

// ---------- argument parsing ----------
function parseArgs(argv) {
  const options = { remote: 'origin', branch: 'main', message: null };

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
        options.remote = 'upstream';
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
// quotes, spaces or special characters are always safe.
function run(cmd, args, { quiet = false, env, stdio } = {}) {
  return spawnSync(cmd, args, {
    stdio: stdio || (quiet ? 'pipe' : 'inherit'),
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
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
function githubOwner(url) {
  const match = url.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\//i);
  return match ? match[1] : null;
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

  const owner = githubOwner(remoteUrl);
  if (!owner) return null; // not a GitHub https remote

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

// ---------- main ----------
function main() {
  const { remote, branch, message } = parseArgs(process.argv.slice(2));

  if (git(['rev-parse', '--is-inside-work-tree'], { quiet: true }).status !== 0) {
    fail('Not inside a git repository.');
  }

  const remoteUrl = git(['remote', 'get-url', remote], { quiet: true });
  if (remoteUrl.status !== 0) {
    fail(`Remote "${remote}" does not exist. Add it with: git remote add ${remote} <url>`);
  }

  step(['add', '.']);

  // "git diff --cached --quiet" exits 0 when nothing is staged.
  if (git(['diff', '--cached', '--quiet'], { quiet: true }).status === 0) {
    console.log(yellow('• Nothing new to commit, pushing existing commits.'));
  } else {
    step(['commit', '-m', message || randomMessage()]);
  }

  const auth = githubAuth(remoteUrl.stdout.trim()) || {};

  // "HEAD:<branch>" pushes whatever branch you're on (main, master, anything)
  // to <branch> on the remote, so the default always lands on "main".
  step(['push', remote, `HEAD:${branch}`], auth);
  console.log(green(`✔ Pushed to ${remote}/${branch}`));
}

main();
