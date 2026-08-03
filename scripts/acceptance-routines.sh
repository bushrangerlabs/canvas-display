#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_HOST=""
RESTART_CHECK=0
RESTORE_CHECK=0
HARDWARE_REPORT=""
HARDWARE_DEVICE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live-host) LIVE_HOST="${2:?--live-host requires user@host}"; shift 2 ;;
    --restart-check) RESTART_CHECK=1; shift ;;
    --restore-check) RESTORE_CHECK=1; shift ;;
    --hardware-report) HARDWARE_REPORT="${2:?--hardware-report requires a JSON file}"; shift 2 ;;
    --hardware-device) HARDWARE_DEVICE="${2:?--hardware-device requires a device ID}"; shift 2 ;;
    --help) echo "Usage: bash scripts/acceptance-routines.sh [--live-host user@core-host] [--restart-check] [--restore-check] [--hardware-report REPORT.json --hardware-device DEVICE_ID]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$LIVE_HOST" && ( "$RESTART_CHECK" -eq 1 || "$RESTORE_CHECK" -eq 1 ) ]]; then
  echo "--restart-check and --restore-check require --live-host" >&2
  exit 2
fi
if [[ -n "$HARDWARE_REPORT" || -n "$HARDWARE_DEVICE" ]]; then
  [[ -n "$HARDWARE_REPORT" && -n "$HARDWARE_DEVICE" ]] || { echo "--hardware-report and --hardware-device must be provided together" >&2; exit 2; }
  [[ "$HARDWARE_DEVICE" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || { echo "invalid --hardware-device" >&2; exit 2; }
fi

echo "[routines] validating contracts"
npm --prefix "$REPO_ROOT" run contracts:validate
echo "[routines] testing physical evidence validator"
npx --prefix "$REPO_ROOT" tsx --test "$REPO_ROOT/scripts/validate-pi-acceptance.test.ts"
echo "[routines] running Core type-check and tests"
npm --prefix "$REPO_ROOT/core" run type-check
npm --prefix "$REPO_ROOT/core" test
echo "[routines] building admin UI"
npm --prefix "$REPO_ROOT/web" run build
if [[ -n "$HARDWARE_REPORT" ]]; then
  echo "[routines] validating physical Pi acceptance evidence"
  npx --prefix "$REPO_ROOT" tsx "$REPO_ROOT/scripts/validate-pi-acceptance.ts" "$HARDWARE_REPORT" --device "$HARDWARE_DEVICE"
fi

if [[ -n "$LIVE_HOST" ]]; then
  echo "[routines] checking live Core health and Pi connectivity"
  ssh "$LIVE_HOST" 'curl -fsS http://127.0.0.1:3101/health >/dev/null'
  # Filter connection/acceptance events on the host. High-frequency HA polling can
  # otherwise push valid recent device connections out of a small tail window.
  LIVE_LOGS="$(ssh "$LIVE_HOST" 'cd /home/spetchal/canvas-core/core && docker compose logs --since=1h canvas-core 2>&1 | grep -E "device connected:|browser connected|ERROR.*\\[core\\]\\[routines\\]|routine.*migration.*failed" || true')"
  grep -q 'device connected:' <<<"$LIVE_LOGS"
  grep -q 'browser connected' <<<"$LIVE_LOGS"
  if [[ -n "$HARDWARE_DEVICE" ]]; then
    DEVICE_STATE="$(ssh "$LIVE_HOST" "docker exec postgresql psql -U casaos -d canvas_core -Atc \"SELECT paired::text||'|'||COALESCE(status,'')||'|'||(revoked_at IS NULL)::text FROM devices WHERE id='$HARDWARE_DEVICE'\"")"
    [[ "$DEVICE_STATE" == 'true|connected|true' ]] || { echo "[routines] hardware evidence device is not paired, connected, and unrevoked" >&2; exit 1; }
    grep -Fq "device connected: $HARDWARE_DEVICE" <<<"$LIVE_LOGS" || { echo "[routines] hardware evidence device has no recent Edge connection" >&2; exit 1; }
    grep -Fq "browser connected (device=$HARDWARE_DEVICE)" <<<"$LIVE_LOGS" || { echo "[routines] hardware evidence device has no recent kiosk connection" >&2; exit 1; }
    echo "[routines] physical evidence is bound to the paired, live Edge and kiosk identity"
  fi
  if grep -qE 'ERROR.*\[core\]\[routines\]|routine.*migration.*failed' <<<"$LIVE_LOGS"; then
    echo "[routines] live routine errors detected" >&2
    exit 1
  fi
  echo "[routines] checking live content-addressed asset integrity"
  ssh "$LIVE_HOST" 'bash -s' <<'REMOTE_ASSETS'
set -euo pipefail
docker inspect canvas-core-canvas-core-1 --format '{{range .Mounts}}{{if eq .Destination "/app/data/assets"}}{{.Name}}{{end}}{{end}}' | grep -q '^canvas-core-assets$'
while IFS='|' read -r asset_id expected_size; do
  [[ -n "$asset_id" ]] || continue
  hash="${asset_id#sha256:}"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]]
  actual_hash="$(docker exec canvas-core-canvas-core-1 sha256sum "/app/data/assets/$hash" | awk '{print $1}')"
  actual_size="$(docker exec canvas-core-canvas-core-1 sh -c "wc -c < '/app/data/assets/$hash'" | tr -d ' ')"
  [[ "$actual_hash" == "$hash" && "$actual_size" == "$expected_size" ]]
