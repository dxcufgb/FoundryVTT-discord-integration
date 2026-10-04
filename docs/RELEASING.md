# Releasing

Releases are built by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) when a **version tag** (`vX.Y.Z`) is pushed, which also happens when a GitHub Release is published with a new tag. The workflow runs the tests, stamps the version from the tag into `package.json`, installs production dependencies, creates the GitHub Release if it does not exist yet (notes taken from the matching `CHANGELOG.md` section) and attaches:

- `foundryvtt-discord-integration-<version>-linux.tar.gz` — bot + dependencies + `deploy/linux` (interactive installer, systemd unit)
- `install.sh` — the Linux installer on its own, for `curl -fsSL …/releases/latest/download/install.sh | sudo bash` (it downloads the bundle)
- `foundryvtt-discord-integration-<version>-windows.zip` — bot + dependencies + `deploy/windows` (Task Scheduler scripts)
- `foundryvtt-discord-integration-<version>-setup.exe` — Windows installer built with Inno Setup from `deploy/windows/installer.iss` (a second job on a Windows runner)
- `SHA256SUMS.txt` and `SHA256SUMS-setup.txt`

The bundles contain no native code, so one build serves both platforms. The Node.js version the Windows installer downloads when none is present is the `NodeVersion` define at the top of `installer.iss`; bump it now and then to the current LTS.

## Procedure

1. Make sure `main` is green (the **CI** workflow runs the tests on Linux and Windows, Node 20 and 22).
2. Add a section for the new version to [`CHANGELOG.md`](../CHANGELOG.md) and merge it via a pull request (`main` is protected: one approving review, no force pushes).
3. Tag `main` and push the tag (semantic versioning: patch for fixes, minor for new commands/features, major for breaking changes such as changed `.env` variables or state format):

   ```
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   Within a couple of minutes the *Release bot* workflow creates the release `vX.Y.Z` with the changelog section as notes and attaches the bundles. Check the Actions tab if they are missing.

   Or, without a local checkout: **Actions → Release bot → Run workflow**, branch `main`, enter the tag `vX.Y.Z`. The workflow creates the tag and the release.

   Alternatively create the release on GitHub (**Releases → Draft a new release**, tag `vX.Y.Z` from `main`, title `vX.Y.Z`, your notes, **Publish**) or with the [GitHub CLI](https://cli.github.com) (`gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes.md>`); the tag that GitHub creates triggers the same workflow, which then keeps your notes and only attaches the bundles.

## Versioning notes

- `package.json` in the repository stays at the current release version and is updated by the workflow for the bundle, so a tag is the single source of truth for a release's version.
- Bumping `package.json` in the repository to match after a release is nice but not required.
- Pre-releases: tick *Set as a pre-release* on GitHub; the workflow builds them the same way, and the `/releases/latest` link keeps pointing at the last full release.

## Repository setup

This repository follows the same rules as the other `FoundryVTT-…` repositories:

- Public, MIT licence, issues/projects/wiki enabled.
- Pull requests are **squash merged** and the branch is deleted on merge.
- Ruleset **Protect main** on the default branch ([`.github/ruleset-protect-main.json`](../.github/ruleset-protect-main.json)): no deletion, no force pushes, changes via pull request with one approving review, stale reviews dismissed on push, repository admins may bypass for pull requests.

[`scripts/setup-repo.sh`](../scripts/setup-repo.sh) applies all of that with the GitHub CLI (it is what was used to create the repository and the `v1.0.0` release) and can be re-run safely to re-apply the settings.
