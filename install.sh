#!/usr/bin/env bash
# Install NanoClaw from scratch with the skills of this repository, asking everything on the way.
#
#   git clone https://github.com/olac-acul/skills-for-nanoclaw.git
#   bash skills-for-nanoclaw/install.sh [--user NAME] [--extra DIR]...
#
# Run it as root on a fresh Debian 13 machine (or LXC with nesting, for Docker), in a real terminal. It:
#
#   1. installs a few system packages and Bun, creates the user NanoClaw runs as, lets its services run without a
#      login, and gives it passwordless sudo for the installation (upstream's installer needs it);
#   2. gets NanoClaw (newest stable release) and this repository into that user's home;
#   3. runs upstream's own interactive installer, `nanoclaw.sh` (model provider, credential gateway, first channel);
#   4. applies the skills of this repository: backups, the manager panel, the shorter assistant prompt for OpenCode,
#      and, if you use it, the NanoVoice voice channel;
#   5. asks where the panel listens and prints its one-time setup code; sets up weekly backups; sets up the voice
#      channel and its phone pairing;
#   6. runs the interactive `setup.sh` of any extra skill folder given with --extra (for example private skills);
#   7. takes the passwordless sudo away again.
#
# Every step is recorded when it is done; if something stops it, fix the cause and run the same command again: it
# goes on from the step that did not finish. `--redo STEP` runs one step again (base, code, upstream, skills, panel,
# backups, voice, extras, finish).
set -euo pipefail
umask 022

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NC_USER="nanoclaw"
EXTRAS=()
REDO=""
SUDOERS="/etc/sudoers.d/90-nanoclaw-installer"
UPSTREAM_URL="https://github.com/nanocoai/nanoclaw.git"

bold() { printf '\033[1m%s\033[0m' "$*"; }
say() { printf '\n%s\n' "$(bold "== $*")"; }
note() { printf '   %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
ask() { local answer; read -r -p "   $1 " answer </dev/tty; printf '%s' "$answer"; }
ask_yes() { local a; a="$(ask "$1 [y/N]")"; [[ "$a" =~ ^[YySs] ]]; }
ask_no() { local a; a="$(ask "$1 [Y/n]")"; [[ ! "$a" =~ ^[Nn] ]]; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) NC_USER="${2:?--user needs a name}"; shift ;;
    --extra) EXTRAS+=("$(cd "${2:?--extra needs a folder}" && pwd)"); shift ;;
    --redo) REDO="${2:?--redo needs a step name}"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[[ "$(id -u)" == 0 ]] || die "run this as root (it creates the user NanoClaw runs as)"
