#!/usr/bin/env sh
# Public-repo guard: fail if tracked files contain things that must never be
# published — credentials or personal machine paths. Deliberately GENERIC: it
# must not list any real hostname, project or person (that would itself leak).
# Run locally with `npm run check:public`; CI runs it on every PR.
set -eu

fail=0
check() {
  label="$1"; pattern="$2"
  # -I skips binaries; the lockfiles carry integrity hashes, not secrets.
  # git grep exits 0 on a match, 1 on none, and >1 on an error — an error must
  # fail the check too, never pass silently.
  rc=0
  git grep -n -I -E -e "$pattern" -- . ':!package-lock.json' ':!web/package-lock.json' ':!scripts/check-public.sh' || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "::error::public-repo check failed: $label" >&2
    fail=1
  elif [ "$rc" -ne 1 ]; then
    echo "::error::public-repo check could not run ($label): git grep exited $rc" >&2
    fail=1
  fi
}

check "private key"                '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "GitHub token"               '(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'
check "AWS access key"             'AKIA[0-9A-Z]{16}'
check "Google API key"             'AIza[0-9A-Za-z_-]{35}'
check "Google OAuth client secret" 'GOCSPX-[A-Za-z0-9_-]{20,}'
check "Slack token"                'xox[abposr]-[0-9A-Za-z-]{10,}'
check "personal home path"         '(/Users/[A-Za-z][A-Za-z0-9._-]+/|/home/[a-z][a-z0-9._-]*_[a-z0-9._-]+/)'

if [ "$fail" -ne 0 ]; then
  echo "See AGENTS.md (\"Rule zero\") for what must never be committed and the placeholders to use." >&2
  exit 1
fi
echo "public-repo check: ok"
