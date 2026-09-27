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
| `-u`, `--upstream` | Push to the `upstream` remote instead of `origin` |
| `-b`, `--branch <name>` | Push to `<name>` instead of `main` |
| `-m`, `--message <text>` | Use your own commit message instead of a random one |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

## Examples

```bash
acp                      # git push origin main
acp -u                   # git push upstream main
acp -b dev               # git push origin dev
acp --branch=dev         # same as above
acp -u -b staging        # git push upstream staging
acp -m "Fix login bug"   # custom message
```

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

## Notes

- If there is nothing new to commit, `acp` skips the commit and still pushes, so any commits you made earlier get sent.
- `-b <name>` pushes your current local branch to `<name>` on the remote, creating it there if it doesn't exist yet.
- `-u` needs a remote called `upstream`. Add one with `git remote add upstream <url>`.

## Custom messages

Edit the list in `lib/messages.js`.

## License

MIT
