#!/usr/bin/env node
// Replays supabase/migrations/*.sql exactly the way the Supabase CLI's `db push` / `db reset` do,
// without needing the CLI: the fast, offline tier of supabase/tests/replay/run.sh (the real, pinned
// CLI is the other tier).
//
// Mirrors apps/cli-go/pkg/migration in supabase/cli (read 2026-09-24):
//   - creates supabase_migrations.schema_migrations like CreateMigrationTable;
//   - applies only versions not yet recorded, in filename order (FindPendingMigrations matches by
//     VERSION only — file contents are never compared);
//   - per file: `RESET ALL`, then every statement as its own extended-protocol Parse/Bind/Describe/
//     Execute, followed by the INSERT of (version, name, statements), all in ONE pipeline closed by a
//     single Sync (ExecBatch -> pgconn.Batch). PostgreSQL runs such a pipeline as one implicit
//     transaction that is NOT a "transaction block": that is why a top-level LOCK TABLE fails and a
//     top-level SET LOCAL is ignored with a WARNING under the CLI, but not under `psql -1`.
// Stricter than the CLI in one respect: any WARNING from the server fails the run, so a silently
// ignored SET LOCAL (or similar) cannot pass unnoticed.
//
// Usage: node pipeline-replay.cjs --host H --port P --user U --password W --db D --dir MIGRATIONS_DIR
//        [--file SINGLE.sql]   apply just this file (as the CLI would, if its version is pending)
// Exit code 0 when every pending file applied cleanly; 1 otherwise. Prints one line per file.
'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---- arguments -------------------------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const k of ['host', 'port', 'user', 'password', 'db']) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

// ---- statement splitting (semicolons outside comments, quotes and dollar quotes) -------------------
function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol < 0 ? n : eol + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') (depth++, (i += 2));
        else if (sql[i] === '*' && sql[i + 1] === '/') (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
    } else if (c === '$' && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        if (close < 0) throw new Error(`unterminated dollar quote ${m[0]}`);
        i = close + m[0].length;
      } else i++;
    } else if (c === ';') {
      out.push(sql.slice(start, i + 1));
      i++;
      start = i;
    } else i++;
  }
  out.push(sql.slice(start));
  // Like parser.SplitAndTrim: trim, and drop what is only whitespace or comments.
  return out
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/;$/, '').trim() !== '');
}

// ---- minimal PostgreSQL wire protocol client --------------------------------------------------------
class Pg {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
    sock.on('error', (e) => this.waiters.splice(0).forEach((w) => w.reject(e)));
  }
  pump() {
    while (this.waiters.length && this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const msg = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, 1 + len) };
      this.buf = this.buf.subarray(1 + len);
      this.waiters.shift().resolve(msg);
    }
  }
  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.pump();
    });
  }
  send(type, body) {
    const head = Buffer.alloc(type ? 5 : 4);
    if (type) head.write(type, 0);
    head.writeInt32BE(body.length + 4, type ? 1 : 0);
    this.sock.write(Buffer.concat([head, body]));
  }
}
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const int16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v);
  return b;
};
const int32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};
function fields(body) {
  const out = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const code = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    out[code] = body.subarray(i + 1, end).toString('utf8');
    i = end + 1;
  }
  return out;
}

