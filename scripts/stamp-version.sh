#!/bin/sh
# Writes the build's version into a page: the footer text and the ?v= on its CSS/JS links, so each build
# is fetched fresh instead of from a browser's cache. Run by the Docker and Pages workflows before
# publishing. The committed index.html keeps "dev", so opening it from disk still works.
#
# Usage: sh scripts/stamp-version.sh page.html [page.html ...]
# Version: from git tags, e.g. 0.1.2 on a tagged commit, 0.1.2-3-gabc1234 three commits later.
set -eu
[ $# -gt 0 ] || { echo "usage: stamp-version.sh <page.html> [page.html ...]" >&2; exit 1; }
version=$(git describe --tags --always 2>/dev/null | sed 's/^v//') || version=""
[ -n "$version" ] || version=dev
for file in "$@"; do
  sed -i "s/?v=dev\"/?v=${version}\"/g; s/id=\"app-version\" class=\"mono\">dev</id=\"app-version\" class=\"mono\">${version}</" "$file"
  grep -q "id=\"app-version\" class=\"mono\">${version}<" "$file" || { echo "stamp-version: footer not stamped in $file" >&2; exit 1; }
  echo "Stamped $file with version $version"
done
