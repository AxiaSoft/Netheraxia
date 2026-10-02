-- ============================================================================
-- افزودن قابلیت «حذف کامل بازیکن» به دیتابیس
-- ----------------------------------------------------------------------------
-- اگر اسکیما را از قبل نصب کرده‌اید و نمی‌خواهید دوباره کل schema.sql را اجرا
-- کنید، فقط همین فایل را در SQL Editor سوپابیس پیست کنید و Run بزنید.
--
--   Supabase → پروژه‌ی شما → SQL Editor → New query → پیست → Run
--
-- این فایل هیچ داده‌ای را پاک نمی‌کند. فقط یک تابع اضافه می‌کند و در آخر با یک
-- حساب آزمایشیِ ساختگی امتحان می‌کند که واقعاً کار می‌کند یا نه.
-- ============================================================================

-- ۱) الان این قابلیت نصب است یا نه؟
select
    case when count(*) = 0 then '❌ هنوز نصب نیست — همین فایل نصبش می‌کند'
         else '✅ از قبل نصب است — این فایل فقط به‌روزش می‌کند' end as وضعیت_فعلی
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_delete_player';

-- ============================================================================
-- ۲) خود تابع
-- ----------------------------------------------------------------------------
-- security definer است، یعنی با دسترسی سازنده‌ی تابع اجرا می‌شود و می‌تواند
-- ردیف auth.users را پاک کند. اولین کاری که می‌کند این است که مطمئن شود
-- صداکننده واقعاً ادمین است.
--
-- ترتیب کارها مهم است: اول تکلیف تیم‌ها روشن می‌شود، بعد حساب پاک می‌شود.
-- اگر برعکس بود، حذف آبشاریِ auth.users تیمِ بازیکن را هم با خودش می‌برد و
-- بقیه‌ی اعضا بی‌تیم می‌شدند.
-- ============================================================================
create or replace function public.admin_delete_player(p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
    victim    public.profiles;
    t         record;
    heir      uuid;
    n_dropped int := 0;
    n_moved   int := 0;
    n_member  int := 0;
    dropped   text[] := '{}';
    moved     text[] := '{}';
begin
    if not public.is_admin() then
        raise exception 'NOT_ALLOWED';
    end if;

    select * into victim from public.profiles where id = p_user_id;
    if victim.id is null then
        raise exception 'PLAYER_NOT_FOUND';
    end if;

    -- جلوگیری از پاک کردن حساب خودِ ادمین (قفل شدن بیرون از پنل)
    if victim.id = auth.uid() then
        raise exception 'CANNOT_DELETE_SELF';
    end if;

    -- یک ادمین نمی‌تواند ادمین دیگری را پاک کند؛ اول باید ادمینی‌اش گرفته شود
    if victim.is_admin then
        raise exception 'CANNOT_DELETE_ADMIN';
    end if;

    -- تیم‌هایی که این بازیکن کاپیتانشان است
    for t in select * from public.teams where owner_id = p_user_id loop
        select tm.user_id into heir
          from public.team_members tm
         where tm.team_id = t.id and tm.user_id <> p_user_id
         order by tm.is_leader desc, tm.joined_at asc
         limit 1;

        if heir is null then
            -- کسی در تیم نمانده → تیم حذف شود
            delete from public.teams where id = t.id;
            n_dropped := n_dropped + 1;
            dropped   := dropped || t.name;
        else
            -- تیم زنده بماند و کاپیتانی منتقل شود
            update public.teams set owner_id = heir where id = t.id;
            update public.team_members set is_leader = (user_id = heir) where team_id = t.id;
            n_moved := n_moved + 1;
            moved   := moved || t.name;
        end if;
    end loop;

    select count(*) into n_member from public.team_members where user_id = p_user_id;

    -- حذف حساب؛ profiles و team_members به‌صورت آبشاری پاک می‌شوند
    delete from auth.users where id = p_user_id;
    -- اگر ردیف auth از قبل نبود، دست‌کم پروفایل را پاک کن
    delete from public.profiles where id = p_user_id;

    if exists (select 1 from public.profiles where id = p_user_id) then
        raise exception 'DELETE_FAILED';
    end if;

    return json_build_object(
        'username',               victim.mc_username,
        'teams_deleted',          n_dropped,
        'teams_transferred',      n_moved,
        'memberships_removed',    n_member,
        'deleted_team_names',     dropped,
        'transferred_team_names', moved);
end $$;

-- ============================================================================
-- ۳) دسترسی‌ها — فقط کاربرِ واردشده می‌تواند صدایش بزند
--    (و خود تابع هم چک می‌کند که آن کاربر ادمین باشد)
-- ============================================================================
grant execute on function public.admin_delete_player(uuid) to authenticated;
revoke execute on function public.admin_delete_player(uuid) from public, anon;

