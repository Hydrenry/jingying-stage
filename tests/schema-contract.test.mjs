import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Offline contract checks only: this file does not execute PostgreSQL or prove RLS.
const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const seedSql = readFileSync(new URL('../supabase/seed.sql', import.meta.url), 'utf8');
const seed = JSON.parse(readFileSync(new URL('../data/initial-schedule.json', import.meta.url), 'utf8'));
const sql = schema.replace(/--[^\n]*/g, '');
const functions = new Map(
  [...schema.matchAll(/create or replace function public\.([a-z_]+)\(([\s\S]*?)\)\s*\nreturns ([\s\S]*?)as \$function\$([\s\S]*?)\$function\$;/gi)]
    .map((match) => [match[1], { parameters: match[2], header: match[3], body: match[4] }]),
);
function fn(name) {
  assert(functions.has(name), 'missing function ' + name);
  return functions.get(name);
}
const apiFunctions = ['get_public_schedule', 'get_schedule_role', 'get_admin_schedule', 'save_schedule', 'list_schedule_members', 'export_schedule'];

test('offline seed retains 84 unique records, eight unknown times and source nulls', () => {
  assert.equal(seed.metadata.actorName, '王晶莹');
  assert.equal(seed.metadata.isDemo, false);
  assert.equal(seed.performances.length, 84);
  assert.equal(new Set(seed.performances.map((record) => record.id)).size, 84);
  assert.equal(seed.performances.filter((record) => record.time === null).length, 8);
  assert.equal(seed.performances[0].date, '2024-12-10');
  assert.equal(seed.performances.at(-1).date, '2026-11-28');
  for (const record of seed.performances) {
    assert.equal(record.isDemo, false);
    assert.equal(record.performanceConfirmed, null);
    assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(record.date + 'T00:00:00Z').toISOString().slice(0, 10), record.date);
    assert(record.time === null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(record.time));
    assert.equal(typeof record.sourceName, 'string');
    assert(Array.isArray(record.sourceUrls));
  }
  assert(!Object.hasOwn(seed, 'undated'));
  assert(!/\/Users\/|\/private\/|file:\/\/|service_role|password_hash|access_token/.test(JSON.stringify(seed)));
});

test('seed SQL initializes identical JSON once and never replaces an existing empty schedule', () => {
  const embedded = /\$jingying_seed\$\s*([\s\S]*?)\s*\$jingying_seed\$::jsonb/.exec(seedSql);
  assert(embedded);
  assert.deepEqual(JSON.parse(embedded[1]), seed);
  const executable = seedSql.replace(/--[^\n]*/g, '').replace(embedded[0], '');
  assert.match(executable, /insert into public\.schedule_state/i);
  assert.match(executable, /on conflict\s*\(id\)\s*do nothing/i);
  assert(!/\b(?:update|delete|truncate)\b/i.test(executable));
  assert(!/insert into (?:auth\.users|public\.schedule_members)/i.test(executable));
  assert.match(seedSql, /原始工作簿回退种子/);
  assert.match(seedSql, /不是旧站线上最新/);
});

test('browser roles have no direct table access; trusted service-role CRUD is explicit', () => {
  for (const table of ['schedule_members', 'schedule_state']) {
    assert.match(sql, new RegExp('alter table public\\.' + table + ' enable row level security', 'i'));
  }
  assert.match(sql, /revoke all on table public\.schedule_members,\s*public\.schedule_state from public,\s*anon,\s*authenticated/i);
  assert.match(sql, /grant select,\s*insert,\s*update,\s*delete on table public\.schedule_members,\s*public\.schedule_state to service_role/i);
  assert(!/create\s+policy/i.test(sql));
  const tableGrants = [...sql.matchAll(/grant ([^;]+) on table ([^;]+) to ([^;]+);/gi)];
  for (const grant of tableGrants) assert(!/\banon\b|\bauthenticated\b/.test(grant[3]));
  assert.match(sql, /user_id uuid primary key references auth\.users\(id\) on delete cascade/i);
  assert.match(sql, /updated_by uuid references auth\.users\(id\) on delete set null/i);
  assert.match(sql, /jsonb_typeof\(payload -> 'metadata'\) is not distinct from 'object'/i);
  assert.match(sql, /jsonb_typeof\(payload -> 'performances'\) is not distinct from 'array'/i);
});

