-- 在你自己的 Supabase 项目 SQL Editor 中以 postgres 身份运行。
-- 本文件只创建结构和函数，不创建账号、不认领站主、不发送邮件、不覆盖排期。
-- 之后运行 seed.sql；站主须由你在 Auth 中显式创建，再手动插入对应 UID。
-- 安全模型：所有表对浏览器直接关闭；允许的 RPC 自行逐次核对 auth.uid()。

begin;

create table if not exists public.schedule_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor')),
  added_at timestamptz not null default now(),
  added_by uuid references auth.users(id) on delete set null
);

create unique index if not exists schedule_members_one_owner
  on public.schedule_members (role) where role = 'owner';

create table if not exists public.schedule_state (
  id text primary key default 'main' check (id = 'main'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and jsonb_typeof(payload -> 'metadata') is not distinct from 'object'
    and jsonb_typeof(payload -> 'performances') is not distinct from 'array'
  ),
  revision bigint not null default 1 check (revision >= 1 and revision <= 9007199254740991),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.schedule_members enable row level security;
alter table public.schedule_state enable row level security;
-- 故意不建立开放 policy：anon/authenticated 不能直接读写任何一张表。
revoke all on table public.schedule_members, public.schedule_state from public, anon, authenticated;
grant select, insert, update, delete on table public.schedule_members, public.schedule_state to service_role;

create or replace function public._protect_schedule_owner()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.role = 'owner' then
    raise exception using errcode = '42501', message = '站主权限不能在这里修改或撤销。';
  end if;
  if tg_op = 'UPDATE' then
    if new.role = 'owner' then
      raise exception using errcode = '42501', message = '不能通过编辑者更新来提升站主权限。';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

drop trigger if exists protect_schedule_owner on public.schedule_members;
create trigger protect_schedule_owner before update or delete on public.schedule_members
  for each row execute function public._protect_schedule_owner();

create or replace function public._require_schedule_member(owner_only boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  member_role text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = '请先登录管理员账号。';
  end if;
  -- 成员行锁让已开始的操作先完成；撤销提交后，新的操作必定重新检查成员表。
  select m.role into member_role from public.schedule_members m
    where m.user_id = auth.uid() for share;
  if member_role is null then
    raise exception using errcode = '42501', message = '当前账号没有排期管理权限。';
  end if;
  if owner_only and member_role <> 'owner' then
    raise exception using errcode = '42501', message = '只有站主可以管理授权或导出备份。';
  end if;
  return member_role;
end;
$function$;

create or replace function public.get_schedule_role()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select m.role from public.schedule_members m where m.user_id = auth.uid();
$function$;

create or replace function public._schedule_is_date(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare parsed date;
begin
  if value is null or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  parsed := value::date;
  return extract(year from parsed) >= 1 and to_char(parsed, 'YYYY-MM-DD') = value;
exception when sqlstate '22007' or sqlstate '22008' then
  return false;
end;
$function$;

create or replace function public._schedule_is_timestamp(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare parsed timestamptz;
begin
  if value is null or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or not public._schedule_is_date(left(value, 10)) then return false; end if;
  parsed := value::timestamptz;
  return isfinite(parsed);
exception when sqlstate '22007' or sqlstate '22008' or sqlstate '22009' then
  return false;
end;
$function$;

create or replace function public._schedule_text(value jsonb, label text, max_length integer, required boolean default false)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare text_value text;
begin
  if jsonb_typeof(value) is distinct from 'string' then
    raise exception using errcode = '22023', message = label || '必须是文字。';
  end if;
  text_value := regexp_replace(value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if required and text_value = '' then
    raise exception using errcode = '22023', message = label || '不能为空。';
  end if;
  if char_length(text_value) > max_length then
    raise exception using errcode = '22023', message = label || '不能超过 ' || max_length || ' 个字。';
  end if;
  return text_value;
end;
$function$;

create or replace function public._schedule_field(value jsonb, original jsonb, field_name text, fallback jsonb default null)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case when jsonb_exists(value, field_name) then value -> field_name
    else coalesce(nullif(original -> field_name, 'null'::jsonb), fallback) end;
$function$;

create or replace function public._validate_schedule_performances(input jsonb, existing jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result jsonb := '[]'::jsonb;
  previous jsonb;
  entry jsonb;
  original jsonb;
  saved jsonb;
  record_id text;
  title_value text;
  date_value jsonb;
  time_value jsonb;
  deleted_value jsonb;
  seen_ids text[] := array[]::text[];
  row_number integer := 0;
  label text;
begin
  if jsonb_typeof(input) is distinct from 'array' then
    raise exception using errcode = '22023', message = '排期内容必须是列表。';
  end if;
  if jsonb_array_length(input) > 3000 then
    raise exception using errcode = '22023', message = '最多可保存 3000 条排期。';
  end if;
  select coalesce(jsonb_object_agg(item ->> 'id', item), '{}'::jsonb) into previous
    from jsonb_array_elements(existing) as entries(item)
    where jsonb_typeof(item) = 'object' and jsonb_typeof(item -> 'id') = 'string';
  for entry in select item from jsonb_array_elements(input) as entries(item) loop
    row_number := row_number + 1;
    label := '第 ' || row_number || ' 条排期';
    if jsonb_typeof(entry) is distinct from 'object' then
      raise exception using errcode = '22023', message = label || '格式有误。';
    end if;
    record_id := public._schedule_text(entry -> 'id', label || '的编号', 160, true);
    if record_id ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = label || '的编号包含无效字符。';
    end if;
    if record_id = any(seen_ids) then
      raise exception using errcode = '22023', message = '排期编号重复：' || record_id || '。';
    end if;
    seen_ids := array_append(seen_ids, record_id);
    original := previous -> record_id;
    title_value := public._schedule_text(public._schedule_field(entry, original, 'title'), label || '的剧目', 200, true);
    date_value := public._schedule_field(entry, original, 'date');
    if jsonb_typeof(date_value) is distinct from 'string' or not public._schedule_is_date(date_value #>> '{}') then
      raise exception using errcode = '22023', message = label || '的日期须为有效的 YYYY-MM-DD。';
    end if;
    time_value := public._schedule_field(entry, original, 'time', 'null'::jsonb);
    if time_value <> 'null'::jsonb and (
      jsonb_typeof(time_value) is distinct from 'string'
      or (time_value #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    ) then
      raise exception using errcode = '22023', message = label || '的时间须为 HH:mm；未知时间请留空。';
    end if;
    deleted_value := public._schedule_field(entry, original, 'deletedAt', 'null'::jsonb);
    if deleted_value <> 'null'::jsonb and (
      jsonb_typeof(deleted_value) is distinct from 'string'
      or not public._schedule_is_timestamp(deleted_value #>> '{}')
    ) then
      raise exception using errcode = '22023', message = label || '的删除时间格式有误。';
    end if;
    -- 保留旧记录所有来源属性；新增仅使用下列字段，不信任客户端注入的权限或来源。
    saved := coalesce(original, '{"status":"待确认","isDemo":false}'::jsonb) || jsonb_build_object(
      'id', record_id, 'title', title_value, 'date', date_value, 'time', time_value,
      'city', public._schedule_text(public._schedule_field(entry, original, 'city', '""'::jsonb), label || '的城市', 100),
      'venue', public._schedule_text(public._schedule_field(entry, original, 'venue', '""'::jsonb), label || '的剧场', 300),
      'role', public._schedule_text(public._schedule_field(entry, original, 'role', '""'::jsonb), label || '的角色', 200),
      'note', public._schedule_text(public._schedule_field(entry, original, 'note', '""'::jsonb), label || '的备注', 5000),
      'deletedAt', deleted_value
    );
    if original is null and jsonb_exists(entry, 'status') then
      saved := jsonb_set(saved, '{status}', to_jsonb(public._schedule_text(entry -> 'status', label || '的状态', 100, true)));
    end if;
    result := result || jsonb_build_array(saved);
  end loop;
  return result;
end;
$function$;

create or replace function public._redact_schedule_paths(value text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $function$
declare result text := value;
begin
  result := regexp_replace(result, 'file://[^[:space:]<>"'']+', '[本地来源文件]', 'gi');
  result := regexp_replace(result, '/(Users|home|private|tmp|var|Volumes|mnt)/[^[:space:]<>"'']+', '[本地来源文件]', 'g');
  result := regexp_replace(result, '(^|[[:space:]("''=：:（])/(?!/)[^[:space:]<>"'']+', '\1[本地来源文件]', 'g');
  result := regexp_replace(result, '(^|[[:space:]("''=：:（])([A-Za-z]:[\\/]|\\\\)[^[:space:]<>"'']+', '\1[本地来源文件]', 'g');
  return result;
end;
$function$;

create or replace function public._safe_schedule_url(value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case when value ~ '^https?://[^[:space:]]+$' and value !~ '^https?://[^/]*@' then value else '' end;
$function$;

create or replace function public._safe_schedule_fields(value jsonb, allowed_fields text[])
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result jsonb := '{}'::jsonb;
  field_name text;
  field_value jsonb;
  urls jsonb;
begin
  if jsonb_typeof(value) is distinct from 'object' then return result; end if;
  foreach field_name in array allowed_fields loop
    if not jsonb_exists(value, field_name) then continue; end if;
    field_value := value -> field_name;
    if field_name = 'sourceUrls' then
      urls := '[]'::jsonb;
      if jsonb_typeof(field_value) = 'array' then
        select coalesce(jsonb_agg(to_jsonb(public._safe_schedule_url(item #>> '{}'))), '[]'::jsonb) into urls
          from jsonb_array_elements(field_value) as entries(item)
          where jsonb_typeof(item) = 'string' and public._safe_schedule_url(item #>> '{}') <> '';
      end if;
      result := result || jsonb_build_object(field_name, urls);
    elsif field_name = 'sourceUrl' then
      result := result || jsonb_build_object(field_name, coalesce(public._safe_schedule_url(field_value #>> '{}'), ''));
    elsif jsonb_typeof(field_value) = 'string' then
      result := result || jsonb_build_object(field_name, case when field_name = 'sourceFileName'
        then regexp_replace(field_value #>> '{}', '^.*[\\/]', '')
        else public._redact_schedule_paths(field_value #>> '{}') end);
    elsif jsonb_typeof(field_value) in ('null', 'number', 'boolean') then
      result := result || jsonb_build_object(field_name, field_value);
    end if;
  end loop;
  return result;
end;
$function$;

create or replace function public._safe_schedule_document(value jsonb, include_deleted boolean default false)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  safe_metadata jsonb;
  safe_performances jsonb := '[]'::jsonb;
  entry jsonb;
begin
  safe_metadata := public._safe_schedule_fields(
    case when jsonb_typeof(value -> 'metadata') = 'object' then value -> 'metadata' else value end,
    array['actorName','updatedAt','importedAt','sourceFileName','sourceAsOf','isDemo','notice']
  );
  for entry in select item from jsonb_array_elements(value -> 'performances') as entries(item) loop
    if include_deleted or entry ->> 'deletedAt' is null then
      safe_performances := safe_performances || jsonb_build_array(public._safe_schedule_fields(entry, array[
        'id','title','date','time','city','venue','role','note','status','deletedAt',
        'sourceStatus','sourceName','sourceUrl','sourceUrls','verificationBasis',
        'performanceConfirmed','confirmationStatus','sourceSheet','sourceRow','sourceRange',
        'sourceRecordId','sourceFileName','sourceAsOf','sourceYearContextNote','originalLocation','isDemo','updatedAt'
      ]));
    end if;
  end loop;
  return jsonb_build_object('metadata', safe_metadata, 'performances', safe_performances);
end;
$function$;

create or replace function public.get_public_schedule()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare state public.schedule_state%rowtype;
begin
  select * into state from public.schedule_state where id = 'main';
  if not found then raise exception using errcode = 'P0002', message = '请先由站主运行排期初始化脚本。'; end if;
  return public._safe_schedule_document(state.payload, false) || jsonb_build_object(
    'revision', state.revision, 'lastUpdatedAt', state.updated_at
  );
end;
$function$;

create or replace function public.get_admin_schedule()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare state public.schedule_state%rowtype;
begin
  perform public._require_schedule_member(false);
  select * into state from public.schedule_state where id = 'main';
  if not found then raise exception using errcode = 'P0002', message = '请先由站主运行排期初始化脚本。'; end if;
  return jsonb_build_object('revision', state.revision, 'updatedAt', state.updated_at, 'performances', state.payload -> 'performances');
end;
$function$;

create or replace function public.save_schedule(expected_revision bigint, input_performances jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  state public.schedule_state%rowtype;
  performances jsonb;
begin
  perform public._require_schedule_member(false);
  if expected_revision is null or expected_revision < 1 or expected_revision >= 9007199254740991 then
    raise exception using errcode = '22023', message = '排期版本无效，请重新加载管理页面。';
  end if;
  select * into state from public.schedule_state where id = 'main' for update;
  if not found then raise exception using errcode = 'P0002', message = '请先由站主运行排期初始化脚本。'; end if;
  if state.revision <> expected_revision then
    raise sqlstate 'PT409' using message = 'REVISION_CONFLICT：排期已被其他页面修改，请重新加载后再保存。';
  end if;
  performances := public._validate_schedule_performances(input_performances, state.payload -> 'performances');
  update public.schedule_state set
    payload = jsonb_set(state.payload, '{performances}', performances),
    revision = revision + 1,
    updated_at = clock_timestamp(),
    updated_by = auth.uid()
    where id = 'main' and revision = expected_revision
    returning * into state;
  if not found then
    raise sqlstate 'PT409' using message = 'REVISION_CONFLICT：排期已被其他页面修改，请重新加载后再保存。';
  end if;
  return jsonb_build_object('revision', state.revision, 'updatedAt', state.updated_at, 'performances', performances);
end;
$function$;

create or replace function public.list_schedule_members()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  owner_email text;
  editors jsonb;
begin
  perform public._require_schedule_member(true);
  select u.email into owner_email from public.schedule_members m join auth.users u on u.id = m.user_id where m.role = 'owner';
  select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'email', u.email, 'addedAt', m.added_at) order by lower(u.email)), '[]'::jsonb)
    into editors from public.schedule_members m join auth.users u on u.id = m.user_id where m.role = 'editor';
  return jsonb_build_object('ownerEmail', owner_email, 'editors', editors);
end;
$function$;

create or replace function public.export_schedule()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare state public.schedule_state%rowtype;
begin
  perform public._require_schedule_member(true);
  select * into state from public.schedule_state where id = 'main';
  if not found then raise exception using errcode = 'P0002', message = '请先由站主运行排期初始化脚本。'; end if;
  return public._safe_schedule_document(state.payload, true) || jsonb_build_object(
    'revision', state.revision, 'lastUpdatedAt', state.updated_at
  );
end;
$function$;

-- 取消 PostgreSQL 默认 PUBLIC EXECUTE 和 Supabase 可能存在的直接角色授权。
revoke all on function public._protect_schedule_owner() from public, anon, authenticated;
revoke all on function public._require_schedule_member(boolean) from public, anon, authenticated;
revoke all on function public._schedule_is_date(text) from public, anon, authenticated;
revoke all on function public._schedule_is_timestamp(text) from public, anon, authenticated;
revoke all on function public._schedule_text(jsonb,text,integer,boolean) from public, anon, authenticated;
revoke all on function public._schedule_field(jsonb,jsonb,text,jsonb) from public, anon, authenticated;
revoke all on function public._validate_schedule_performances(jsonb,jsonb) from public, anon, authenticated;
revoke all on function public._redact_schedule_paths(text) from public, anon, authenticated;
revoke all on function public._safe_schedule_url(text) from public, anon, authenticated;
revoke all on function public._safe_schedule_fields(jsonb,text[]) from public, anon, authenticated;
revoke all on function public._safe_schedule_document(jsonb,boolean) from public, anon, authenticated;
revoke all on function public.get_public_schedule() from public, anon, authenticated;
revoke all on function public.get_schedule_role() from public, anon, authenticated;
revoke all on function public.get_admin_schedule() from public, anon, authenticated;
revoke all on function public.save_schedule(bigint,jsonb) from public, anon, authenticated;
revoke all on function public.list_schedule_members() from public, anon, authenticated;
revoke all on function public.export_schedule() from public, anon, authenticated;

grant execute on function public.get_public_schedule() to anon, authenticated;
grant execute on function public.get_schedule_role() to authenticated;
grant execute on function public.get_admin_schedule() to authenticated;
grant execute on function public.save_schedule(bigint,jsonb) to authenticated;
grant execute on function public.list_schedule_members() to authenticated;
grant execute on function public.export_schedule() to authenticated;

commit;

-- 显式指定站主（另开 SQL Editor，仅由你把 <站主Auth UID> 换成真实 UID 后运行）：
-- insert into public.schedule_members(user_id, role)
-- values ('<站主Auth UID>'::uuid, 'owner') on conflict(user_id) do nothing;
-- select user_id, role from public.schedule_members;
-- 不能通过网页请求、登录次数或可修改的账号资料来认领或提升权限。
