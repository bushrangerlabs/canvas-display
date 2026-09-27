const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://casaos:casaos@host.docker.internal:5432/canvas_core' });
const deviceId = process.argv[2];
const patch = JSON.parse(process.argv[3]);
(async () => {
  await pool.query(
    'UPDATE devices SET audio_config = COALESCE(audio_config, \'{}\'::jsonb) || $1::jsonb WHERE id = $2',
    [JSON.stringify(patch), deviceId],
  );
  const res = await pool.query('SELECT audio_config FROM devices WHERE id = $1', [deviceId]);
  console.log(JSON.stringify(res.rows[0]));
  await pool.end();
})().catch((error) => { console.error(error.message); process.exit(1); });
