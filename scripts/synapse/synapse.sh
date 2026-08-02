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
: "${QIG_NAMESPACES:=qig bsuite general}"  # inbox namespaces to sweep (space-separated). Was qig-only.
: "${QIG_DISPATCH:=0}"            # 1 = also WAKE the receiving lane as a headless agent (see dispatch.sh)
: "${QIG_SYNAPSE_DISPATCH:=$HOME/.local/share/qig-synapse/dispatch.sh}" # dispatcher location

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
  local h lc tmp status resp role seen out age now seen_epoch
  h="$1"; [ -z "$h" ] && return 0
  [ "$h" = broadcast ] && { printf 'all lanes'; return 0; }
  lc=$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]')
  tmp=$(mktemp)
  status=$(curl -sS --max-time 10 -H "Authorization: Bearer $QIG_API_KEY" \
        -o "$tmp" -w '%{http_code}' "$QIG_MEMORY_URL/api/memory/qig_presence_$lc" 2>/dev/null) || status=000
  resp=$(cat "$tmp" 2>/dev/null); rm -f "$tmp"
  # 401/403 is a credential problem, not "this lane never registered" — say so
  # distinctly instead of collapsing both into the same misleading "unregistered".
  case "$status" in
    401|403) printf 'auth_error'; return 0 ;;
  esac
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
  local ns="${1:-qig}"   # which namespace this batch came from (for the ping label + dispatch)
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
        ping_op "[$ns] $typ — $frm → $to${where:+ ($where)}" "$brief"
        # Opt-in: also WAKE the receiving lane as a headless agent (agent-to-agent
        # coordination). All allow-list / depth / rate / self-reply guards live in
        # dispatch.sh; a missing/negative gate there is a no-op, never a runaway.
        # The namespace is passed through so the woken agent replies in-lane.
        if [ "$QIG_DISPATCH" = 1 ] && [ -x "$QIG_SYNAPSE_DISPATCH" ]; then
          "$QIG_SYNAPSE_DISPATCH" "$id" "$frm" "$to" "$typ" "$subj" "$ns" >/dev/null 2>&1 \
            || log "DISPATCH call failed for $id -> $to"
        fi
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
#
# Diagnosability: the old version used `curl -fsS` and collapsed EVERY non-2xx
# outcome (bad/expired key, network blip, server 5xx) into one indistinguishable
# "poll: fetch failed" log line — from the outside that reads as generic
# "flaky", with no way to tell a credential problem from a network hiccup
# without a separate investigation. We now capture the HTTP status separately
# and log it, and — since a 401/403 here means EVERY future poll will also fail
# until a human fixes the key (retrying on the same cadence changes nothing) —
# a consecutive-auth-failure streak escalates to a desktop ping instead of
# silently logging forever. This does NOT retry faster on failure (still one
# call per QIG_POLL_SECONDS): a hot retry loop on an auth failure is itself a
# bug (see the /api/coordize 401-flood root-cause fix this shipped alongside).
CONSEC_AUTH_FAIL=0
# poll ONE namespace. Returns: 0 = 200/OK, 2 = auth failure, 1 = other/network.
# Feeds a 200 body to process_messages tagged with its namespace.
poll_one() {
  local ns="$1" url tmp status body
  url="$QIG_MEMORY_URL/api/inbox?namespace=$ns&status=unread&include_broadcast=true&limit=50"
  tmp=$(mktemp)
  status=$(curl -sS --max-time 45 -H "Authorization: Bearer $QIG_API_KEY" -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null) || status=000
  body=$(cat "$tmp" 2>/dev/null); rm -f "$tmp"
  case "$status" in
    200)     printf '%s' "$body" | process_messages "$ns"; return 0 ;;
    401|403) log "poll[$ns]: AUTH_FAILED status=$status — QIG_API_KEY missing/invalid/revoked, check $CONF"; return 2 ;;
    000)     log "poll[$ns]: network/timeout (no HTTP response within 45s)"; return 1 ;;
    *)       log "poll[$ns]: unexpected status=$status"; return 1 ;;
  esac
}

