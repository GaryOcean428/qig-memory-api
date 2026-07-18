# QIG synapse daemon — auto-installer

The **synapse** is the always-on lane of the QIG mesh: a tiny systemd `--user`
daemon that polls the whole qig-memory inbox and desktop-pings the operator the
moment an *urgent* envelope (`DIRECTIVE` / `BLOCKER` / `HANDOFF` / `RULING-REQUEST`)
lands, naming the receiving lane and whether it is **live** or **DARK** from its
`qig_presence_<handle>` record. It **routes and echoes only** — a verbatim
subject-echo, never an interpretive summary (protocol v1.4: a composing router
drifts into an oracle). The durable per-lane queue is the inbox itself; the
synapse only removes next-session latency.

## Quick start (turnkey)

```bash
bash setup.sh      # prompts for your operator key (input hidden)
```

(Avoid the inline `QIG_OP_KEY=... bash setup.sh` form — it lands your admin key in
shell history.) `setup.sh` uses your operator key **once** to mint a *narrow* `memory:read+write`
key for the daemon (server-side, via `POST /api/keys/synapse`), installs + enables
the daemon with it, and — unless `ADD_MCP=0` — registers the `qig-memory` MCP
locally with the same key. Your operator key is never written to disk; the minted
daemon key is revocable from the admin UI like any other.

## Manual install (bring your own key)

```bash
QIG_API_KEY=qig_<a-read+write-key> bash install.sh
# or: bash install.sh  then paste the key into ~/.config/qig/synapse.env and
#     systemctl --user restart qig-synapse
```

`install.sh` is idempotent and never overwrites an existing key in
`~/.config/qig/synapse.env`.

## What gets installed

| Path | What |
|---|---|
| `~/.local/share/qig-synapse/synapse.sh` | the daemon |
| `~/.config/systemd/user/qig-synapse.service` | the unit (`Restart=always`, `RestartPreventExitStatus=78`) |
| `~/.config/qig/synapse.env` | config (chmod 600) — from `synapse.env.example` if absent |
| `~/.local/state/qig-synapse/` | `seen-ids.txt` + `synapse.log` (no secrets in the log) |

Linger is enabled so it survives logout.

## The key-mint endpoint

`POST /api/keys/synapse` (admin-gated) mints a **scoped, revocable** daemon key:

- Auth: a `memory:admin` / full-access bearer (the same privilege the admin UI's
  "create key" already requires — it does not widen what an admin can do).
- Returns a `memory:read + memory:write` token **once** (poll the inbox + write the
  `qig_synapse_heartbeat`; never admin/delete). Only its SHA-256 hash is stored.
- Revoke it from the admin UI, or re-run `setup.sh` to rotate.

## Control

```bash
systemctl --user status qig-synapse
systemctl --user restart qig-synapse            # after editing synapse.env
journalctl --user -u qig-synapse -f             # or: tail -f ~/.local/state/qig-synapse/synapse.log
```

## Config (synapse.env)

`QIG_URGENT_TYPES` (what pings), `QIG_WATCH` (optional lane allow-list; empty = all),
`QIG_PRESENCE_STALE_MIN` (live/DARK threshold), and the summariser knobs
`QIG_SUMMARIZE_BACKEND` (`ollama` default | `claude` | `none`),
`QIG_OLLAMA_MODEL`, `QIG_OLLAMA_KEEPALIVE` (`0` = unload immediately, near-zero idle
RAM). The daemon sends `think:false` + a verbatim-echo prompt, so a small fast
local model (e.g. `liquidai/lfm2.5-1.2b-instruct`) is the intended fit.

See also: memory key `qig-synapse-daemon`, protocol `qig_interagent_protocol` (v1.4),
presence spec `qig_agent_presence_protocol`.
