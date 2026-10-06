# acp-push

Stage, commit and push in one command.

```bash
acp
```

runs:

```bash
git add .
git commit -m "<one of 25 random messages>"
git push origin HEAD:main
```

`HEAD:main` means your current local branch (whether it's called `main`, `master` or anything else) is pushed to `main` on the remote.

## Install

```bash
npm install -g acp-push
```

## Options

| Flag | Description |
| --- | --- |
| `-u`, `--upstream` | Push to `origin`, then open a pull request to `upstream` |
| `-ua`, `--upstream-merge` | Same as `-u`, then merge the pull request if you have write access to `upstream` |
| `-b`, `--branch <name>` | Push to `<name>` instead of `main` |
| `-m`, `--message <text>` | Use your own commit message instead of a random one |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

## Examples

```bash
acp                      # git push origin main
acp -u                   # git push origin main, then open a PR to upstream
acp -ua                  # same, then merge the PR if you have write access
acp -b dev               # git push origin dev
acp --branch=dev         # same as above
acp -u -b fix            # git push origin fix, then open a PR to upstream
acp -m "Fix login bug"   # custom message
```

## Pull requests to upstream

If `origin` is your fork and `upstream` is the original repo, `acp -u` pushes to your fork and opens a pull request:

```bash
git add .
git commit -m "<one of 25 random messages>"
git push origin HEAD:main
gh pr create --repo <upstream owner>/<repo> --head <your account>:main
```

`acp -ua` does the same and then merges it with `gh pr merge --merge`, but only if your account has write access to `upstream` (the write, maintain or admin role). Without it, the pull request is left open for a maintainer and `acp` still finishes successfully.

- You need the [GitHub CLI](https://cli.github.com) (`gh`) and a remote called `upstream`. Add one with `git remote add upstream <url>`. Both remotes must be GitHub repos.
- The pull request goes into the default branch of `upstream`. Its title is your last commit message.
- If a pull request from that branch is already open, the push updates it and `acp` doesn't open a second one. `-ua` merges the open one.
- For the merge, `acp` checks two `gh` accounts for write access: the one named like the owner of `upstream` (if you're logged in to it), then the one that opened the pull request. It merges with the first that has it.
- If the merge fails, the pull request stays open and `acp` prints its link.

## Multiple GitHub accounts

If you have the [GitHub CLI](https://cli.github.com) (`gh`) installed, `acp` picks the right account for each repo automatically:

| Remote | Account used |
| --- | --- |
| `https://github.com/SENODROOM/acp-push` | `SENODROOM` |
| `https://github.com/Gobibahu/some-repo` | `GobiBahu` (names are case-insensitive) |
| `https://github.com/some-org/project` (no matching account) | the account you used last |

Log in to each account once:

```bash
gh auth login   # log in as the first account
gh auth login   # run again for the second account
```

`acp` switches gh's active account to whichever one it used, so "last used" is always the most recent one. The token is only used for that one push and doesn't replace your saved git login. SSH remotes and non-GitHub remotes use your normal git login.

## git-multi-commit projects

If your repo root contains a `.git-multi-commit.json` file (created by [`git-multi-commit --config`](https://www.npmjs.com/package/git-multi-commit)), `acp` still runs `git add .` and `git commit` locally, but then runs `git-multi-commit` instead of `git push`:

```bash
git add .
git commit -m "<one of 25 random messages>"
git-multi-commit
```

No `origin` remote is needed in this case, and `-u` / `-ua` / `-b` are ignored. Install it with `npm install -g git-multi-commit`.

## Notes

- If there is nothing new to commit, `acp` skips the commit and still pushes, so any commits you made earlier get sent.
- `-b <name>` pushes your current local branch to `<name>` on the remote, creating it there if it doesn't exist yet.

## Custom messages

Edit the list in `lib/messages.js`.

## License

MIT
