#!/usr/bin/env bash
# Install / update the QIG synapse daemon on this machine (systemd --user).
# Idempotent and safe to re-run. Never overwrites an existing synapse.env key.
#
#   bash install.sh                        # deploy + enable (existing/blank key)
#   QIG_API_KEY=qig_... bash install.sh    # also seed the key into a fresh env
#
# For turnkey server-side key provisioning, use setup.sh instead.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARE="$HOME/.local/share/qig-synapse"
CONF_DIR="$HOME/.config/qig"
UNIT_DIR="$HOME/.config/systemd/user"
CONF="$CONF_DIR/synapse.env"

mkdir -p "$SHARE" "$CONF_DIR" "$UNIT_DIR"

install -m 0755 "$HERE/synapse.sh" "$SHARE/synapse.sh"
install -m 0644 "$HERE/qig-synapse.service" "$UNIT_DIR/qig-synapse.service"
echo "installed: $SHARE/synapse.sh + $UNIT_DIR/qig-synapse.service"

if [ ! -f "$CONF" ]; then
  install -m 0600 "$HERE/synapse.env.example" "$CONF"
  echo "created: $CONF (chmod 600) from template"
else
  echo "kept existing: $CONF (not overwritten)"
fi

# Seed the key from the environment ONLY if the file's key is currently blank.
# Uses awk with the value from the environment so no shell/sed quoting can corrupt
# or leak it (the key is never printed).
if [ -n "${QIG_API_KEY:-}" ]; then
  if grep -Eq '^[[:space:]]*QIG_API_KEY=[^[:space:]]' "$CONF"; then
    echo "key: already set in $CONF (left as-is)"
  else
    tmp="$(mktemp)"
    KEY="$QIG_API_KEY" awk 'BEGIN{k=ENVIRON["KEY"]} /^[[:space:]]*QIG_API_KEY=/{print "QIG_API_KEY=" k; next} {print}' "$CONF" > "$tmp"
    install -m 0600 "$tmp" "$CONF"; rm -f "$tmp"
    echo "key: written into $CONF from \$QIG_API_KEY"
  fi
fi

systemctl --user daemon-reload
systemctl --user enable --now qig-synapse.service
loginctl enable-linger "$USER" >/dev/null 2>&1 || true

echo
if grep -Eq '^[[:space:]]*QIG_API_KEY=[^[:space:]]' "$CONF"; then
  echo "qig-synapse: $(systemctl --user is-active qig-synapse.service)"
  echo "logs: journalctl --user -u qig-synapse -f   (or: tail -f ~/.local/state/qig-synapse/synapse.log)"
else
  echo "qig-synapse installed, but QIG_API_KEY is EMPTY in $CONF."
  echo "Provision one with setup.sh, or paste a key and: systemctl --user restart qig-synapse"
fi
