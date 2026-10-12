#!/usr/bin/env bash
# Builds the release files of the Foundry VTT Discord integration. Used by .github/workflows/release.yml;
# runs locally too (bash, node/npm, tar, gzip, zip, sha256sum).
#
#   scripts/build-release.sh build    <out dir> <version>   the Linux and Windows archives, plus the Windows
#                                                           payload for Inno Setup in <out dir>/payload/windows/
#   scripts/build-release.sh finalize <out dir> <version>   after <slug>-<version>-setup.exe was put into <out dir>:
#                                                           fixed-name copies, install.sh, legacy files, SHA256SUMS.txt
#
# The version (1.2.3, a leading v is stripped) is stamped into the built package.json / package-lock.json only;
# the repository's own package.json is never changed. The archives are reproducible: the same commit and version
# give byte-identical .tar.gz and .zip files (timestamps come from the commit, SOURCE_DATE_EPOCH overrides it).
#
# Release files for version X.Y.Z (slug foundryvtt-discord-integration):
#   <slug>-X.Y.Z-linux.tar.gz    one top folder <slug>-X.Y.Z/ with install.sh at its top
#   <slug>-X.Y.Z-windows.zip     one top folder <slug>-X.Y.Z/ with deploy\windows\
#   <slug>-X.Y.Z-setup.exe       the Windows setup wizard (built by Inno Setup on a Windows runner)
#   <slug>-linux.tar.gz, <slug>-windows.zip, <slug>-setup.exe   the same files under fixed names
#                                (https://github.com/<repo>/releases/latest/download/<name> never changes)
#   install.sh                   the Linux installer alone, for curl -fsSL …/releases/latest/download/install.sh | sudo bash
#   SHA256SUMS.txt               sha256sum lines for every other file of the release (legacy files included)
#   legacy files                 see LEGACY_ASSETS below
set -euo pipefail

SLUG="foundryvtt-discord-integration"
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# What every bundle contains, besides its platform's deploy/ folder.
COMMON=(src scripts docs package.json package-lock.json README.md LICENSE CHANGELOG.md .env.example)

die() { printf 'build-release: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}"; }

# ---- LEGACY_ASSETS -------------------------------------------------------------------------------------------------
# Files under the names that installations up to v1.3.2 look for. Their updaters fetch
#   <slug>-X.Y.Z-linux.tar.gz / -windows.zip  verified with SHA256SUMS.txt   (same names as now: nothing extra)
#   <slug>-X.Y.Z-setup.exe                    verified with SHA256SUMS-setup.txt
# so the only legacy file is SHA256SUMS-setup.txt: one sha256sum line for the versioned setup.exe.
# This block (and the file) can be removed once every installation runs a version whose updater uses
# SHA256SUMS.txt for the setup.exe (any release after v1.3.2).
legacy_assets() { # legacy_assets <out dir> <version>
  local setup="$SLUG-$2-setup.exe"
  (cd "$1" && sha256sum "$setup") > "$1/SHA256SUMS-setup.txt"
}
LEGACY_ASSETS=(SHA256SUMS-setup.txt)
# ---- end of LEGACY_ASSETS ------------------------------------------------------------------------------------------

stamp_version() { # stamp_version <version> <package.json> <package-lock.json>
  node -e '
    const fs = require("node:fs");
    const [version, ...files] = process.argv.slice(1);
    for (const f of files) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      j.version = version;
      if (j.packages && j.packages[""]) j.packages[""].version = version;
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    }' "$@"
}

# Deterministic archives: sorted names, fixed timestamps, owner and modes.
make_tar() { # make_tar <archive> <parent dir> <top folder>
  tar --sort=name --format=gnu --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' -C "$2" -cf - "$3" | gzip -9n > "$1"
}
make_zip() { # make_zip <archive> <parent dir> <top folder>
  local archive
  archive="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  rm -f "$archive"
  find "$2/$3" -exec touch -h -d "@$EPOCH" {} +
  (cd "$2" && find "$3" -print | LC_ALL=C sort | TZ=UTC zip -qX -9 -@ "$archive")
}