[[ -t 0 ]] || die "run this in a real terminal: it asks questions"
[[ "$NC_USER" =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || die "unusual user name: $NC_USER"
[[ -f "$REPO_DIR/scripts/install-skills.mjs" ]] || die "run the install.sh of a skills-for-nanoclaw checkout"

STATE_DIR="/var/lib/nanoclaw-installer"
STATE="$STATE_DIR/$NC_USER.done"
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR" && touch "$STATE"
# Steps recorded for a user that no longer exists are not done any more.
id "$NC_USER" >/dev/null 2>&1 || : >"$STATE"
done_step() { grep -qx "$1" "$STATE" && [[ "$REDO" != "$1" ]]; }
mark() { grep -qx "$1" "$STATE" || echo "$1" >>"$STATE"; }

HOME_DIR="/home/$NC_USER"
INSTALL="$HOME_DIR/nanoclaw"
SKILLS="$HOME_DIR/skills-for-nanoclaw"

# Run a command as the NanoClaw user, in its home, with its user services and the tools upstream installs.
as_user() {
  local uid
  uid="$(id -u "$NC_USER")"
  runuser -u "$NC_USER" -- env -i HOME="$HOME_DIR" USER="$NC_USER" LOGNAME="$NC_USER" SHELL=/bin/bash \
    TERM="${TERM:-xterm}" LANG="${LANG:-C.UTF-8}" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    PATH="$HOME_DIR/.local/bin:$HOME_DIR/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "umask 022; cd \"\$HOME\"; $1"
}
in_install() { as_user "cd ~/nanoclaw && $1"; }

# The user's service manager must have the docker group (it keeps the groups it started with).
refresh_user_manager() {
  local uid gid pid
  uid="$(id -u "$NC_USER")"
  gid="$(getent group docker | cut -d: -f3)"
  pid="$(pgrep -u "$uid" -x systemd | head -1)"
  [[ -n "$gid" && -n "$pid" ]] || return 0
  if ! grep -qE "^Groups:.*\b$gid\b" "/proc/$pid/status"; then
    note "restarting $NC_USER's service manager so its services get the docker group"
    systemctl restart "user@$uid.service"
    for _ in $(seq 1 20); do [[ -S "/run/user/$uid/bus" ]] && break; sleep 0.5; done
  fi
}
ncl() { in_install "pnpm --silent exec tsx src/cli/client.ts $*"; }

# ---------------------------------------------------------------------------------------------------------------------
step_base() {
  say "1. System packages, Bun and the user '$NC_USER'"
  if ! grep -q '^VERSION_ID="13"' /etc/os-release 2>/dev/null; then
    note "This was tested on Debian 13; this machine is: $(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")."
    ask_yes "Go on anyway?" || exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git sudo jq python3 unzip xz-utils build-essential iproute2 >/dev/null
  if ! id "$NC_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$NC_USER"
    note "user $NC_USER created (no password: reach it with 'su - $NC_USER' as root)"
  fi
  # In the docker group BEFORE lingering starts the user's service manager: a manager started earlier keeps the
  # groups it had, and NanoClaw's service would not reach Docker. The docker package keeps an existing group.
  getent group docker >/dev/null || groupadd --system docker
  usermod -aG docker "$NC_USER"
  # Upstream's installer installs Node and Docker with sudo. Taken away again at the end (step 'finish').
  echo "$NC_USER ALL=(ALL) NOPASSWD:ALL" >"$SUDOERS.tmp" && chmod 440 "$SUDOERS.tmp" && visudo -cqf "$SUDOERS.tmp" \
    && mv "$SUDOERS.tmp" "$SUDOERS"
  loginctl enable-linger "$NC_USER"
  for _ in $(seq 1 20); do [[ -S "/run/user/$(id -u "$NC_USER")/bus" ]] && break; sleep 0.5; done
  mark base
}

install_bun() {
  # The version the agent containers use (container/Dockerfile); the voice skill's tests run it on the host.
  local version arch asset tmp
  version="$(sed -n 's/^ARG BUN_VERSION=\([0-9.]*\)$/\1/p' "$INSTALL/container/Dockerfile" | head -1)"
  [[ -n "$version" ]] || die "cannot read the Bun version from container/Dockerfile"
  if command -v bun >/dev/null && [[ "$(bun --version)" == "$version" ]]; then return; fi
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=aarch64 ;; *) die "unsupported architecture $(uname -m)" ;; esac
  asset="bun-linux-$arch.zip"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$asset" "https://github.com/oven-sh/bun/releases/download/bun-v$version/$asset"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://github.com/oven-sh/bun/releases/download/bun-v$version/SHASUMS256.txt"
  (cd "$tmp" && grep " $asset\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "the Bun download does not match its checksum"
  unzip -q -o "$tmp/$asset" -d "$tmp"
  install -m 0755 "$tmp/bun-linux-$arch/bun" /usr/local/bin/bun
  rm -rf "$tmp"
  note "Bun $version installed"
}

step_code() {
  say "2. NanoClaw and this repository"
  if [[ ! -d "$INSTALL/.git" ]]; then
    as_user "git clone --quiet $UPSTREAM_URL nanoclaw"
    local tag
    tag="$(as_user "cd nanoclaw && git tag --list 'v[0-9][0-9][0-9][0-9].*' --sort=-v:refname | grep -E '^v[0-9]{4}\.[0-9]+\.[0-9]+\$' | head -1")"
    [[ -n "$tag" ]] || die "no stable release tag found upstream"
    as_user "cd nanoclaw && git switch -q -C main $tag && git config user.name nanoclaw && git config user.email nanoclaw@install.test"
    note "NanoClaw $tag (newest stable release), on the branch main"
  else
    note "NanoClaw is already in $INSTALL: left as it is"
  fi
  # A copy of this repository for the user: `update-install.mjs` lives there and keeps the skills on updates.
  rm -rf "$SKILLS.new"
  git clone --quiet "$REPO_DIR" "$SKILLS.new" 2>/dev/null || cp -a "$REPO_DIR" "$SKILLS.new"
  git -C "$SKILLS.new" remote set-url origin "$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo https://github.com/olac-acul/skills-for-nanoclaw.git)" 2>/dev/null || true
  rm -rf "$SKILLS" && mv "$SKILLS.new" "$SKILLS" && chown -R "$NC_USER:$NC_USER" "$SKILLS"
  note "skills repository copied to $SKILLS"
  install_bun
  mark code
}

step_upstream() {
  say "3. NanoClaw's own installer"
  cat <<'INFO'
   Now NanoClaw's installer runs. It installs Node and Docker, then asks, among others:
     - the model provider: for an OpenAI-compatible server choose OpenCode, then "Local or self-hosted";
     - the credential gateway: OneCLI;
     - the time zone, the assistant's name and the first channel (for example Telegram, with the bot token).
   Paste tokens and keys only into its prompts. When it says it is done, this script goes on.
INFO
  local existing
  existing="$(as_user "command -v onecli" || true)"
  if [[ -n "$existing" && ! -f "$HOME_DIR/.onecli/docker-compose.yml" ]]; then
    note "A OneCLI program is already installed ($existing) but $NC_USER has no OneCLI gateway of its own."
    note "NanoClaw's installer would reuse it, which without a configuration means OneCLI's hosted service."
    if ask_no "Move it aside ($existing.before-nanoclaw) so a local gateway is installed?"; then
      mv "$existing" "$existing.before-nanoclaw"
    fi
  fi
  refresh_user_manager
  ask "Press Enter to start it." >/dev/null
  # It can stop on a first run (the OneCLI gateway's first install on a machine sometimes does not report its
  # address); run again, it picks up where it stopped.
  until in_install "bash nanoclaw.sh"; do
    note "NanoClaw's installer stopped (the reason is above). Run again, it goes on from where it stopped."
    ask_no "Run it again now?" || die "NanoClaw's installer did not finish. Fix the cause and run this script again."
    refresh_user_manager
  done
  refresh_user_manager
  in_install "pnpm --silent exec tsx src/cli/client.ts groups list --json >/dev/null" \
    || die "NanoClaw does not answer after its installer: check 'systemctl --user status' as $NC_USER, then run this again"
  mark upstream
}

step_skills() {
  say "4. Backups, the manager panel, the assistant prompt and the voice channel"
  local skills="add-manager-backup,add-manager-panel,add-assistant-prompt"
  note "The phone app NanoVoice talks to NanoClaw through a voice channel (needs a VPN or private network the phone reaches)."
  if ask_yes "Install the voice channel for NanoVoice?"; then
    skills="$skills,add-voice"
    echo voice >"$STATE_DIR/$NC_USER.voice"
  else
    rm -f "$STATE_DIR/$NC_USER.voice"
  fi
  working_context
  note "Applying them with NanoClaw's skill engine (copy, build, tests): a few minutes."
  as_user "node ~/skills-for-nanoclaw/scripts/install-skills.mjs --install ~/nanoclaw --skills $skills" \
    || die "a skill did not apply (see above). Fix the cause and run this script again."
  mark skills
}

# The machine's IPv4 addresses other than loopback and Docker's, one "address<TAB>interface" per line.
addresses() {
  ip -4 -o addr show scope global | awk '$2 !~ /^(docker|br-|veth)/ {split($4, a, "/"); print a[1] "\t" $2}'
}

choose_address() {
  # $1: what for. Prints the chosen address, or nothing to skip.
  local list choice i=1 line
  mapfile -t list < <(addresses)
  printf '   Where should %s listen?\n' "$1" >/dev/tty
  printf '     0. only this machine (127.0.0.1)\n' >/dev/tty
  for line in "${list[@]}"; do
    printf '     %d. %s (%s)%s\n' "$i" "${line%%$'\t'*}" "${line##*$'\t'}" \
      "$([[ "${line%%$'\t'*}" == 100.* ]] && echo '  <- looks like a VPN (Tailscale) address')" >/dev/tty
    i=$((i + 1))
  done
  printf '     a. every address (0.0.0.0): only on a machine that does not face the internet\n' >/dev/tty
  choice="$(ask "Choice [0]:")"
  case "${choice:-0}" in
    0) echo 127.0.0.1 ;;
    a|A) echo 0.0.0.0 ;;
    *) [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#list[@]} )) || die "no such choice"
       echo "${list[$((choice - 1))]%%$'\t'*}" ;;
  esac
}

