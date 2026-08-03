#!/bin/bash
set -e
REMOTE="spetchal@192.168.1.108"
DEST="/home/spetchal/canvas-core"
cd "Canvas Display Hermes"
echo "=== Syncing core/ to main server ==="
tar czf - -C core src test package.json tsconfig.json Dockerfile docker-compose.yml .env.example .dockerignore | ssh "$REMOTE" "cd $DEST && tar xzf -"
echo "=== Rebuilding and restarting Core ==="
ssh "$REMOTE" "cd $DEST && docker compose up -d --build 2>&1" | tail -6
echo "=== Verifying health ==="
sleep 4
ssh "$REMOTE" "curl -s http://localhost:3100/health; echo"
echo "=== Checking providers ==="
ssh "$REMOTE" "curl -s http://localhost:3100/api/providers | python3 -m json.tool"
echo "=== Checking admin login ==="
ssh "$REMOTE" "curl -s -c /tmp/cookies.txt -X POST http://localhost:3100/api/admin/login -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"changeme\"}' && echo ' LOGIN_OK'"
echo "=== Checking devices ==="
ssh "$REMOTE" "CSRF=\$(grep csrf_token /tmp/cookies.txt | awk '{print \$7}'); curl -s -b /tmp/cookies.txt -H \"X-CSRF-Token: \$CSRF\" http://localhost:3100/api/admin/devices | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f\"Devices: {len(d[\"devices\"])} registered, Invitations: {len(d[\"invitations\"])}\")'"
echo "=== DEPLOY COMPLETE ==="