build() { # build <out dir> <version>
  local out="$1" version="$2" name="$SLUG-$2"
  command -v npm >/dev/null || die "npm is needed."
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  local stage="$out/stage"
  rm -rf "$stage" "$out/payload" "$out/$name-linux.tar.gz" "$out/$name-windows.zip"
  mkdir -p "$stage/common" "$stage/linux/$name" "$out/payload/windows/$name"

  # The common part: sources with the stamped version and the production dependencies (no dev tools,
  # no install scripts), installed from the lockfile.
  (cd "$ROOT" && cp -R "${COMMON[@]}" "$stage/common/")
  stamp_version "$version" "$stage/common/package.json" "$stage/common/package-lock.json"
  (cd "$stage/common" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >&2)
  [[ -d "$stage/common/node_modules/discord.js" ]] || die "node_modules is incomplete."
  # Dependency folders can carry files npm wrote with odd modes; the installers make everything root-owned anyway.
  chmod -R u+rwX,go+rX,go-w "$stage/common"

  # Linux: install.sh at the top of the archive (it runs deploy/linux/install.sh).
  cp -R "$stage/common/." "$stage/linux/$name/"
  mkdir -p "$stage/linux/$name/deploy/linux"
  (cd "$ROOT/deploy/linux" && find . -maxdepth 1 -type f ! -name archive-install.sh -exec cp {} "$stage/linux/$name/deploy/linux/" \;)
  install -m 755 "$ROOT/deploy/linux/archive-install.sh" "$stage/linux/$name/install.sh"
  chmod 755 "$stage/linux/$name/deploy/linux/"*.sh
  make_tar "$out/$name-linux.tar.gz" "$stage/linux" "$name"

  # Windows: the zip and the payload the setup.exe is compiled from (same files).
  cp -R "$stage/common/." "$out/payload/windows/$name/"
  mkdir -p "$out/payload/windows/$name/deploy"
  cp -R "$ROOT/deploy/windows" "$out/payload/windows/$name/deploy/"
  chmod -R u+rwX,go+rX,go-w "$out/payload/windows/$name"
  make_zip "$out/$name-windows.zip" "$out/payload/windows" "$name"

  rm -rf "$stage"
  ls -l "$out/$name-linux.tar.gz" "$out/$name-windows.zip" >&2
}

finalize() { # finalize <out dir> <version>
  local out="$1" version="$2" name="$SLUG-$2" f
  for f in "$name-linux.tar.gz" "$name-windows.zip" "$name-setup.exe"; do
    [[ -s "$out/$f" ]] || die "$out/$f is missing (run 'build' first; the setup.exe comes from Inno Setup)."
  done
  cp -f "$out/$name-linux.tar.gz" "$out/$SLUG-linux.tar.gz"
  cp -f "$out/$name-windows.zip" "$out/$SLUG-windows.zip"
  cp -f "$out/$name-setup.exe" "$out/$SLUG-setup.exe"
  install -m 755 "$ROOT/deploy/linux/install.sh" "$out/install.sh"
  legacy_assets "$out" "$version"

  local files=("$name-linux.tar.gz" "$name-windows.zip" "$name-setup.exe"
    "$SLUG-linux.tar.gz" "$SLUG-windows.zip" "$SLUG-setup.exe" install.sh "${LEGACY_ASSETS[@]}")
  (cd "$out" && sha256sum "${files[@]}") > "$out/SHA256SUMS.txt"
  # The list of files to publish, one per line (the workflow attaches exactly these).
  printf '%s\n' "${files[@]}" SHA256SUMS.txt > "$out/release-files.txt"
  (cd "$out" && sha256sum -c --quiet SHA256SUMS.txt) || die "SHA256SUMS.txt does not verify."
  (cd "$out" && ls -l "${files[@]}" SHA256SUMS.txt) >&2
}

[[ $# -ge 1 && ( $1 == -h || $1 == --help ) ]] && { usage; exit 0; }
[[ $# -eq 3 ]] || { usage >&2; exit 2; }
MODE="$1" OUT="$2" VERSION="${3#v}"
[[ $VERSION =~ $SEMVER_RE ]] || die "'$3' is not a version like 1.2.3 or 1.2.3-rc.1."
EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)}"
[[ $EPOCH =~ ^[0-9]+$ ]] || die "SOURCE_DATE_EPOCH must be a number of seconds."
case "$MODE" in
  build) build "$OUT" "$VERSION" ;;
  finalize) [[ -d $OUT ]] || die "$OUT does not exist."; finalize "$(cd "$OUT" && pwd)" "$VERSION" ;;
  *) usage >&2; exit 2 ;;
esac
