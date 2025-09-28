import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'llm_gateway',
  max: 10
});

const ENC_KEY = process.env.CONFIG_ENCRYPTION_KEY || null;

async function q(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

export async function initDb() {
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await q(`
    CREATE TABLE IF NOT EXISTS ide_ssh_presets (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 22,
      username TEXT NOT NULL,
      auth_method TEXT NOT NULL CHECK (auth_method IN ('password','key')),
      password_enc BYTEA,
      password_plain TEXT,
      private_key_enc BYTEA,
      private_key_plain TEXT,
      passphrase_enc BYTEA,
      passphrase_plain TEXT,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);
}

function encOrPlain(columnEnc, columnPlain, val) {
  if (!val) return { enc: null, plain: null };
  if (ENC_KEY) return { enc: { col: columnEnc, val }, plain: { col: columnPlain, val: null } };
  return { enc: { col: columnEnc, val: null }, plain: { col: columnPlain, val } };
}

export async function listPresets() {
  const sql = `
    SELECT
      id, name, host, port, username, auth_method,
      CASE WHEN $1::text IS NOT NULL AND password_enc IS NOT NULL THEN (pgp_sym_decrypt(password_enc,$1))::text ELSE password_plain END AS password,
      CASE WHEN $1::text IS NOT NULL AND private_key_enc IS NOT NULL THEN (pgp_sym_decrypt(private_key_enc,$1))::text ELSE private_key_plain END AS private_key,
      CASE WHEN $1::text IS NOT NULL AND passphrase_enc IS NOT NULL THEN (pgp_sym_decrypt(passphrase_enc,$1))::text ELSE passphrase_plain END AS passphrase
    FROM ide_ssh_presets
    ORDER BY name ASC
  `;
  const { rows } = await q(sql, [ENC_KEY]);
  return rows;
}

export async function getPreset(id) {
  const sql = `
    SELECT
      id, name, host, port, username, auth_method,
      CASE WHEN $1::text IS NOT NULL AND password_enc IS NOT NULL THEN (pgp_sym_decrypt(password_enc,$1))::text ELSE password_plain END AS password,
      CASE WHEN $1::text IS NOT NULL AND private_key_enc IS NOT NULL THEN (pgp_sym_decrypt(private_key_enc,$1))::text ELSE private_key_plain END AS private_key,
      CASE WHEN $1::text IS NOT NULL AND passphrase_enc IS NOT NULL THEN (pgp_sym_decrypt(passphrase_enc,$1))::text ELSE passphrase_plain END AS passphrase
    FROM ide_ssh_presets WHERE id=$2
  `;
  const { rows } = await q(sql, [ENC_KEY, Number(id)]);
  return rows[0] || null;
}

export async function createPreset(p) {
  const pw = encOrPlain('password_enc','password_plain', p.password || null);
  const key = encOrPlain('private_key_enc','private_key_plain', p.private_key || null);
  const pp = encOrPlain('passphrase_enc','passphrase_plain', p.passphrase || null);

  // Build dynamic SQL depending on encryption mode
  const fields = ['name','host','port','username','auth_method',
    pw.enc.col, pw.plain.col, key.enc.col, key.plain.col, pp.enc.col, pp.plain.col, 'updated_at'
  ];
  const values = [
    p.name, p.host, p.port || 22, p.username, p.auth_method,
    pw.enc.val ? { enc: true, val: pw.enc.val } : null,
    pw.plain.val,
    key.enc.val ? { enc: true, val: key.enc.val } : null,
    key.plain.val,
    pp.enc.val ? { enc: true, val: pp.enc.val } : null,
    pp.plain.val,
    new Date()
  ];

  // Translate enc markers into pgp_sym_encrypt calls
  const placeholders = values.map((v, i) => {
    if (v && v.enc) return `pgp_sym_encrypt($${i+1}, $${values.length+1})`;
    return `$${i+1}`;
  });

  const sql = `
    INSERT INTO ide_ssh_presets (${fields.join(',')})
    VALUES (${placeholders.join(',')})
    RETURNING *
  `;
  const params = values.map(v => (v && v.enc) ? v.val : v);
  params.push(ENC_KEY); // last param for encryption calls
  const { rows } = await q(sql, params);
  return rows[0];
}

export async function updatePreset(id, p) {
  const pw = encOrPlain('password_enc','password_plain', p.password || null);
  const key = encOrPlain('private_key_enc','private_key_plain', p.private_key || null);
  const pp = encOrPlain('passphrase_enc','passphrase_plain', p.passphrase || null);

  const sets = [
    'name=$1','host=$2','port=$3','username=$4','auth_method=$5'
  ];
  const params = [p.name, p.host, p.port || 22, p.username, p.auth_method];

  function pushEncOrPlain(encPlain, nextIndexStart) {
    if (ENC_KEY) {
      sets.push(`${encPlain.enc.col}=pgp_sym_encrypt($${nextIndexStart}, $${nextIndexStart+1})`);
      sets.push(`${encPlain.plain.col}=NULL`);
      params.push(encPlain.enc.val || '');
      params.push(ENC_KEY);
      return nextIndexStart + 2;
    } else {
      sets.push(`${encPlain.enc.col}=NULL`);
      sets.push(`${encPlain.plain.col}=$${nextIndexStart}`);
      params.push(encPlain.plain.val || null);
      return nextIndexStart + 1;
    }
  }

  let idx = 6;
  idx = pushEncOrPlain(pw, idx);
  idx = pushEncOrPlain(key, idx);
  idx = pushEncOrPlain(pp, idx);
  sets.push(`updated_at=now()`);

  const sql = `UPDATE ide_ssh_presets SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`;
  params.push(Number(id));
  const { rows } = await q(sql, params);
  return rows[0];
}

export async function deletePreset(id) {
  await q(`DELETE FROM ide_ssh_presets WHERE id=$1`, [Number(id)]);
  return true;
}
