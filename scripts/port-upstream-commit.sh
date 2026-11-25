#!/usr/bin/env bash
# Apply one upstream Paseo commit to JAgentDesk, rebranded, with a real per-file 3-way merge.
#   scripts/port-upstream-commit.sh <sha>            apply and commit (exit 0), or leave conflict markers (exit 1)
#   scripts/port-upstream-commit.sh --finish <sha>   after resolving the conflicts and `git add`-ing the files
# Both the upstream base (<sha>^) and the upstream result (<sha>) are rebranded before merging with the
# JAgentDesk file, so rebranded strings never show up as conflicts. Textual conflicts are retried with
# mergiraf (syntax-aware) when it is installed. The commit keeps the upstream author and message and gets
# a "Ported-from: Paseo <sha>" trailer.
set -euo pipefail
UP="${PASEO_UPSTREAM:-/Users/ngocchanh/Project/private/organisations/hdc/paseo-upstream}"
MERGIRAF="${MERGIRAF:-$HOME/.cargo/bin/mergiraf}"
GITDIR="$(git rev-parse --git-dir)"

rebrand() {
  # Placeholders keep names that must stay upstream's: the paseo.cafe catalog, the getpaseo GitHub org,
  # the Paseo plugin-API range JAgentDesk implements, and the upstream bot account.
  sed -e 's/paseo\.cafe/__KEEP_CAFE__/g' \
      -e 's#github\.com/getpaseo#__KEEP_GHORG__#g' \
      -e 's/requirements\.paseo/__KEEP_REQ__/g' \
      -e 's/SUPPORTED_PASEO_PLUGIN_API/__KEEP_API__/g' \
      -e 's/paseo-bot/__KEEP_BOT__/g' \
      -e 's#@getpaseo/#@jagentdesk/#g' \
      -e 's/PASEO_/JAGENTDESK_/g' -e 's/Paseo/JAgentDesk/g' -e 's/paseo/jagentdesk/g' \
      -e 's/__KEEP_CAFE__/paseo.cafe/g' -e 's#__KEEP_GHORG__#github.com/getpaseo#g' \
      -e 's/__KEEP_REQ__/requirements.paseo/g' -e 's/__KEEP_API__/SUPPORTED_PASEO_PLUGIN_API/g' \
      -e 's/__KEEP_BOT__/paseo-bot/g'
}