# Sweep every configured namespace each cycle (was a single hardcoded qig poll).
# Auth-streak escalation is per-CYCLE: any namespace returning 200 resets it; a
# cycle where every namespace 401/403s (bad key → all fail) advances it once.
poll_mesh() {
  local ns rc got200=0 authfail=0
  for ns in $QIG_NAMESPACES; do
    poll_one "$ns"; rc=$?
    [ "$rc" -eq 0 ] && got200=1
    [ "$rc" -eq 2 ] && authfail=1
  done
  if [ "$got200" -eq 1 ]; then
    CONSEC_AUTH_FAIL=0
  elif [ "$authfail" -eq 1 ]; then
    CONSEC_AUTH_FAIL=$((CONSEC_AUTH_FAIL + 1))
    log "poll: AUTH_FAILED across all namespaces (consecutive=$CONSEC_AUTH_FAIL)"
    if [ "$CONSEC_AUTH_FAIL" -eq 3 ]; then
      ping_op "synapse — auth failing" "QIG_API_KEY rejected (HTTP 401/403) for 3 consecutive polls — daemon cannot see inbox mail. Check ~/.config/qig/synapse.env."
    fi
  fi
}

# --- liveness heartbeat: a memory record lanes can read (synapse_live?). -----
heartbeat() {
  local status
  status=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $QIG_API_KEY" -H 'Content-Type: application/json' \
    --data "{\"content\":\"$(date -u +%FT%TZ)\",\"category\":\"synapse\",\"source\":\"qig-synapse-daemon\"}" \
    "$QIG_MEMORY_URL/api/memory/qig_synapse_heartbeat" 2>/dev/null) || status=000
  case "$status" in
    200|201) : ;;
    401|403) log "heartbeat: AUTH_FAILED status=$status — QIG_API_KEY missing/invalid/revoked" ;;
    000) log "heartbeat: network/timeout" ;;
    *) log "heartbeat: unexpected status=$status" ;;
  esac
}

main() {
  if [ -z "${QIG_API_KEY:-}" ]; then
    echo "qig-synapse: QIG_API_KEY not set — add it to $CONF (chmod 600), then restart the service." >&2
    log "FATAL: QIG_API_KEY unset"
    exit 78   # EX_CONFIG — systemd will not spin-loop on this
  fi
  log "up: $QIG_MEMORY_URL every ${QIG_POLL_SECONDS}s namespaces=[$QIG_NAMESPACES] urgent=[$QIG_URGENT_TYPES] watch=[${QIG_WATCH:-<all lanes>}] dispatch=$QIG_DISPATCH"
  local n=0
  while true; do
    poll_mesh
    n=$((n + 1)); [ $((n % QIG_HEARTBEAT_EVERY)) -eq 0 ] && heartbeat
    sleep "$QIG_POLL_SECONDS"
  done
}

