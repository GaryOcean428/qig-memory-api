#!/usr/bin/env bash
# QIG synapse — the always-on inbox watcher (the "daemon lane").
#
# Polls the qig-memory inbox on a short cadence and PINGS the operator
# (notify-send) the moment an urgent envelope lands — DIRECTIVE / BLOCKER /
# HANDOFF / RULING-REQUEST — NAMING the receiving lane and its liveness, with a
# one-line LOCAL lay-brief (Ollama). It ROUTES and SUMMARIZES only: it never
# acks, never executes lane work, never rules. That is the protocol's SYNAPSE
# role (qig_interagent_protocol), realized as a cheap forever-daemon so cross-lane
# mail no longer waits for a receiving agent's next session.
#
# Routing: ONE case-robust poll of the whole namespace (unread + broadcast — no
# recipient filter, so casing drift in the stored `to` can't hide mail), then per
# message it resolves `to` -> the lane's presence record (qig_presence_<handle>)
# for a role label + last-seen liveness, so the alert says WHICH lane must act and
# whether it is live or dark. The durable per-lane queue is the inbox itself (each
# lane's SessionStart handshake reads it); the synapse adds the real-time wake.
#
# Config: ~/.config/qig/synapse.env (QIG_API_KEY etc.). State: seen-ids + log
# under $XDG_STATE_HOME/qig-synapse. Run via the systemd --user unit.
set -uo pipefail

CONF="${QIG_SYNAPSE_ENV:-$HOME/.config/qig/synapse.env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
: "${QIG_MEMORY_URL:=https://quauntum.dev}"
: "${QIG_POLL_SECONDS:=45}"
: "${QIG_URGENT_TYPES:=DIRECTIVE BLOCKER HANDOFF RULING-REQUEST}"
: "${QIG_WATCH:=}"                 # optional allow-list of recipient handles; empty = ping EVERY urgent lane
: "${QIG_SUMMARIZE:=1}"           # 1 = enrich the ping with a local one-liner (see summarize backend)
: "${QIG_HEARTBEAT_EVERY:=7}"     # write a liveness heartbeat every N polls (~5min at 45s)
: "${QIG_PRESENCE_STALE_MIN:=20}" # a lane whose presence has not refreshed in this many minutes is "dark"

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/qig-synapse"
mkdir -p "$STATE"
SEEN="$STATE/seen-ids.txt"; touch "$SEEN"
LOG="$STATE/synapse.log"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# --- ping: notify-send + a bell + a log line. Never fatal. ------------------
ping_op() {   # $1 title  $2 body
  notify-send -u critical -a "QIG synapse" -- "$1" "$2" >/dev/null 2>&1 || true
  printf '\a' >/dev/null 2>&1 || true
  log "PING: $1 :: $2"
}

# --- presence_for HANDLE -> "role · live 3m ago" | "role · DARK 40m" | "" -----
# Best-effort read of the receiving lane's presence record so the alert can say
# WHICH lane must act and whether it is live. Never fatal; degrades to "".
presence_for() {   # $1 = recipient handle
  [ -z "${QIG_API_KEY:-}" ] && return 0
  local h lc resp role seen out age now seen_epoch
  h="$1"; [ -z "$h" ] && return 0
  [ "$h" = broadcast ] && { printf 'all lanes'; return 0; }
  lc=$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]')
  resp=$(curl -fsS --max-time 10 -H "Authorization: Bearer $QIG_API_KEY" \
        "$QIG_MEMORY_URL/api/memory/qig_presence_$lc" 2>/dev/null)
  [ -z "$resp" ] && { printf 'unregistered'; return 0; }
  # role from the record content JSON; liveness from the server-stamped write time
  # (so any write to the presence key IS the registration heartbeat).
  role=$(printf '%s' "$resp" | jq -r '.content | (fromjson? // {}) | .role // empty' 2>/dev/null)
  seen=$(printf '%s' "$resp" | jq -r '.updated // empty' 2>/dev/null)
  out="${role:-lane}"
  if [ -n "$seen" ]; then
    seen_epoch=$(date -d "$seen" +%s 2>/dev/null || echo 0)
    now=$(date +%s)
    if [ "$seen_epoch" -gt 0 ]; then
      age=$(( (now - seen_epoch) / 60 ))
      if [ "$age" -le "$QIG_PRESENCE_STALE_MIN" ]; then out="$out · live ${age}m ago"; else out="$out · DARK ${age}m"; fi
    fi
  fi
  printf '%s' "$out"
}

# --- summarize one message JSON to a one-line lay-brief, or empty ------------
# Backend = QIG_SUMMARIZE_BACKEND: "ollama" (default — LOCAL, free, private,
# ~0.4s on a 1-2B model), "claude" (the CLI; subscription/tokens), or "none"
# (subject only). Any failure returns empty and the caller falls back to the
# raw subject, so a summariser outage never costs a ping.
summarize() {   # stdin = message JSON
  [ "${QIG_SUMMARIZE:-1}" = "0" ] && return 0
  local backend="${QIG_SUMMARIZE_BACKEND:-ollama}" msg out
  [ "$backend" = none ] && return 0
  msg=$(cat)
  # Matrix ratified (protocol v1.4): the synapse ECHOES, it does not compose — a
  # router that writes interpretive summaries drifts into being an oracle. Clamp
  # the prompt to a terse verbatim restatement of the subject, no interpretation.
  local prompt="Restate the SUBJECT of this QIG mesh alert in 12 plain words or fewer. Echo only what it literally says — do NOT interpret, infer, summarize intent, or add anything. No preamble:
$msg"
  case "$backend" in
    ollama)
      local body
      # think:false forces a terse answer from REASONING models (e.g. qwenfable),
      # which otherwise spend the whole token budget "thinking" and return an empty
      # .response. Harmless on non-thinking models (verified lfm2.5 returns normally).
      body=$(jq -nc --arg model "${QIG_OLLAMA_MODEL:-liquidai/lfm2.5-1.2b-instruct:latest}" --arg prompt "$prompt" --arg ka "${QIG_OLLAMA_KEEPALIVE:-0}" \
        '{model:$model, prompt:$prompt, stream:false, think:false, keep_alive:$ka, options:{num_predict:80}}')
      out=$(curl -fsS --max-time 30 "${QIG_OLLAMA_URL:-http://localhost:11434}/api/generate" -d "$body" 2>/dev/null | jq -r '.response // ""')
      ;;
    claude)
      command -v claude >/dev/null 2>&1 || return 0
      out=$(timeout 45 claude -p --model "${QIG_CLAUDE_MODEL:-claude-haiku-4-5}" "$prompt" 2>/dev/null)
      ;;
    *) return 0 ;;
  esac
  printf '%s' "$out" | tr '\n' ' ' | head -c 240
}