excluded() {
  case "$1" in
    docs/*|public-docs/*|CHANGELOG.md|package-lock.json|*/package-lock.json|nix/*|packages/website/*|.github/*|fastlane/*) return 0 ;;
  esac
  return 1
}

commit_ported() {
  local sha="$1"
  local author_name author_email author_date msg
  author_name="$(git -C "$UP" log -1 --format=%an "$sha")"
  author_email="$(git -C "$UP" log -1 --format=%ae "$sha")"
  author_date="$(git -C "$UP" log -1 --format=%aD "$sha")"
  msg="$(git -C "$UP" log -1 --format=%B "$sha" | rebrand)"
  if git diff --cached --quiet; then
    echo "port: $sha changes nothing here (already ported?) — no commit made" >&2
    rm -f "$GITDIR/port-pending"
    return 0
  fi
  GIT_AUTHOR_NAME="$author_name" GIT_AUTHOR_EMAIL="$author_email" GIT_AUTHOR_DATE="$author_date" \
    git commit --no-verify -q -m "$(printf '%s\n\nPorted-from: Paseo %s' "$msg" "$sha")"
  rm -f "$GITDIR/port-pending"
  echo "port: committed $(git log -1 --format='%h %s')"
}

if [[ "${1:-}" == "--finish" ]]; then
  sha="$2"
  if [ -d "$GITDIR/rebase-apply" ]; then
    # legacy git-am flow
    msg="$(git log -1 --format=%B)"
    grep -q "Ported-from: Paseo" <<<"$msg" || git commit --amend --no-verify -q -m "$(printf '%s\n\nPorted-from: Paseo %s' "$msg" "$sha")"
    exit 0
  fi
  if git diff --name-only | xargs -r grep -l '^<<<<<<< ' 2>/dev/null | grep -q .; then
    echo "port: conflict markers remain in: $(git diff --name-only | xargs -r grep -l '^<<<<<<< ')" >&2; exit 1
  fi
  if git diff --cached --name-only | xargs -r grep -l '^<<<<<<< ' 2>/dev/null | grep -q .; then
    echo "port: staged files still contain conflict markers" >&2; exit 1
  fi
  commit_ported "$sha"
  exit 0
fi

sha="$1"
if [ -f "$GITDIR/port-pending" ]; then
  echo "port: $(cat "$GITDIR/port-pending") is still pending; resolve it and run --finish first" >&2; exit 2
fi
IGNORE=(':(exclude)scripts/port-upstream-commit.sh' ':(exclude).serena/project.yml' ':(exclude)opencode.json')
if ! git diff --quiet -- . "${IGNORE[@]}" || ! git diff --cached --quiet -- . "${IGNORE[@]}"; then
  echo "port: working tree has uncommitted changes; commit or stash them first" >&2; exit 2
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
conflicts=()
while IFS=$'\t' read -r status p1 p2; do
  src="$p1"; dst_up="${p2:-$p1}"
  excluded "$dst_up" && continue
  dst="$(printf '%s' "$dst_up" | rebrand)"
  srcj="$(printf '%s' "$src" | rebrand)"
  case "$status" in
    A)
      git -C "$UP" show "$sha:$dst_up" | rebrand > "$tmp/theirs"
      if [ -e "$dst" ] && ! cmp -s "$dst" "$tmp/theirs"; then
        cp "$dst" "$tmp/ours"; : > "$tmp/base"
        git merge-file -L JAgentDesk -L base -L upstream "$tmp/ours" "$tmp/base" "$tmp/theirs" >/dev/null 2>&1 || true
        cp "$tmp/ours" "$dst"; conflicts+=("$dst (added upstream, exists here)")
      else
        mkdir -p "$(dirname "$dst")"; cp "$tmp/theirs" "$dst"
      fi
      git add -- "$dst" 2>/dev/null || true
      ;;
    D)
      [ -e "$dst" ] || continue
      git -C "$UP" show "$sha^:$src" | rebrand > "$tmp/base"
      if cmp -s "$dst" "$tmp/base"; then git rm -q -- "$dst"; else conflicts+=("$dst (deleted upstream, changed here — delete it by hand if the upstream intent applies)"); fi
      ;;
    M|R*|C*)
      if [ ! -e "$srcj" ] && [ ! -e "$dst" ]; then
        case "$dst" in packages/app/src/i18n/resources/*) continue ;; esac  # locale JAgentDesk does not ship
        conflicts+=("$dst (file does not exist in JAgentDesk — port by hand or skip with a reason)"); continue
      fi
      [ -e "$dst" ] || { mkdir -p "$(dirname "$dst")"; git mv -- "$srcj" "$dst" 2>/dev/null || cp "$srcj" "$dst"; }
      if ! git -C "$UP" diff --numstat "$sha^" "$sha" -- "$dst_up" | grep -qv '^-'; then
        # binary
        git -C "$UP" show "$sha:$dst_up" > "$dst"; git add -- "$dst"; continue
      fi
      git -C "$UP" show "$sha^:$src" | rebrand > "$tmp/base"
      git -C "$UP" show "$sha:$dst_up" | rebrand > "$tmp/theirs"
      cp "$dst" "$tmp/ours"
      if git merge-file -L JAgentDesk -L "upstream-base" -L "upstream $sha" "$tmp/ours" "$tmp/base" "$tmp/theirs" >/dev/null 2>&1; then
        cp "$tmp/ours" "$dst"; git add -- "$dst"
      else
        if [ -x "$MERGIRAF" ] && cp "$dst" "$tmp/left" && "$MERGIRAF" merge -p "$dst" -o "$tmp/merged" "$tmp/base" "$tmp/left" "$tmp/theirs" >/dev/null 2>&1 && ! grep -q '^<<<<<<<' "$tmp/merged"; then
          cp "$tmp/merged" "$dst"; git add -- "$dst"
        else
          cp "$tmp/ours" "$dst"; conflicts+=("$dst")
        fi
      fi
      ;;
  esac
done < <(git -C "$UP" diff --name-status -M "$sha^" "$sha")

if [ ${#conflicts[@]} -gt 0 ]; then
  echo "$sha" > "$GITDIR/port-pending"
  echo "port: $sha needs hand resolution in:" >&2
  printf '  %s\n' "${conflicts[@]}" >&2
  echo "Resolve the <<<<<<< JAgentDesk / >>>>>>> upstream markers (keep JAgentDesk features AND the upstream fix), git add the files, then run: scripts/port-upstream-commit.sh --finish $sha" >&2
  echo "To give up on this commit: git reset -q --hard HEAD && rm -f $GITDIR/port-pending" >&2
  exit 1
fi
commit_ported "$sha"
