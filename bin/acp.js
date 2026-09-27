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

Examples:
  acp                      ${dim('# git push origin main')}
  acp -u                   ${dim('# git push upstream main')}
  acp -b dev               ${dim('# git push origin dev')}
  acp -u --branch staging  ${dim('# git push upstream staging')}
  acp -m "Fix login bug"   ${dim('# custom message, git push origin main')}
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

// ---------- git helpers ----------
// Arguments are passed as an array (no shell), so commit messages with
// quotes, spaces or special characters are always safe.
function git(args, quiet = false) {
  const result = spawnSync('git', args, {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') fail('git is not installed or not on your PATH.');
    fail(result.error.message);
  }
  return result;
}

function step(args) {
  const shown = args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  console.log(cyan(`› git ${shown}`));
  const result = git(args);
  if (result.status !== 0) fail(`"git ${args[0]}" failed (exit code ${result.status}).`);
}

function randomMessage() {
  return messages[Math.floor(Math.random() * messages.length)];
}

// ---------- main ----------
function main() {
  const { remote, branch, message } = parseArgs(process.argv.slice(2));

  if (git(['rev-parse', '--is-inside-work-tree'], true).status !== 0) {
    fail('Not inside a git repository.');
  }

  if (git(['remote', 'get-url', remote], true).status !== 0) {
    fail(`Remote "${remote}" does not exist. Add it with: git remote add ${remote} <url>`);
  }

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], true).stdout.trim();
  if (current && current !== 'HEAD' && current !== branch) {
    console.log(
      yellow(`⚠ You are on "${current}" but pushing "${branch}". ` +
        `Your new commit stays on "${current}" — use "acp -b ${current}" to push it.`)
    );
  }

  step(['add', '.']);

  // "git diff --cached --quiet" exits 0 when nothing is staged.
  if (git(['diff', '--cached', '--quiet'], true).status === 0) {
    console.log(yellow('• Nothing new to commit, pushing existing commits.'));
  } else {
    step(['commit', '-m', message || randomMessage()]);
  }

  step(['push', remote, branch]);
  console.log(green(`✔ Pushed to ${remote}/${branch}`));
}

main();
