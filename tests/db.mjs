/* ============================================================================
 * Netheraxia — real-Postgres tests for supabase/schema.sql
 *
 * The DOM harness in run.mjs cannot catch database bugs: a trigger that
 * silently reverts a write, or an RLS policy that hides a row, both look
 * like success from JavaScript. Round 14 shipped exactly that bug, so the
 * schema now gets executed against a genuine PostgreSQL server.
 *
 *   pip install --break-system-packages pgserver
 *   node tests/db.mjs
 *
 * Skips (exit 0) when pgserver is unavailable, so it never blocks CI.
 * ==========================================================================*/
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass++; console.log('  \u001b[32m✅\u001b[0m ' + label); }
  else { fail++; console.log('  \u001b[31m❌\u001b[0m ' + label + (extra ? '\n     ' + extra : '')); }
};
const section = t => console.log('\n── ' + t + ' ──');

try {
  execFileSync('python3', ['-c', 'import pgserver'], { stdio: 'ignore' });
} catch {
  console.log('⏭️  pgserver not installed — skipping database tests.');
  console.log('   pip install --break-system-packages pgserver');
  process.exit(0);
}

// Minimal stand-in for the Supabase pieces the schema depends on.
const SHIM = `
create schema if not exists auth;
create schema if not exists extensions;
create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    encrypted_password text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create or replace function public.crypt(text,text) returns text
  language sql immutable as $$ select md5($1||$2) $$;
create or replace function extensions.crypt(text,text) returns text
  language sql immutable as $$ select md5($1||$2) $$;
do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
`;

const dir = mkdtempSync(join(tmpdir(), 'nxdb-'));
const runner = join(dir, 'run.py');
writeFileSync(runner, `
import sys, pathlib, pgserver
db = pgserver.get_server(pathlib.Path(sys.argv[1]))
sys.stdout.write(db.psql(sys.stdin.read()))
`);

// psql sends NOTICE output to stderr, and the raise-notice assertions below
// depend on it, so both streams are returned together.
const sql = (data, text) => {
  const r = spawnSync('python3', [runner, join(dir, data)],
    { input: text, encoding: 'utf8' });
  if (r.error) return 'PSQL_ERROR: ' + r.error.message;
  const out = (r.stdout || '') + (r.stderr || '');
  return r.status === 0 ? out : 'PSQL_ERROR: ' + out;
};