async function connect() {
  const sock = net.connect(Number(args.port), args.host);
  await new Promise((resolve, reject) => (sock.once('connect', resolve), sock.once('error', reject)));
  const pg = new Pg(sock);
  pg.send(null, Buffer.concat([int32(196608), cstr('user'), cstr(args.user), cstr('database'), cstr(args.db), Buffer.from([0])]));
  let scram = null;
  for (;;) {
    const m = await pg.read();
    if (m.type === 'E') throw new Error(`connect: ${fields(m.body).M}`);
    if (m.type === 'Z') return pg;
    if (m.type !== 'R') continue;
    const code = m.body.readInt32BE(0);
    if (code === 0) continue;
    if (code === 3) pg.send('p', cstr(args.password));
    else if (code === 5) {
      const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
      pg.send('p', cstr('md5' + md5(Buffer.concat([Buffer.from(md5(args.password + args.user)), m.body.subarray(4, 8)]))));
    } else if (code === 10) {
      const nonce = crypto.randomBytes(18).toString('base64');
      const first = `n=,r=${nonce}`;
      scram = { nonce, first };
      const msg = Buffer.from(`n,,${first}`);
      pg.send('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(msg.length), msg]));
    } else if (code === 11) {
      const server = m.body.subarray(4).toString();
      const attrs = Object.fromEntries(server.split(',').map((kv) => [kv[0], kv.slice(2)]));
      const salted = crypto.pbkdf2Sync(args.password, Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
      const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const withoutProof = `c=biws,r=${attrs.r}`;
      const authMessage = `${scram.first},${server},${withoutProof}`;
      const signature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
      const proof = Buffer.from(clientKey.map((b, k) => b ^ signature[k])).toString('base64');
      pg.send('p', Buffer.from(`${withoutProof},p=${proof}`));
    } else if (code === 12) continue;
    else throw new Error(`unsupported authentication request ${code}`);
  }
}

/** One simple-protocol query; returns rows (text) or throws on error. */
async function simple(pg, sql) {
  pg.send('Q', cstr(sql));
  const rows = [];
  let error = null;
  for (;;) {
    const m = await pg.read();
    if (m.type === 'D') {
      const cols = m.body.readInt16BE(0);
      const row = [];
      let off = 2;
      for (let c = 0; c < cols; c++) {
        const len = m.body.readInt32BE(off);
        off += 4;
        row.push(len < 0 ? null : m.body.subarray(off, off + len).toString('utf8'));
        off += Math.max(len, 0);
      }
      rows.push(row);
    } else if (m.type === 'E') error = fields(m.body);
    else if (m.type === 'Z') break;
  }
  if (error) throw new Error(`${error.S}: ${error.M}`);
  return rows;
}

const textArray = (items) => '{' + items.map((s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';

/** One migration file as ONE pipeline: every statement + the ledger insert, then a single Sync. */
async function applyFile(pg, file) {
  const base = path.basename(file);
  const [, version, name] = /^([0-9]+)_(.*)\.sql$/.exec(base);
  const statements = splitStatements(fs.readFileSync(file, 'utf8'));
  await simple(pg, 'RESET ALL');
  for (const sql of statements) {
    pg.send('P', Buffer.concat([cstr(''), cstr(sql), int16(0)]));
    pg.send('B', Buffer.concat([cstr(''), cstr(''), int16(0), int16(0), int16(0)]));
    pg.send('D', Buffer.concat([Buffer.from('P'), cstr('')]));
    pg.send('E', Buffer.concat([cstr(''), int32(0)]));
  }
  const params = [version, name, textArray(statements)].map((v) => Buffer.from(v, 'utf8'));
  pg.send('P', Buffer.concat([cstr(''), cstr('INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)'), int16(3), int32(25), int32(25), int32(1009)]));
  pg.send('B', Buffer.concat([cstr(''), cstr(''), int16(0), int16(3), ...params.flatMap((p) => [int32(p.length), p]), int16(0)]));
  pg.send('E', Buffer.concat([cstr(''), int32(0)]));
  pg.send('S', Buffer.alloc(0));

  let completed = 0;
  let error = null;
  const warnings = [];
  for (;;) {
    const m = await pg.read();
    if (m.type === 'C') completed++;
    else if (m.type === 'E') error = fields(m.body);
    else if (m.type === 'N') {
      const f = fields(m.body);
      if (f.V === 'WARNING') warnings.push(f.M);
    } else if (m.type === 'Z') {
      const status = String.fromCharCode(m.body[0]);
      if (error) {
        const extra = [error.D && `DETAIL: ${error.D}`, error.H && `HINT: ${error.H}`].filter(Boolean).join('\n');
        return {
          ok: false,
          base,
          detail: `${error.S} ${error.C}: ${error.M} (at statement ${completed + 1} of ${statements.length})${extra ? '\n' + extra : ''}`,
        };
      }
      if (status !== 'I') return { ok: false, base, detail: `pipeline ended in transaction status ${status}` };
      if (warnings.length) return { ok: false, base, detail: `WARNING: ${warnings.join(' | ')}` };
      return { ok: true, base, detail: `${statements.length} statements + ledger row in one pipeline` };
    }
  }
}

(async () => {
  const pg = await connect();
  for (const sql of [
    'CREATE SCHEMA IF NOT EXISTS supabase_migrations',
    'CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)',
    'ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]',
    'ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text',
  ]) {
    await simple(pg, sql);
  }
  const applied = new Set((await simple(pg, 'SELECT version FROM supabase_migrations.schema_migrations')).map((r) => r[0]));
  const files = args.file
    ? [args.file]
    : fs
        .readdirSync(args.dir)
        .filter((f) => /^[0-9]+_.*\.sql$/.test(f))
        .sort()
        .map((f) => path.join(args.dir, f));
  let failed = false;
  let appliedNow = 0;
  for (const file of files) {
    const version = /^([0-9]+)_/.exec(path.basename(file))[1];
    if (applied.has(version)) {
      console.log(`skip   ${path.basename(file)} (version ${version} already recorded)`);
      continue;
    }
    const r = await applyFile(pg, file);
    console.log(`${r.ok ? 'apply ' : 'FAIL  '} ${r.base}: ${r.detail}`);
    if (!r.ok) {
      failed = true;
      break;
    }
    appliedNow++;
  }
  console.log(`${appliedNow} applied${failed ? ', stopped at the first failure' : ''}`);
  pg.sock.end();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
