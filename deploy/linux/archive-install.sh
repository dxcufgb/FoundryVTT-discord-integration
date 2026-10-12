#!/usr/bin/env bash
# install.sh at the top of the Linux release archive (foundryvtt-discord-integration-X.Y.Z/install.sh).
# scripts/build-release.sh puts this file there; it runs the real installer next to it:
#   tar xzf foundryvtt-discord-integration-linux.tar.gz && cd foundryvtt-discord-integration-X.Y.Z && sudo ./install.sh [options]
# is the same as sudo ./deploy/linux/install.sh [options]. See ./install.sh --help.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$here/deploy/linux/install.sh" ]] || { echo "install.sh: $here/deploy/linux/install.sh is missing; extract the whole archive." >&2; exit 1; }
exec bash "$here/deploy/linux/install.sh" "$@"