-- به PostgREST بگو لیست توابعش را دوباره بخواند، وگرنه تا چند دقیقه
-- خطای «function does not exist» می‌گیرید.
notify pgrst, 'reload schema';

-- ============================================================================
-- ۴) تست واقعی
-- ----------------------------------------------------------------------------
-- یک بازیکن قلابی ساخته می‌شود، با تابع پاک می‌شود، و بررسی می‌شود که هم
-- پروفایل و هم حساب ورودش واقعاً رفته باشند. هیچ داده‌ی واقعی‌ای لمس نمی‌شود.
-- ============================================================================
do $$
declare
    admin_id   uuid;
    test_id    uuid := gen_random_uuid();
    was_open   boolean;
    res        json;
    oops       text;
    prof_gone  boolean;
    auth_gone  boolean;
begin
    select id into admin_id from public.profiles
     where is_admin order by created_at limit 1;

    if admin_id is null then
        raise notice '⚠️ هیچ ادمینی در دیتابیس نیست، پس تست اجرا نشد.';
        raise notice '   اول این را بزنید:  select public.make_admin(''نام_ماینکرفتی_شما'');';
        return;
    end if;

    -- ثبت‌نام ممکن است بسته باشد؛ موقتاً باز می‌شود تا بازیکن آزمایشی ساخته شود
    select registration_open into was_open from public.app_settings where id = 1;
    update public.app_settings set registration_open = true where id = 1;

    begin
        insert into auth.users (id, email, raw_user_meta_data)
        values (test_id, 'nx_deltest@example.invalid',
                '{"mc_username":"NxDelTest"}'::jsonb);

        -- خودمان را جای ادمین جا بزنیم تا auth.uid() پر باشد
        perform set_config('request.jwt.claim.sub', admin_id::text, true);

        res := public.admin_delete_player(test_id);

        prof_gone := not exists (select 1 from public.profiles where id = test_id);
        auth_gone := not exists (select 1 from auth.users where id = test_id);
    exception when others then
        oops := sqlerrm;
    end;

    -- تمیزکاری — در هر حالتی اجرا می‌شود
    perform set_config('request.jwt.claim.sub', '', true);
    delete from auth.users      where id = test_id;
    delete from public.profiles where id = test_id;
    update public.app_settings set registration_open = was_open where id = 1;

    if oops is not null then
        raise notice '⚠️ تست انجام نشد: %', oops;
        raise notice '   تابع نصب شد؛ از خود پنل مدیریت امتحانش کنید.';
    elsif prof_gone and auth_gone then
        raise notice '✅ تست موفق: بازیکن «%» کامل حذف شد (پروفایل و حساب ورود).',
                     res->>'username';
    else
        raise exception 'تست شکست خورد: پروفایل=% حساب=%',
            case when prof_gone then 'پاک شد' else 'ماند' end,
            case when auth_gone then 'پاک شد' else 'ماند' end;
    end if;
end $$;

-- ============================================================================
-- ۵) نتیجه
-- ============================================================================
select
    '✅ قابلیت حذف بازیکن آماده است' as نتیجه,
    'پنل مدیریت → تب حساب‌ها → فهرست بازیکنان → دکمه‌ی «حذف کامل»' as کجاست,
    'ادمین‌ها قابل حذف نیستند؛ اول ادمینی‌شان را بردارید.' as نکته;

-- اگر خواستید ادمینیِ کسی را بردارید تا بتوانید حذفش کنید:
--     update public.profiles set is_admin = false where mc_username = 'نام_او';
--
-- و اگر خواستید دوباره ادمینش کنید:
--     select public.make_admin('نام_او');
