# Releasing

**Actions → Release → Run workflow → type the version** (e.g. `1.2.3`; a leading `v` is stripped, `1.2.3-rc.1` makes a pre-release). Fallback: publish a release `vX.Y.Z` on GitHub, the files are attached afterwards. No version bump in the code: the version comes from the tag.

## Procedure

1. Make sure `main` is green (the **CI** workflow runs the tests on Linux and Windows, Node 20 and 22, and the real Linux and Windows installers).
2. Optional but recommended: rename `## [Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md) to `## [X.Y.Z] - <date>` (and start a new empty `## [Unreleased]`) in a pull request (`main` is protected: one approving review, no force pushes). That section becomes the release notes; without one, GitHub's generated notes (the merged pull requests) are used.
3. **Actions → Release → Run workflow**, branch `main`, type the version `X.Y.Z` (semantic versioning: patch for fixes, minor for new commands/features, major for breaking changes such as changed `.env` variables or state format).

The [Release workflow](../.github/workflows/release.yml) then

1. checks the version (`X.Y.Z` or `X.Y.Z-pre.N`), that it runs on `main`, and that neither the tag `vX.Y.Z` nor a release (draft included) of that name exists;
2. runs the full CI (the same `ci.yml`: tests, the Linux installer against a real systemd, the Windows setup.exe installed, auto-updated and uninstalled);
3. builds every file with the version stamped from the tag ([`scripts/build-release.sh`](../scripts/build-release.sh); the setup.exe with Inno Setup on a Windows runner);
4. creates a **draft** release `vX.Y.Z` on the workflow's commit with all files attached and the notes, and only then publishes it (as a pre-release when the version has a `-` part, otherwise as the latest release). If any job fails, nothing is published and no tag is created.

**Fallback, by hand:** create the release on GitHub (**Releases → Draft a new release**, new tag `vX.Y.Z` on `main`, title `vX.Y.Z`, your notes, **Publish**). Publishing triggers the same workflow, which builds everything from the tag and attaches the files to that release afterwards (its notes are kept). Until the files are attached (a few minutes) an installation's automatic update finds no files on the release and simply tries again the next day.

## Release files

For version `X.Y.Z`:

| File | What |
| --- | --- |
| `foundryvtt-discord-integration-X.Y.Z-linux.tar.gz` | Linux archive: one top folder `foundryvtt-discord-integration-X.Y.Z/` with `install.sh` at its top (bot, production dependencies, `deploy/linux`) |
| `foundryvtt-discord-integration-X.Y.Z-windows.zip` | Windows archive (bot, production dependencies, `deploy/windows` with the Task Scheduler scripts) |
| `foundryvtt-discord-integration-X.Y.Z-setup.exe` | Windows setup wizard (Inno Setup, [`deploy/windows/installer.iss`](../deploy/windows/installer.iss)) |
| `foundryvtt-discord-integration-linux.tar.gz`, `foundryvtt-discord-integration-windows.zip`, `foundryvtt-discord-integration-setup.exe` | the same three under fixed names, so `releases/latest/download/<name>` links never change |
| `install.sh` | the Linux installer alone, for `curl -fsSL https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest/download/install.sh \| sudo bash` (it downloads and verifies the archive) |
| `SHA256SUMS.txt` | `sha256sum` lines (`<hex>  <name>`) for every other file of the release, legacy ones included |
| `SHA256SUMS-setup.txt` | legacy: the setup.exe's checksum in the old file, for installations up to v1.3.2 (see below) |

The same commit and version always give byte-identical `.tar.gz` and `.zip` files. Build them locally with `scripts/build-release.sh build dist X.Y.Z` (and `finalize` once `dist/…-setup.exe` is there).

**Automatic updates** (see [INSTALL.md](INSTALL.md#automatic-updates)) install only full releases with a plain `vX.Y.Z` tag, never pre-releases or drafts. They look for `foundryvtt-discord-integration-X.Y.Z-linux.tar.gz`, `-windows.zip` or `-setup.exe` and refuse a file without a matching line in `SHA256SUMS.txt`. Installations up to v1.3.2 verify the setup.exe with `SHA256SUMS-setup.txt` instead, so that file is still attached (the `LEGACY_ASSETS` block in `scripts/build-release.sh`); it can be dropped once every Windows setup.exe installation runs a newer version. Newer updaters fall back to `SHA256SUMS-setup.txt` only when `SHA256SUMS.txt` has no line for the setup.exe (releases up to v1.3.2).

The bundles contain no native code, so one build serves both platforms. The Node.js version the Windows installer downloads when none is present is the `NodeVersion` define at the top of `installer.iss`; bump it now and then to the current LTS.

## Versioning notes

- The version of a release is its tag. The build stamps it into the bundles' `package.json` and `package-lock.json` (which is what an installation reports, compares for updates and announces); the repository's own `package.json` is not changed and does not need to match.
- Pre-releases (`X.Y.Z-rc.1`) are published as pre-releases; the `/releases/latest` link keeps pointing at the last full release.

## Repository setup

This repository follows the same rules as the other `FoundryVTT-…` repositories:

- Public, MIT licence, issues/projects/wiki enabled.
- Pull requests are **squash merged** and the branch is deleted on merge.
- Ruleset **Protect main** on the default branch ([`.github/ruleset-protect-main.json`](../.github/ruleset-protect-main.json)): no deletion, no force pushes, changes via pull request with one approving review, stale reviews dismissed on push, repository admins may bypass for pull requests.

[`scripts/setup-repo.sh`](../scripts/setup-repo.sh) applies all of that with the GitHub CLI (it is what was used to create the repository and the `v1.0.0` release) and can be re-run safely to re-apply the settings.
