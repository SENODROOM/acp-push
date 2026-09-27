# acp-push

Stage, commit and push in one command.

```bash
acp
```

runs:

```bash
git add .
git commit -m "<one of 25 random messages>"
git push origin main
```

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

## Notes

- If there is nothing new to commit, `acp` skips the commit and still pushes, so any commits you made earlier get sent.
- If you're on a different branch than the one you're pushing, `acp` warns you, since your new commit lives on your current branch.
- `-u` needs a remote called `upstream`. Add one with `git remote add upstream <url>`.

## Custom messages

Edit the list in `lib/messages.js`.

## License

MIT
