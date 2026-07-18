#!/usr/bin/env bash
# Turnkey QIG synapse setup from ONE operator credential:
#   1. mint a NARROW (memory:read+write) key for the daemon, server-side
#   2. install + enable the daemon with it
#   3. optionally register the qig-memory MCP locally with the same key
#
#   bash setup.sh                 # RECOMMENDED — prompts for the key (input hidden)
#   ADD_MCP=0 bash setup.sh       # skip the `claude mcp add` step
#
# Avoid the inline `QIG_OP_KEY=... bash setup.sh` form: it records your admin key
# in shell history. If you must, prefix the command with a leading space under
# `HISTCONTROL=ignorespace`.
#
# QIG_OP_KEY must be a memory:admin / full-access qig-memory key (the one you use
# for the admin UI). It is used ONCE to mint the daemon's key and is NEVER written
# to disk (and is passed to curl via a 0600 temp config, not argv). The minted
# daemon key is memory:read+write only (poll + heartbeat); revoke it any time from
# the admin UI.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${QIG_MEMORY_URL:=https://quauntum.dev}"
ADD_MCP="${ADD_MCP:-1}"

command -v curl >/dev/null || { echo "setup: curl is required" >&2; exit 2; }
command -v jq   >/dev/null || { echo "setup: jq is required" >&2; exit 2; }

# 1) operator credential (never stored)
if [ -z "${QIG_OP_KEY:-}" ]; then
  printf 'Operator qig-memory key (memory:admin; input hidden): ' >&2
  read -rs QIG_OP_KEY; echo >&2
fi
[ -n "${QIG_OP_KEY:-}" ] || { echo "setup: QIG_OP_KEY is required" >&2; exit 2; }

# 2) mint the daemon's own scoped key. Pass the operator bearer via a 0600 temp
# config file consumed by `curl -K`, NOT via -H, so it never appears in ps/argv.
echo "Provisioning a scoped synapse-daemon key from $QIG_MEMORY_URL ..." >&2
authcfg="$(mktemp)"; chmod 600 "$authcfg"
printf 'header = "Authorization: Bearer %s"\n' "$QIG_OP_KEY" > "$authcfg"
resp="$(curl -fsS --max-time 30 -K "$authcfg" -X POST "$QIG_MEMORY_URL/api/keys/synapse" \
  -H 'Content-Type: application/json' \
  -d "{\"host\":\"$(hostname 2>/dev/null || echo host)\"}")" \
  || { rm -f "$authcfg"; echo "setup: mint request failed — is QIG_OP_KEY a memory:admin key?" >&2; exit 1; }
rm -f "$authcfg"
TOKEN="$(printf '%s' "$resp" | jq -r '.token // empty')"
[ -n "$TOKEN" ] || { echo "setup: server did not return a token" >&2; exit 1; }
echo "  minted: $(printf '%s' "$resp" | jq -r '.key.label // "synapse-daemon"') (memory:read, memory:write)" >&2

# 3) install the daemon with the minted key (install.sh never echoes it)
QIG_API_KEY="$TOKEN" bash "$HERE/install.sh"

# 4) optionally register the qig-memory MCP for local agents, using the same key
if [ "$ADD_MCP" = "1" ] && command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -qi 'qig-memory'; then
    echo "claude mcp: a qig-memory server is already registered — skipping add" >&2
  else
    if claude mcp add --transport http --scope user qig-memory "$QIG_MEMORY_URL/api/mcp" \
         --header "Authorization: Bearer $TOKEN" >/dev/null 2>&1; then
      echo "claude mcp: added qig-memory (user scope) with the minted key" >&2
    else
      echo "claude mcp: add failed — register it manually if you want the local MCP" >&2
    fi
  fi
fi

unset TOKEN QIG_OP_KEY
echo "Done." >&2
