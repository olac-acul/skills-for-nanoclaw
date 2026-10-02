# skills-for-nanoclaw

> **Unofficial** add-on skills for [NanoClaw](https://github.com/nanocoai/nanoclaw).
> Not affiliated with, endorsed by, or maintained by the upstream project.

A collection of skills that are applied to a clean checkout of upstream
NanoClaw. There is no fork to keep in sync: an installation is upstream plus
the skills it has installed, and it updates with upstream's own
`/update-nanoclaw`.

## Skills

| Skill | Purpose | Status |
| --- | --- | --- |
| `add-manager-backup` | Encrypted backup, export, verified restore with rollback | planned |
| `add-manager-panel` | Local web panel for the main settings (model provider, agents, backups) | planned |

Both are designed to attach to upstream through its existing extension points
(module and `ncl` command barrels, host lifecycle hooks) without editing
upstream source.

## Guide

The full guide is [`docs/guide.md`](docs/guide.md): installing, first run, reaching the panel over the network and HTTPS, models, backups and restores, everything that is terminal-only, troubleshooting and reference. The panel serves the same text at `/guide`.

## Status

Early development. See [`docs/STATUS.md`](docs/STATUS.md) for the current state
and [`docs/spikes.md`](docs/spikes.md) for the technical findings so far.

## Development

```sh
node --test "scripts/*.test.mjs"                        # unit tests of the repo tooling
node scripts/privacy-scan.mjs --all         # privacy gate over tracked files
git config core.hooksPath .githooks         # enable the pre-commit gate
```

The privacy gate blocks private network addresses, personal emails,
credentials and non-anonymous git identities. Use synthetic data in tests
(`100.64.x.x` addresses, `.test` names, `example.*` emails).

## License

MIT