const schemaOf = ref => {
  const raw = ref === 'HEAD'
    ? readFileSync(join(ROOT, 'supabase/schema.sql'), 'utf8')
    : execFileSync('git', ['show', ref + ':supabase/schema.sql'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  return raw.replace('create extension if not exists pgcrypto;', '');
};

const NEW = schemaOf('HEAD');
const register = (name, mail) => `insert into auth.users (email, raw_user_meta_data)
  values ('${mail}', '{"mc_username":"${name}"}'::jsonb);`;
const asUser = name => `do $$ declare uid uuid; begin
  select id into uid from public.profiles where mc_username='${name}';
  perform set_config('request.jwt.claim.sub', uid::text, false);
end $$;`;

console.log('🐘 Netheraxia database tests (real PostgreSQL)');

/* ---------------------------------------------------------------- */
section('A. the schema runs end to end');
sql('a', SHIM);
const first = sql('a', NEW);
check('a fresh database accepts the whole file', !first.includes('PSQL_ERROR'),
  first.slice(0, 400));
const second = sql('a', NEW);
check('re-running it is safe (idempotent)', !second.includes('PSQL_ERROR'),
  second.slice(0, 400));
check('make_admin exists afterwards',
  sql('a', `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='make_admin';`).includes('1'));

/* ---------------------------------------------------------------- */
section('B. the admin bootstrap actually sticks');
sql('a', register('HyraxMC', 'h@mc.com'));
check('signing up creates a profile',
  sql('a', `select mc_username from public.profiles;`).includes('HyraxMC'));
check('the new player is not an admin yet',
  /HyraxMC\s*\|\s*f/.test(sql('a', `select mc_username, is_admin from public.profiles;`)));

const made = sql('a', `select public.make_admin('HyraxMC');`);
check('make_admin reports success', made.includes('انجام شد'));
check('and is_admin is really true afterwards',
  /HyraxMC\s*\|\s*t/.test(sql('a', `select mc_username, is_admin from public.profiles;`)),
  'this is the round-14 bug: the trigger reverted it silently');

const missing = sql('a', `do $$ begin perform public.make_admin('Ghost');
  exception when others then raise notice 'RAISED: %', sqlerrm; end $$;`);
check('an unregistered name raises a clear error, not silence',
  /RAISED:.*پیدا نشد/.test(missing));

/* ---------------------------------------------------------------- */
section('C. players still cannot promote themselves');
sql('a', register('Sneaky', 'e@mc.com'));
sql('a', `${asUser('Sneaky')} set role authenticated;
  update public.profiles set is_admin = true where mc_username='Sneaky'; reset role;`);
check('a logged-in player cannot set their own is_admin',
  /Sneaky\s*\|\s*f/.test(sql('a', `select mc_username, is_admin from public.profiles
                                   where mc_username='Sneaky';`)));
const direct = sql('a', `${asUser('Sneaky')} set role authenticated;
  do $$ begin perform public.make_admin('Sneaky');
    raise notice 'HOLE';
  exception when insufficient_privilege then raise notice 'BLOCKED'; end $$;
  reset role;`);
check('a player cannot call make_admin from the browser', direct.includes('BLOCKED'));
check('and they are still not an admin',
  /Sneaky\s*\|\s*f/.test(sql('a', `select mc_username, is_admin from public.profiles
                                   where mc_username='Sneaky';`)));
check('a player cannot unban themselves',
  (() => {
    sql('a', `update public.profiles set is_banned=true where mc_username='Sneaky';`);
    sql('a', `${asUser('Sneaky')} set role authenticated;
      update public.profiles set is_banned=false where mc_username='Sneaky'; reset role;`);
    const r = /Sneaky\s*\|\s*t/.test(sql('a', `select mc_username, is_banned from public.profiles
                                               where mc_username='Sneaky';`));
    sql('a', `update public.profiles set is_banned=false where mc_username='Sneaky';`);
    return r;
  })());

/* ---------------------------------------------------------------- */
section('D. only an admin may change the limits');
sql('a', `${asUser('HyraxMC')} set role authenticated;
  update public.app_settings set max_teams = 4 where id = 1; reset role;`);
check('an admin can lower max_teams',
  /\|\s*4/.test(sql('a', `select id, max_teams from public.app_settings;`)));

const blocked = sql('a', `${asUser('Sneaky')} set role authenticated;
  update public.app_settings set max_teams = 99 where id = 1; reset role;`);
check('a non-admin update affects zero rows', /UPDATE 0/.test(blocked),
  'PostgREST turns this into 200 + [] — the panel must not call it success');
check('the stored value is unchanged',
  /\|\s*4/.test(sql('a', `select id, max_teams from public.app_settings;`)));

/* ---------------------------------------------------------------- */
section('E. upgrading the user\u2019s existing database');
sql('b', SHIM);
let base = null;
try {
  execFileSync('git', ['cat-file', '-e', 'cc7288d:supabase/schema.sql'], { cwd: ROOT });
  base = 'cc7288d';
} catch {}
if (!base) {
  console.log('  ⏭️  the previous schema revision is not in this clone — skipped');
} else {
  sql('b', schemaOf(base));
  sql('b', register('HyraxMC', 'h@mc.com'));
  const oldWay = sql('b', `update public.profiles set is_admin = true
    where lower(mc_username) = lower('HyraxMC');`);
  check('the OLD schema reported UPDATE 1 …', /UPDATE 1/.test(oldWay));
  check('… while silently leaving is_admin false (the reported bug)',
    /HyraxMC\s*\|\s*f/.test(sql('b', `select mc_username, is_admin from public.profiles;`)));

  const up = sql('b', NEW);
  check('the new schema applies over the old one', !up.includes('PSQL_ERROR'),
    up.slice(0, 400));
  check('existing players are preserved',
    sql('b', `select mc_username from public.profiles;`).includes('HyraxMC'));
  check('make_admin now works on the upgraded database',
    sql('b', `select public.make_admin('HyraxMC');`).includes('انجام شد'));
  check('and the flag sticks',
    /HyraxMC\s*\|\s*t/.test(sql('b', `select mc_username, is_admin from public.profiles;`)));
}

console.log(`\n${fail ? '❌' : '🎉'} database tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
