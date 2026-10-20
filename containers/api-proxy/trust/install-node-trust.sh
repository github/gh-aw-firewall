#!/bin/sh
set -eu
# Use an argv preload, not only NODE_OPTIONS, so caller-supplied Node options
# cannot accidentally disable the policy in AWF-owned runtime images.
if [ ! -e /usr/local/bin/node-awf ]; then
    node_path=$(command -v node)
    mv "$node_path" /usr/local/bin/node-awf
    cat > "$node_path" <<'EOF'
#!/bin/sh
export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--require=/opt/awf/trust/node-trust.cjs"
exec /usr/local/bin/node-awf --require=/opt/awf/trust/node-trust.cjs "$@"
EOF
    chmod 0755 "$node_path"
fi