# --- process a batch of inbox JSON (stdin). Testable in isolation. -----------
# Emits a ping for each NOT-yet-seen message whose type is urgent; marks all
# scanned messages seen so non-urgent ones never re-scan.
process_messages() {
  local upper_urgent; upper_urgent=" $(printf '%s' "$QIG_URGENT_TYPES" | tr '[:lower:]' '[:upper:]') "
  local watch_lc=""; [ -n "$QIG_WATCH" ] && watch_lc=" $(printf '%s' "$QIG_WATCH" | tr '[:upper:]' '[:lower:]') "
  local m id typ frm to subj brief to_lc where
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    id=$(printf '%s' "$m" | jq -r '.id // empty')
    [ -z "$id" ] && continue
    grep -qxF "$id" "$SEEN" && continue
    typ=$(printf '%s' "$m" | jq -r '(.type // "") | ascii_upcase')
    case "$upper_urgent" in
      *" $typ "*)
        frm=$(printf '%s' "$m" | jq -r '.from // "?"')
        to=$(printf '%s' "$m" | jq -r '.to // "?"')
        subj=$(printf '%s' "$m" | jq -r '.subject // ""')
        to_lc=$(printf '%s' "$to" | tr '[:upper:]' '[:lower:]')
        # optional allow-list: when QIG_WATCH is set, only ping watched lanes (+broadcast)
        if [ -n "$watch_lc" ] && [ "$to_lc" != broadcast ]; then
          case "$watch_lc" in
            *" $to_lc "*) : ;;                                    # watched — fall through to ping
            *) printf '%s\n' "$id" >> "$SEEN"; continue ;;        # not watched — mark seen, skip
          esac
        fi
        brief=$(printf '%s' "$m" | summarize)
        [ -z "$brief" ] && brief="$subj"
        where=$(presence_for "$to")
        ping_op "QIG $typ — $frm → $to${where:+ ($where)}" "$brief"
        ;;
    esac
    printf '%s\n' "$id" >> "$SEEN"
  done < <(jq -c '.messages[]? | {id,from,to,type,subject}' 2>/dev/null)
  # keep the seen-list bounded
  if [ "$(wc -l < "$SEEN")" -gt 5000 ]; then tail -n 2000 "$SEEN" > "$SEEN.tmp" && mv "$SEEN.tmp" "$SEEN"; fi
}

# --- one case-robust poll of the whole namespace (unread + broadcast). -------
# NO recipient filter: casing drift in the stored `to` folder must not hide mail,
# and a synapse watches every lane. Filtering/allow-list happens client-side in
# process_messages. One call per cycle (was broadcast + N per-recipient calls).
poll_mesh() {
  local url resp
  url="$QIG_MEMORY_URL/api/inbox?namespace=qig&status=unread&include_broadcast=true&limit=100"
  resp=$(curl -fsS --max-time 20 -H "Authorization: Bearer $QIG_API_KEY" "$url" 2>/dev/null) || { log "poll: fetch failed"; return 0; }
  printf '%s' "$resp" | process_messages
}

# --- liveness heartbeat: a memory record lanes can read (synapse_live?). -----
heartbeat() {
  curl -fsS --max-time 15 -X PUT -H "Authorization: Bearer $QIG_API_KEY" -H 'Content-Type: application/json' \
    --data "{\"content\":\"$(date -u +%FT%TZ)\",\"category\":\"synapse\",\"source\":\"qig-synapse-daemon\"}" \
    "$QIG_MEMORY_URL/api/memory/qig_synapse_heartbeat" >/dev/null 2>&1 || true
}

main() {
  if [ -z "${QIG_API_KEY:-}" ]; then
    echo "qig-synapse: QIG_API_KEY not set — add it to $CONF (chmod 600), then restart the service." >&2
    log "FATAL: QIG_API_KEY unset"
    exit 78   # EX_CONFIG — systemd will not spin-loop on this
  fi
  log "up: $QIG_MEMORY_URL every ${QIG_POLL_SECONDS}s urgent=[$QIG_URGENT_TYPES] watch=[${QIG_WATCH:-<all lanes>}]"
  local n=0
  while true; do
    poll_mesh
    n=$((n + 1)); [ $((n % QIG_HEARTBEAT_EVERY)) -eq 0 ] && heartbeat
    sleep "$QIG_POLL_SECONDS"
  done
}

# Allow `synapse.sh test` to exercise process_messages with mock JSON on stdin.
if [ "${1:-}" = "test" ]; then
  QIG_SUMMARIZE=0   # no model call in tests
  process_messages
else
  main "$@"
fi