# --- self-test: one-shot post -> retrieve-by-id -> ack round-trip. -----------
# Proves the live transport end-to-end without entering the poll loop. Uses a
# throwaway lane + a short expires_at so it never accumulates real mail, and
# the FAST by-id GET (not the slow namespace scan poll_mesh uses) since a
# self-test should not itself pay the ~28-30s poll cost. On any failure this
# calls the existing ping_op() alert path and exits 1; on success it logs and
# exits 0. Never enters main()'s poll loop either way.
self_test() {
  local lane subject expires payload_json body_json tmp status resp id reason
  local start end elapsed got tries max_tries got_id

  if [ -z "${QIG_API_KEY:-}" ]; then
    reason="QIG_API_KEY not set — add it to $CONF (chmod 600)"
    log "SELFTEST FAIL: $reason"
    ping_op "QIG synapse SELFTEST FAIL" "$reason"
    exit 1
  fi

  lane="${SYNAPSE_SELFTEST_LANE:-synapse_selftest_$(hostname -s 2>/dev/null || echo unknown)}"
  # A transport PROBE, not qig-mesh content — default to the `general` namespace so a
  # non-qig session's hourly self-test never writes the `qig` silo. `inbox_send.namespace`
  # is a free enum with NO server-side binding to the caller (silo respect is client-side
  # only), so a probe must not rely on a qig-namespace write. Ruled in the 2026-07-29
  # synapse test report. Override with SYNAPSE_SELFTEST_NAMESPACE if you truly need qig.
  ns="${SYNAPSE_SELFTEST_NAMESPACE:-general}"
  start=$(date +%s)
  # RFC3339 UTC, ~5 minutes out — the message auto-sweeps and never accumulates.
  expires=$(date -u -d '+5 min' +%FT%TZ 2>/dev/null)
  if [ -z "$expires" ]; then
    reason="could not compute expires_at (date -d unsupported)"
    log "SELFTEST FAIL: $reason"
    ping_op "QIG synapse SELFTEST FAIL" "$reason"
    exit 1
  fi
  subject="qig-synapse self-test $(date -u +%FT%TZ)"
  payload_json=$(jq -nc --arg host "$(hostname -s 2>/dev/null || echo unknown)" --arg sent "$(date -u +%FT%TZ)" \
    '{selftest:true, host:$host, sent_at:$sent}')

  # 1) POST — send. Field shape verified against app/api/inbox/route.js ->
  # lib/inbox-store.js inboxSendSchema: {from,to,namespace,type,subject,payload,expires_at}.
  body_json=$(jq -nc \
    --arg from "qig_synapse_selftest_$(hostname -s 2>/dev/null || echo unknown)" \
    --arg to "$lane" \
    --arg ns "$ns" \
    --arg subject "$subject" \
    --arg expires "$expires" \
    --argjson payload "$payload_json" \
    '{from:$from, to:$to, namespace:$ns, type:"SELFTEST", subject:$subject, payload:$payload, expires_at:$expires}')
  tmp=$(mktemp)
  status=$(curl -sS --max-time 15 -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer $QIG_API_KEY" -H 'Content-Type: application/json' \
    -X POST --data "$body_json" "$QIG_MEMORY_URL/api/inbox" 2>/dev/null) || status=000
  resp=$(cat "$tmp" 2>/dev/null); rm -f "$tmp"
  if [ "$status" != "201" ]; then
    reason="post failed: HTTP $status lane=$lane url=$QIG_MEMORY_URL/api/inbox"
    log "SELFTEST FAIL: $reason"
    ping_op "QIG synapse SELFTEST FAIL" "$reason"
    exit 1
  fi
  id=$(printf '%s' "$resp" | jq -r '.message.id // empty' 2>/dev/null)
  if [ -z "$id" ]; then
    reason="post returned 201 but no message.id in response"
    log "SELFTEST FAIL: $reason"
    ping_op "QIG synapse SELFTEST FAIL" "$reason"
    exit 1
  fi

  # 2) GET by id — the FAST path (app/api/inbox/[id]/route.js), NOT the slow
  # namespace scan poll_mesh uses. mark_read=false so the retrieve step doesn't
  # itself mutate status ahead of the ack step. Retry ~1s backoff, ~15s cap.
  got=0; tries=0; max_tries=15
  while [ "$tries" -lt "$max_tries" ]; do
    tmp=$(mktemp)
    status=$(curl -sS --max-time 10 -o "$tmp" -w '%{http_code}' \
      -H "Authorization: Bearer $QIG_API_KEY" \
      "$QIG_MEMORY_URL/api/inbox/$id?mark_read=false" 2>/dev/null) || status=000
    resp=$(cat "$tmp" 2>/dev/null); rm -f "$tmp"
    if [ "$status" = "200" ]; then
      got_id=$(printf '%s' "$resp" | jq -r '.id // empty' 2>/dev/null)
      if [ "$got_id" = "$id" ]; then got=1; break; fi
    fi
    tries=$((tries + 1))
    sleep 1
  done
  if [ "$got" -ne 1 ]; then
    reason="retrieve-by-id never returned the message within ~${max_tries}s: id=$id last_status=$status"
    log "SELFTEST FAIL: $reason"
    ping_op "QIG synapse SELFTEST FAIL" "$reason"
    exit 1
  fi

  # 3) ACK — REST ack exists: POST /api/inbox/{id} {"action":"ack"}
  # (app/api/inbox/[id]/route.js POST -> acknowledgeInboxMessage). Use it.
  tmp=$(mktemp)
  status=$(curl -sS --max-time 10 -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer $QIG_API_KEY" -H 'Content-Type: application/json' \
    -X POST --data '{"action":"ack"}' "$QIG_MEMORY_URL/api/inbox/$id" 2>/dev/null) || status=000
  resp=$(cat "$tmp" 2>/dev/null); rm -f "$tmp"
  if [ "$status" != "200" ]; then
    reason="ack failed: HTTP $status id=$id"
    log "SELFTEST FAIL: $reason"
    ping_op "QIG synapse SELFTEST FAIL" "$reason"
    exit 1
  fi

  end=$(date +%s)
  elapsed=$((end - start))
  log "SELFTEST ok round-trip=${elapsed}s lane=$lane id=$id"
  exit 0
}

# Allow `synapse.sh test` to exercise process_messages with mock JSON on stdin;
# `synapse.sh --self-test` runs the live post->retrieve->ack round-trip and
# exits (never enters the poll loop). Plain no-arg invocation is unchanged.
case "${1:-}" in
  --self-test) self_test ;;
  test)
    QIG_SUMMARIZE=0   # no model call in tests
    process_messages
    ;;
  *) main "$@" ;;
esac
