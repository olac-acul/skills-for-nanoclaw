#!/usr/bin/env bash
# Registers a number of its own for NanoClaw's Signal channel (a SIM or a landline that only the assistant uses),
# instead of linking the owner's phone: the assistant is then a member of the groups like anyone else, and sees
# nothing of the owner's Signal. Run it as the NanoClaw user, from the NanoClaw folder, in a real terminal:
#
#   bash scripts/signal-register.sh --number +39... --name Alfred --owner +39...   [--voice]
#
#   --number  the assistant's number, in international form
#   --name    the profile name the groups see
#   --owner   the only number whose direct messages reach the assistant (SIGNAL_DM_ALLOW); others are ignored
#   --voice   the code comes by a call instead of an SMS (a landline; Signal may first want an SMS attempt)
#
# What it asks for: Signal's captcha (solved in a browser), the code that comes by SMS or call, and a registration
# lock PIN (asked twice, never shown nor stored: without it nobody can register the number elsewhere). It writes
# SIGNAL_ACCOUNT and SIGNAL_DM_ALLOW in .env. NanoClaw must not be running the channel for this number meanwhile.
set -euo pipefail
umask 077

die() { echo "signal-register: $*" >&2; exit 1; }
number="" name="" owner="" voice=""
while [ $# -gt 0 ]; do
  case "$1" in
    --number) number="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --owner) owner="${2:-}"; shift 2 ;;
    --voice) voice="--voice"; shift ;;
    *) die "unknown argument $1 (see the top of this script)" ;;
  esac
done
[[ "$number" =~ ^\+[1-9][0-9]{6,14}$ ]] || die "--number +<country code><number> is required"
[[ -z "$owner" || "$owner" =~ ^\+[1-9][0-9]{6,14}$ ]] || die "--owner must be a number in international form"
[[ "$owner" != "$number" ]] || die "--owner is your own number, not the assistant's"
[[ "$name" =~ ^[[:alnum:][:space:]._-]{1,40}$ ]] || die "--name is required (letters, digits, spaces; up to 40)"
[ -f .env ] && [ -f package.json ] || die "run this from the NanoClaw folder"
[ -t 0 ] || die "run this in a real terminal: it asks for the captcha, the code and the PIN"

cli="${SIGNAL_CLI_PATH:-}"
[ -n "$cli" ] || cli="$(command -v signal-cli || true)"
[ -n "$cli" ] || [ ! -x "$HOME/.local/bin/signal-cli" ] || cli="$HOME/.local/bin/signal-cli"
[ -n "$cli" ] || die "signal-cli not found: run setup/install-signal-cli.sh first"
sig() { "$cli" -a "$number" "$@"; }

data="${SIGNAL_DATA_DIR:-$HOME/.local/share/signal-cli}"
mkdir -p "$data" && chmod 700 "$data"

if sig listIdentities > /dev/null 2>&1; then
  echo "The number is already registered on this machine: going on with the PIN and the profile."
else
  cat << 'HOW'

1. Open https://signalcaptchas.org/registration/generate.html in a browser and solve the captcha.
2. The page then offers to "Open Signal": copy that link instead (right click, copy link address).
   It starts with signalcaptcha:// and is valid for a few minutes.
HOW
  read -r -p "Captcha link: " captcha
  captcha="${captcha#"${captcha%%[![:space:]]*}"}"; captcha="${captcha%"${captcha##*[![:space:]]}"}"
  [[ "$captcha" == signalcaptcha://* ]] || die "that is not a signalcaptcha:// link"
  sig register $voice --captcha "$captcha" || die "Signal refused the registration (try again with a new captcha; with --voice, try once without it first)"
  read -r -p "Code received (SMS or call): " code
  code="${code//[^0-9]/}"
  [[ "$code" =~ ^[0-9]{6}$ ]] || die "the code has 6 digits"
  sig verify "$code" || die "the code was not accepted"
  echo "Registered."
fi

while :; do
  read -r -s -p "Registration lock PIN (at least 6 digits, keep it somewhere safe): " pin; echo
  read -r -s -p "The PIN again: " again; echo
  [[ "$pin" =~ ^[0-9]{6,20}$ ]] || { echo "digits only, at least 6"; continue; }
  [ "$pin" = "$again" ] && break
  echo "they differ, again"
done
sig setPin "$pin" > /dev/null || die "could not set the PIN"
unset pin again
sig updateProfile --given-name "$name" --family-name "" > /dev/null || die "could not set the profile name"

# .env: replace or append, through a private temporary file (umask 077).
set_env() {
  local key=$1 value=$2 tmp
  tmp="$(mktemp .env.XXXXXX)"
  grep -v -E "^${key}=" .env > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" .env
}
set_env SIGNAL_ACCOUNT "$number"
[ -z "$owner" ] || set_env SIGNAL_DM_ALLOW "$owner"
echo
echo "Done: the number is registered as \"$name\", with its PIN. In .env: SIGNAL_ACCOUNT${owner:+ and SIGNAL_DM_ALLOW}."
echo "Next: restart NanoClaw, add the number to the group from a phone, then wire the group (see the skill)."