set_env() {
  # $1 key, $2 value: replace or append in the install's .env (kept private).
  in_install "touch .env && chmod 600 .env && grep -v '^$1=' .env >.env.installer-tmp; echo '$1=$2' >>.env.installer-tmp; mv .env.installer-tmp .env"
}

# OpenCode summarizes a long conversation (auto-compaction) only when it knows a context limit, and NanoClaw's
# installer sets none for a local model: conversations then grow until every answer is slow. The same working context
# the panel writes: the model's window, at most 65536 tokens.
working_context() {
  local env="$INSTALL/.env" base model window output
  grep -q '^OPENCODE_MODEL_CONTEXT_LIMIT=' "$env" 2>/dev/null && return 0
  base="$(sed -n 's/^OPENCODE_BASE_URL=//p' "$env" 2>/dev/null | tail -1 | tr -d "\"'")"
  model="$(sed -n 's/^OPENCODE_MODEL=//p' "$env" 2>/dev/null | tail -1 | tr -d "\"'" | sed 's|^openai/||')"
  [[ -n "$base" && -n "$model" ]] || return 0
  window="$(curl -s --max-time 10 "${base%/}/models" | python3 -c '
import json, sys
wanted = sys.argv[1]
for m in json.load(sys.stdin).get("data") or []:
    if m.get("id") == wanted and isinstance(m.get("max_model_len"), int):
        print(m["max_model_len"])