test('only the public RPC is anonymous and all functions pin their search path', () => {
  assert.equal(functions.size, 17);
  for (const [name, value] of functions) {
    assert.match(value.header, /set search_path = ''/i, name);
    assert.match(sql, new RegExp('revoke all on function public\\.' + name + '\\([^;]*\\) from public,\\s*anon,\\s*authenticated', 'i'), name);
  }
  const grants = [...sql.matchAll(/grant execute on function public\.([a-z_]+)\([^;]*?\) to ([^;]+);/gi)];
  const anonymous = grants.filter((match) => match[2].split(',').map((role) => role.trim()).includes('anon')).map((match) => match[1]);
  assert.deepEqual(anonymous, ['get_public_schedule']);
  assert.deepEqual(grants.map((match) => match[1]).sort(), [...apiFunctions].sort());
  for (const name of apiFunctions) assert.match(fn(name).header, /security definer/i);
});

test('authorization checks live auth.uid membership and never lets first visitors claim ownership', () => {
  const guard = fn('_require_schedule_member').body;
  assert.match(guard, /auth\.uid\(\) is null/i);
  assert.match(guard, /from public\.schedule_members/i);
  assert.match(guard, /m\.user_id = auth\.uid\(\) for share/i);
  assert.match(guard, /member_role is null/i);
  assert.match(guard, /owner_only and member_role <> 'owner'/i);
  for (const name of ['get_admin_schedule', 'save_schedule']) assert.match(fn(name).body, /perform public\._require_schedule_member\(false\)/i);
  for (const name of ['list_schedule_members', 'export_schedule']) assert.match(fn(name).body, /perform public\._require_schedule_member\(true\)/i);
  assert.match(fn('get_schedule_role').body, /where m\.user_id = auth\.uid\(\)/i);
  assert(!/user_metadata|raw_user_meta_data/i.test(sql));
  assert(!/insert into public\.schedule_members/i.test(sql));
});

test('one immutable owner is protected at the table level as well as in Edge Functions', () => {
  assert.match(sql, /create unique index if not exists schedule_members_one_owner[\s\S]*?where role = 'owner'/i);
  assert.match(sql, /create trigger protect_schedule_owner before update or delete on public\.schedule_members/i);
  const trigger = fn('_protect_schedule_owner').body;
  assert.match(trigger, /if old\.role = 'owner' then/i);
  assert.match(trigger, /if tg_op = 'UPDATE' then[\s\S]*?if new\.role = 'owner' then/i);
  assert.match(trigger, /errcode = '42501'/i);
  assert.match(trigger, /if tg_op = 'DELETE' then return old/i);
});

