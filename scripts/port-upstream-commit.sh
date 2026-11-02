#!/usr/bin/env bash
# Apply one upstream Paseo commit to JAgentDesk, rebranded, with a 3-way merge.
#   scripts/port-upstream-commit.sh <sha>            apply and commit
#   scripts/port-upstream-commit.sh --finish <sha>   after resolving conflicts and `git am --continue`
# The commit keeps the upstream author and gets a "Ported-from: Paseo <sha>" trailer.
set -euo pipefail
UP="${PASEO_UPSTREAM:-/Users/ngocchanh/Project/private/organisations/hdc/paseo-upstream}"

add_trailer() {
  local sha="$1"
  local msg
  msg="$(git log -1 --format=%B)"
  if ! grep -q "Ported-from: Paseo" <<<"$msg"; then
    git commit --amend --no-verify -q -m "$(printf '%s\n\nPorted-from: Paseo %s' "$msg" "$sha")"
  fi
}

if [[ "${1:-}" == "--finish" ]]; then
  add_trailer "$2"
  exit 0
fi

sha="$1"
# Rebrand. Placeholders keep names that must stay upstream's: the paseo.cafe catalog, the
# getpaseo GitHub org, and the Paseo plugin-API range JAgentDesk implements.
git -C "$UP" format-patch -1 --stdout "$sha" \
  | sed -e 's/paseo\.cafe/__KEEP_CAFE__/g' \
        -e 's#github\.com/getpaseo#__KEEP_GHORG__#g' \
        -e 's/requirements\.paseo/__KEEP_REQ__/g' \
        -e 's/SUPPORTED_PASEO_PLUGIN_API/__KEEP_API__/g' \
        -e 's#@getpaseo/#@jagentdesk/#g' \
        -e 's/PASEO_/JAGENTDESK_/g' -e 's/Paseo/JAgentDesk/g' -e 's/paseo/jagentdesk/g' \
        -e 's/__KEEP_CAFE__/paseo.cafe/g' -e 's#__KEEP_GHORG__#github.com/getpaseo#g' \
        -e 's/__KEEP_REQ__/requirements.paseo/g' -e 's/__KEEP_API__/SUPPORTED_PASEO_PLUGIN_API/g' \
  | git am -3 --keep-non-patch \
      --exclude='docs/*' --exclude='public-docs/*' --exclude='CHANGELOG.md' \
      --exclude='package-lock.json' --exclude='nix/*' --exclude='packages/website/*' \
      --exclude='.github/*' --exclude='fastlane/*'
add_trailer "$sha"