' "$model" 2>/dev/null || true)"
  if [[ ! "$window" =~ ^[0-9]+$ ]]; then
    note "The model's context window is unknown: set OPENCODE_MODEL_CONTEXT_LIMIT by hand (see the guide, Models)."
    return 0
  fi
  (( window > 65536 )) && window=65536
  output=$(( window / 2 )); (( output > 4096 )) && output=4096; (( output < 256 )) && output=256
  set_env OPENCODE_MODEL_CONTEXT_LIMIT "$window"
  set_env OPENCODE_MODEL_OUTPUT_LIMIT "$output"
  note "Agents summarize their conversations past $window tokens of context (OPENCODE_MODEL_CONTEXT_LIMIT)."
}

step_panel() {
  say "5. The manager panel"
  local bind
  bind="$(choose_address "the panel (port 3200)")"
  set_env PANEL_BIND "$bind"
  in_install "bash setup/lib/restart.sh >/dev/null" || die "NanoClaw did not restart"
  [[ "$bind" == 127.0.0.1 ]] && note "Reach it from another computer with: ssh -L 3200:127.0.0.1:3200 $NC_USER@<this machine>"
  [[ "$bind" == 0.0.0.0 || "$bind" != 100.* && "$bind" != 127.0.0.1 ]] \
    && note "It is plain HTTP: the password crosses the network readable. See the guide for HTTPS."
  note "Open the address below, enter the code and choose the administrator password (the code works once, 30 minutes):"
  in_install "pnpm --silent exec tsx scripts/manager-panel.ts setup-code" || die "could not make the setup code"
  ask "Press Enter when the administrator is created (or later: 'pnpm exec tsx scripts/manager-panel.ts setup-code')." >/dev/null
  mark panel
}

step_backups() {
  say "6. Weekly backups"
  if ! ask_no "Back up this install by itself once a week?"; then
    note "skipped: the panel's Backups page and 'scripts/manager-backup.ts' make backups by hand"
    mark backups
    return
  fi
  local weekday time keep
  weekday="$(ask "Day (Mon..Sun) [Sun]:")"; weekday="${weekday:-Sun}"
  time="$(ask "Time, HH:MM in this machine's time zone ($(date +%Z)) [03:30]:")"; time="${time:-03:30}"
  keep="$(ask "How many to keep [3]:")"; keep="${keep:-3}"
  [[ "$weekday" =~ ^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$ && "$time" =~ ^[0-2][0-9]:[0-5][0-9]$ && "$keep" =~ ^[1-9][0-9]?$ ]] \
    || die "day, time or number not understood"
  note "The backups get a key of their own. It is shown ONCE now: store it in a password manager. Without it no"
  note "scheduled backup can be opened, and anyone with it and a backup can open that backup."
  in_install "pnpm --silent exec tsx scripts/manager-backup.ts schedule init-key" || die "could not make the backup key"
  ask "Press Enter when the key is stored safely." >/dev/null
  clear 2>/dev/null || true
  in_install "pnpm --silent exec tsx scripts/manager-backup.ts schedule install --keep $keep --weekday $weekday --time $time" \
    || die "could not install the backup timer"
  note "Copy the backups to another disk or machine from time to time: the panel's Backups page can download them."
  mark backups
}