test('full-list writes lock, compare versions and audit the authenticated caller', () => {
  const save = fn('save_schedule');
  assert.match(save.parameters, /^expected_revision bigint,\s*input_performances jsonb$/i);
  assert.match(save.body, /expected_revision < 1[\s\S]*expected_revision >= 9007199254740991/i);
  assert.match(save.body, /where id = 'main' for update/i);
  assert.match(save.body, /state\.revision <> expected_revision/i);
  assert.match(save.body, /raise sqlstate 'PT409' using message = 'REVISION_CONFLICT/i);
  assert.match(save.body, /revision = revision \+ 1/i);
  assert.match(save.body, /where id = 'main' and revision = expected_revision/i);
  assert.match(save.body, /updated_by = auth\.uid\(\)/i);
  const permission = save.body.indexOf('perform public._require_schedule_member(false)');
  const lock = save.body.indexOf("where id = 'main' for update");
  const conflict = save.body.indexOf('state.revision <> expected_revision');
  const validation = save.body.indexOf('public._validate_schedule_performances(input_performances');
  const update = save.body.indexOf('update public.schedule_state');
  assert(permission < lock && lock < conflict && conflict < validation && validation < update);
  for (const key of ['revision', 'updatedAt', 'performances']) assert(save.body.includes("'" + key + "'"));
});

test('validation covers real dates, nullable times, unique IDs, lengths and deletion timestamps', () => {
  const validation = fn('_validate_schedule_performances').body;
  assert.match(validation, /jsonb_typeof\(input\) is distinct from 'array'/i);
  assert.match(validation, /jsonb_array_length\(input\) > 3000/i);
  assert.match(validation, /record_id = any\(seen_ids\)/i);
  assert.match(validation, /record_id ~ '\[\[:cntrl:\]\]'/i);
  assert.match(validation, /public\._schedule_text\(entry -> 'id', label \|\| '的编号', 160, true\)/i);
  assert.match(validation, /public\._schedule_is_date\(date_value #>> '\{\}'\)/i);
  assert.match(validation, /time_value <> 'null'::jsonb/i);
  assert.match(validation, /public\._schedule_is_timestamp\(deleted_value #>> '\{\}'\)/i);
  for (const [field, maximum] of [['city', 100], ['venue', 300], ['role', 200], ['note', 5000]]) {
    const line = validation.split('\n').find((value) => value.includes("'" + field + "', public._schedule_text"));
    assert(line && line.includes(', ' + maximum + ')'), field + ' maximum');
  }
  assert.match(validation, /'的剧目', 200, true/);
  assert.match(validation, /coalesce\(original, '\{"status":"待确认","isDemo":false\}'::jsonb\) \|\| jsonb_build_object/);
  assert(!/entry\s*\|\|/.test(validation));
  assert.match(fn('_schedule_is_date').body, /parsed := value::date/);
  assert.match(fn('_schedule_is_date').body, /to_char\(parsed, 'YYYY-MM-DD'\) = value/);
  assert.match(fn('_schedule_is_date').body, /exception when sqlstate '22007' or sqlstate '22008'/i);
  assert.match(fn('_schedule_field').body, /case when jsonb_exists\(value, field_name\) then value -> field_name/i);
});

test('public payloads whitelist provenance without member emails, audit IDs or pending leads', () => {
  const publicRpc = fn('get_public_schedule').body;
  const document = fn('_safe_schedule_document').body;
  const safe = fn('_safe_schedule_fields').body;
  assert.match(publicRpc, /public\._safe_schedule_document\(state\.payload, false\)/);
  assert.match(publicRpc, /'revision', state\.revision, 'lastUpdatedAt', state\.updated_at/);
  assert.match(document, /entry ->> 'deletedAt' is null/);
  assert.match(document, /jsonb_build_object\('metadata', safe_metadata, 'performances', safe_performances\)/);
  for (const key of ['sourceName', 'sourceUrl', 'sourceUrls', 'sourceSheet', 'sourceRow', 'sourceYearContextNote', 'performanceConfirmed']) assert(document.includes("'" + key + "'"), key);
  for (const key of ['undated', 'ownerEmail', 'email', 'updated_by', 'updatedBy', 'sourceFiles', 'sourceReferenceText']) assert(!document.includes("'" + key + "'"), key);
  assert.match(safe, /public\._redact_schedule_paths/);
  assert.match(safe, /public\._safe_schedule_url/);
  assert.match(safe, /jsonb_typeof\(field_value\) in \('null', 'number', 'boolean'\)/);
  assert(!/auth\.users|schedule_members/.test(publicRpc));
  assert(!/updated_by|auth\.users/.test(fn('get_admin_schedule').body));
});

test('only owner-gated membership RPC returns emails; owner backup retains trash', () => {
  const members = fn('list_schedule_members').body;
  assert(members.indexOf('_require_schedule_member(true)') < members.indexOf('auth.users'));
  for (const key of ['ownerEmail', 'editors', 'userId', 'email', 'addedAt']) assert(members.includes("'" + key + "'"));
  assert.match(members, /where m\.role = 'editor'/);
  const backup = fn('export_schedule').body;
  assert.match(backup, /_require_schedule_member\(true\)/);
  assert.match(backup, /_safe_schedule_document\(state\.payload, true\)/);
  assert(!/schedule_members|auth\.users|updated_by/.test(backup));
});

test('PostgreSQL runtime permissions and concurrency require a real Supabase test', {
  skip: 'No PostgreSQL, PGlite or Supabase connection is available; no account or deployment was created.',
}, () => {});