done < <(docker exec postgresql psql -U casaos -d canvas_core -Atc "SELECT id,size FROM assets ORDER BY id")
REMOTE_ASSETS
  echo "[routines] live asset volume and referenced object hashes verified"
  if [[ "$RESTART_CHECK" -eq 1 ]]; then
    snapshot() {
      ssh "$LIVE_HOST" "docker exec postgresql psql -U casaos -d canvas_core -Atc \"SELECT 'routines='||count(*) FROM routines UNION ALL SELECT 'revisions='||count(*) FROM routine_revisions UNION ALL SELECT 'executions='||count(*) FROM routine_executions UNION ALL SELECT 'learning='||count(*) FROM routine_plan_learning UNION ALL SELECT 'devices='||count(*) FROM devices UNION ALL SELECT 'credentials='||count(*) FROM device_credentials UNION ALL SELECT 'invitations='||count(*) FROM device_invitations UNION ALL SELECT 'scenes='||count(*) FROM scenes UNION ALL SELECT 'settings='||count(*) FROM settings;\""
    }
    BEFORE="$(snapshot)"
    SEED_BEFORE="$(ssh "$LIVE_HOST" "docker inspect canvas-core-canvas-core-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^CANVAS_CORE_ENROLLMENT_SEED=//p' | sha256sum | cut -d ' ' -f1")"
    EPOCH_BEFORE="$(ssh "$LIVE_HOST" "docker inspect canvas-core-canvas-core-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^CANVAS_CORE_SECURITY_EPOCH=//p'")"
    [[ "$EPOCH_BEFORE" =~ ^[1-9][0-9]*$ ]]
    echo "[routines] restarting Core application container only"
    ssh "$LIVE_HOST" 'cd /home/spetchal/canvas-core/core && docker compose restart canvas-core >/dev/null'
    READY=0
    for _ in {1..30}; do
      if ssh "$LIVE_HOST" 'curl -fsS http://127.0.0.1:3101/health >/dev/null' 2>/dev/null; then READY=1; break; fi
      sleep 1
    done
    [[ "$READY" -eq 1 ]] || { echo "[routines] Core did not become healthy after restart" >&2; exit 1; }
    AFTER="$(snapshot)"
    [[ "$BEFORE" == "$AFTER" ]] || { echo "[routines] persistent row counts changed across restart" >&2; diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") >&2; exit 1; }
    SEED_AFTER="$(ssh "$LIVE_HOST" "docker inspect canvas-core-canvas-core-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^CANVAS_CORE_ENROLLMENT_SEED=//p' | sha256sum | cut -d ' ' -f1")"
    EPOCH_AFTER="$(ssh "$LIVE_HOST" "docker inspect canvas-core-canvas-core-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^CANVAS_CORE_SECURITY_EPOCH=//p'")"
    [[ "$SEED_BEFORE" != 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' && "$SEED_BEFORE" == "$SEED_AFTER" ]]
    [[ "$EPOCH_BEFORE" == "$EPOCH_AFTER" ]]
    for _ in {1..30}; do
      LIVE_LOGS="$(ssh "$LIVE_HOST" 'cd /home/spetchal/canvas-core/core && docker compose logs --since=2m canvas-core')"
      if grep -q 'device connected:' <<<"$LIVE_LOGS" && grep -q 'browser connected' <<<"$LIVE_LOGS"; then READY=2; break; fi
      sleep 1
    done
    [[ "$READY" -eq 2 ]] || { echo "[routines] Edge Agent or kiosk did not reconnect after restart" >&2; exit 1; }
    echo "[routines] restart persistence and device reconnection passed"
  fi
  if [[ "$RESTORE_CHECK" -eq 1 ]]; then
    echo "[routines] running isolated PostgreSQL backup/restore drill"
    ssh "$LIVE_HOST" 'bash -s' <<'REMOTE_RESTORE'
set -euo pipefail
RESTORE_DB="canvas_routine_restore_$(date +%Y%m%d%H%M%S)_$$"
VERIFY_DB="${RESTORE_DB}_verify"
ASSET_VOL="${RESTORE_DB}_assets"
VERIFY_ASSET_VOL="${RESTORE_DB}_assets_verify"
DUMP_PATH="/tmp/${RESTORE_DB}.dump"
SEEDED_DUMP_PATH="/tmp/${VERIFY_DB}.dump"
[[ "$RESTORE_DB" =~ ^canvas_routine_restore_[0-9]+_[0-9]+$ ]]
[[ "$VERIFY_DB" =~ ^canvas_routine_restore_[0-9]+_[0-9]+_verify$ ]]
[[ "$ASSET_VOL" =~ ^canvas_routine_restore_[0-9]+_[0-9]+_assets$ ]]
[[ "$VERIFY_ASSET_VOL" =~ ^canvas_routine_restore_[0-9]+_[0-9]+_assets_verify$ ]]
cleanup() {
  docker volume rm -f "$VERIFY_ASSET_VOL" "$ASSET_VOL" >/dev/null 2>&1 || true
  docker exec postgresql dropdb -U casaos --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
  docker exec postgresql dropdb -U casaos --if-exists "$RESTORE_DB" >/dev/null 2>&1 || true
  docker exec postgresql sh -c "rm -f '$DUMP_PATH' '$SEEDED_DUMP_PATH'" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker exec postgresql pg_dump -U casaos -d canvas_core -Fc -f "$DUMP_PATH"
docker exec postgresql createdb -U casaos "$RESTORE_DB"
docker exec postgresql pg_restore -U casaos -d "$RESTORE_DB" --no-owner "$DUMP_PATH"
COUNT_SQL="SELECT 'routines='||count(*) FROM routines UNION ALL SELECT 'revisions='||count(*) FROM routine_revisions UNION ALL SELECT 'executions='||count(*) FROM routine_executions UNION ALL SELECT 'steps='||count(*) FROM routine_step_results UNION ALL SELECT 'learning='||count(*) FROM routine_plan_learning UNION ALL SELECT 'devices='||count(*) FROM devices UNION ALL SELECT 'credentials='||count(*) FROM device_credentials UNION ALL SELECT 'invitations='||count(*) FROM device_invitations UNION ALL SELECT 'scenes='||count(*) FROM scenes UNION ALL SELECT 'settings='||count(*) FROM settings ORDER BY 1;"
SOURCE="$(docker exec postgresql psql -U casaos -d canvas_core -Atc "$COUNT_SQL")"
RESTORED="$(docker exec postgresql psql -U casaos -d "$RESTORE_DB" -Atc "$COUNT_SQL")"
[[ "$SOURCE" == "$RESTORED" ]] || { echo 'restored database inventory mismatch' >&2; diff <(printf '%s\n' "$SOURCE") <(printf '%s\n' "$RESTORED") >&2; exit 1; }
docker exec postgresql psql -U casaos -d "$RESTORE_DB" -Atc "SELECT count(*) FROM routine_revisions rr LEFT JOIN routines r ON r.id=rr.routine_id WHERE r.id IS NULL;" | grep -qx '0'
docker exec postgresql psql -U casaos -d "$RESTORE_DB" -Atc "SELECT count(*) FROM routine_executions e LEFT JOIN routine_revisions rr ON rr.id=e.revision_id WHERE rr.id IS NULL;" | grep -qx '0'
docker exec postgresql psql -U casaos -d "$RESTORE_DB" -Atc "SELECT count(*) FROM device_credentials c LEFT JOIN devices d ON d.id=c.device_id WHERE d.id IS NULL;" | grep -qx '0'
docker exec -i postgresql psql -v ON_ERROR_STOP=1 -U casaos -d "$RESTORE_DB" >/dev/null <<'SEED_SQL'
INSERT INTO routines(id,name,description,owner,status,created_at,updated_at)
VALUES('acceptance-routine','Acceptance restore routine','Synthetic clean-room evidence','canvas_core','enabled',now(),now());
INSERT INTO routine_revisions(id,routine_id,revision,definition,status,creation_source,validation_errors,created_at,enabled_at)
VALUES('acceptance-revision','acceptance-routine',1,'{"schemaVersion":1,"name":"Acceptance restore routine","description":"Synthetic clean-room evidence","owner":"canvas_core","triggers":[{"type":"voice","phrases":["acceptance restore"]}],"inputs":{},"steps":[{"id":"result_1","kind":"result","config":{"message":"accepted"}}],"result":{"speech":"accepted"},"limits":{"timeoutMs":30000,"maxSteps":5,"maxRoutineDepth":3}}'::jsonb,'enabled','acceptance_fixture','[]'::jsonb,now(),now());
UPDATE routines SET active_revision_id='acceptance-revision' WHERE id='acceptance-routine';
INSERT INTO routine_executions(id,routine_id,revision_id,correlation_id,idempotency_key,origin,principal,status,inputs,result,started_at,finished_at)
VALUES('acceptance-execution','acceptance-routine','acceptance-revision','acceptance-correlation','acceptance-idempotency','acceptance','acceptance_runner','successful','{}'::jsonb,'{"message":"accepted"}'::jsonb,now(),now());
INSERT INTO routine_step_results(id,execution_id,step_id,step_index,kind,status,input,output,started_at,finished_at,duration_ms)
VALUES('acceptance-step','acceptance-execution','result_1',0,'result','successful','{"message":"accepted"}'::jsonb,'{"message":"accepted"}'::jsonb,now(),now(),1);
INSERT INTO routine_plan_learning(signature,normalized_phrase,plan,success_count,status,routine_id,fast_path_hits,last_fast_path_ms,origin_devices)
VALUES('acceptance-learning','acceptance restore','[{"tool":"query.status","args":{}}]'::jsonb,3,'drafted','acceptance-routine',2,5,'["acceptance-device"]'::jsonb);
SEED_SQL
docker exec postgresql pg_dump -U casaos -d "$RESTORE_DB" -Fc -f "$SEEDED_DUMP_PATH"
docker exec postgresql createdb -U casaos "$VERIFY_DB"
docker exec postgresql pg_restore -U casaos -d "$VERIFY_DB" --no-owner "$SEEDED_DUMP_PATH"
DIGEST_SQL="SELECT md5(string_agg(row_to_json(x)::text,'|' ORDER BY kind,id)) FROM (SELECT 'routine' AS kind,id,name||':'||status AS value FROM routines WHERE id='acceptance-routine' UNION ALL SELECT 'revision',id,definition::text FROM routine_revisions WHERE id='acceptance-revision' UNION ALL SELECT 'execution',id,status||':'||COALESCE(result::text,'') FROM routine_executions WHERE id='acceptance-execution' UNION ALL SELECT 'step',id,status||':'||COALESCE(output::text,'') FROM routine_step_results WHERE id='acceptance-step' UNION ALL SELECT 'learning',signature,status||':'||success_count||':'||fast_path_hits FROM routine_plan_learning WHERE signature='acceptance-learning') x;"
SEEDED_DIGEST="$(docker exec postgresql psql -U casaos -d "$RESTORE_DB" -Atc "$DIGEST_SQL")"
VERIFIED_DIGEST="$(docker exec postgresql psql -U casaos -d "$VERIFY_DB" -Atc "$DIGEST_SQL")"
[[ -n "$SEEDED_DIGEST" && "$SEEDED_DIGEST" == "$VERIFIED_DIGEST" ]]
docker exec postgresql psql -U casaos -d "$VERIFY_DB" -Atc "SELECT count(*) FROM routine_executions e JOIN routine_revisions rr ON rr.id=e.revision_id JOIN routines r ON r.id=e.routine_id WHERE e.id='acceptance-execution' AND r.active_revision_id=rr.id;" | grep -qx '1'
docker volume create "$ASSET_VOL" >/dev/null
docker volume create "$VERIFY_ASSET_VOL" >/dev/null
ASSET_TEXT='Canvas clean-room asset restore evidence'
ASSET_HASH="$(printf '%s' "$ASSET_TEXT" | sha256sum | awk '{print $1}')"
printf '%s' "$ASSET_TEXT" | docker run --rm -i -v "$ASSET_VOL:/assets" alpine sh -c "cat > '/assets/$ASSET_HASH'"
docker run --rm -v "$ASSET_VOL:/source:ro" alpine tar -C /source -cf - . | docker run --rm -i -v "$VERIFY_ASSET_VOL:/target" alpine tar -C /target -xf -
RESTORED_HASH="$(docker run --rm -v "$VERIFY_ASSET_VOL:/assets:ro" alpine sha256sum "/assets/$ASSET_HASH" | awk '{print $1}')"
RESTORED_SIZE="$(docker run --rm -v "$VERIFY_ASSET_VOL:/assets:ro" alpine wc -c "/assets/$ASSET_HASH" | awk '{print $1}')"
[[ "$RESTORED_HASH" == "$ASSET_HASH" && "$RESTORED_SIZE" == "${#ASSET_TEXT}" ]]
echo '[routines] isolated inventory, non-empty routine history, and asset-object restore verified'
REMOTE_RESTORE
    echo "[routines] clean-room PostgreSQL restore passed and temporary database was removed"
  fi
fi

echo "[routines] automated acceptance passed"
echo "[routines] physical hardware observations and approved recovery/security evidence remain manual gates; see docs/ROUTINES_OPERATIONS_ACCEPTANCE.md"