step_voice() {
  [[ -f "$STATE_DIR/$NC_USER.voice" ]] || { mark voice; return; }
  say "7. The voice channel for NanoVoice"
  local list choice folder bind i=1 line
  # Not the terminal agent setup makes ('ping_test'): with the voice channel wired to it, its answers to the
  # terminal would go to the app.
  mapfile -t list < <(ncl groups list --json | python3 -c '
import json, sys
for g in json.load(sys.stdin).get("data") or []:
    if g.get("folder") and g.get("id") and g["folder"] != "ping_test":
        print(g["folder"] + "\t" + (g.get("name") or ""))')
  note "Which agent answers the app? One you have shares its memory and tools with the app; a separate one does not."
  for line in "${list[@]}"; do printf '     %d. %s (%s)\n' "$i" "${line##*$'\t'}" "${line%%$'\t'*}"; i=$((i + 1)); done
  printf '     d. a separate agent only for the app\n'
  choice="$(ask "Choice:")"
  if [[ "$choice" =~ ^[dD]$ ]]; then folder=""
  elif [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#list[@]} )); then folder="${list[$((choice - 1))]%%$'\t'*}"
  else die "no such choice"; fi
  bind="$(choose_address "the voice channel (port 8767; the phone must reach it, best through a VPN)")"
  local target
  target="$([[ -n "$folder" ]] && echo "--folder $folder" || echo "--dedicated")"
  in_install "pnpm --silent exec tsx scripts/voice-setup.ts enable --bind $bind $target" || die "voice-setup enable failed"
  in_install "bash setup/lib/restart.sh >/dev/null" || die "NanoClaw did not restart"
  in_install "pnpm --silent exec tsx scripts/voice-setup.ts wire $target" || die "voice-setup wire failed"
  note "Pair the phone: in the panel, page Phone, make a pairing QR and scan it in the app (Settings > Server)."
  mark voice
}

step_extras() {
  [[ ${#EXTRAS[@]} -gt 0 ]] || { mark extras; return; }
  say "8. Extra skills"
  local dir setup name
  for dir in "${EXTRAS[@]}"; do
    for setup in "$dir"/*/setup.sh; do
      [[ -f "$setup" ]] || continue
      name="$(basename "$(dirname "$setup")")"
      ask_yes "Set up $name now?" || continue
      rm -rf "$HOME_DIR/private-skills/$name"
      mkdir -p "$HOME_DIR/private-skills"
      cp -a "$(dirname "$setup")" "$HOME_DIR/private-skills/$name"
      chown -R "$NC_USER:$NC_USER" "$HOME_DIR/private-skills"
      as_user "bash ~/private-skills/$name/setup.sh --project-root ~/nanoclaw" </dev/tty \
        || note "$name did not finish; run it again later: su - $NC_USER, then bash ~/private-skills/$name/setup.sh"
    done
  done
  mark extras
}

step_finish() {
  say "9. Finishing"
  if [[ -f "$SUDOERS" ]]; then
    if ask_no "Take away the passwordless sudo given to $NC_USER for the installation?"; then
      rm -f "$SUDOERS"
      note "removed. Updates later run as $NC_USER without sudo (update-install.mjs)."
    else
      note "kept ($SUDOERS): remove it when you no longer need it"
    fi
  fi
  mark finish
  cat <<INFO

   Done. As $NC_USER (su - $NC_USER):
     cd ~/nanoclaw && pnpm exec tsx scripts/manager-panel.ts status     the panel
     cd ~/nanoclaw && pnpm exec tsx scripts/manager-backup.ts schedule status
     node ~/skills-for-nanoclaw/scripts/update-install.mjs prepare       update NanoClaw later (then cutover)
   The guide: ~/skills-for-nanoclaw/docs/guide.md
INFO
}

for step in base code upstream skills panel backups voice extras finish; do
  done_step "$step" && { note "step '$step' already done"; continue; }
  "step_$step"
done
