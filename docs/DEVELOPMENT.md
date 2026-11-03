# Maintainer notes

Maintainer notes, moved out of the README. User documentation is in the wiki.

## Development

```
npm ci
npm test            # unit tests (node:test, no extra tooling)
npm start           # run the bot with the .env in this folder
```

Security scans (`.github/workflows/security.yml`: on pushes to `main`, pull requests and weekly; all three are required checks) can be run locally the same way:

```
gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .
semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript --config p/security-audit --config p/secrets --config p/github-actions --config r/bash
npm audit --omit=dev --audit-level=low
```

A Semgrep false positive gets a `// nosemgrep: <rule-id>` comment (`# nosemgrep: <rule-id>` in shell, YAML and PowerShell) with a reason, on the matched line or the line before it; a gitleaks false positive goes into `.gitleaks.toml`, which must keep `[extend]` `useDefault = true`. GitHub's CodeQL and secret scanning also run on this repository.

Tests cover the configuration loader, the state store, restart-window maths (including DST and windows that cross midnight), update detection and the announce-once guarantee, the up/down state machine, message routing, the administrator check on commands, the LevelDB reader (against databases written by Foundry's own LevelDB binding, see `scripts/make-leveldb-fixtures.js`), world/module usage, the compatibility and update logic (with a fake foundryvtt.com), campaigns and the session reminders (time parsing in a timezone, Discord event links, the 15-minute world check, world-ready pings only near a planned session), session summaries (missing, empty and broken files, which summaries are due, posting once per channel, retries), the administration page (login, lockout, CSRF and host checks, settings, HTTPS) and the self-updater's release check (semantic version order, asset choice, checksum parsing and verification, the token staying on api.github.com, with a fake GitHub). CI runs them on Linux and Windows with Node 20 and 22, runs the Linux installer against a real systemd (including an automatic update to the latest release through the systemd timer's service), and compiles, silently installs, auto-updates and uninstalls the Windows setup.

### Releasing

**Actions → Release → Run workflow → type the version** (e.g. `1.2.3`; `1.2.3-rc.1` makes a pre-release). Fallback: publish a release `vX.Y.Z` on GitHub, the files are attached afterwards. No version bump in the code: the version comes from the tag. Details: **[docs/RELEASING.md](RELEASING.md)**.
