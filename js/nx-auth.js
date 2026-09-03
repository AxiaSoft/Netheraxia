/* ============================================================================
 * Netheraxia — لایه‌ی حساب کاربری و تیم‌ها
 * مستقیم با REST API سوپابیس کار می‌کند؛ هیچ اسکریپت خارجی لازم نیست
 * (برای کاربران ایران هم قابل اتکاتر است و سایت بدون آن هم بالا می‌آید).
 * ==========================================================================*/
(function (global) {
    'use strict';

    var CFG_KEY = 'nthx_supabase';
    var SESSION_KEY = 'nthx_session';

    /* ---- پیکربندی -------------------------------------------------------- */
    // مقادیر واقعی در فایل js/nx-config.js قرار می‌گیرند (بیرون از این فایل)،
    // یا از localStorage خوانده می‌شوند تا بدون ویرایش کد هم قابل تنظیم باشد.
    var cfg = { url: '', anonKey: '' };

    function loadConfig() {
        // js/nx-config.js assigns to `window`; look there as well as on the
        // global object, since they are not always the same reference.
        var fromFile = global.NETHERAXIA_SUPABASE ||
            (typeof window !== 'undefined' && window && window.NETHERAXIA_SUPABASE) || null;
        if (fromFile && fromFile.url && fromFile.anonKey) {
            cfg = {
                url: String(fromFile.url).replace(/\/+$/, ''),
                anonKey: String(fromFile.anonKey)
            };
        }
        try {
            var raw = localStorage.getItem(CFG_KEY);
            if (raw) {
                var o = JSON.parse(raw);
                if (o && o.url && o.anonKey) {
                    cfg = { url: String(o.url).replace(/\/+$/, ''), anonKey: String(o.anonKey) };
                }
            }
        } catch (e) {}
        return cfg;
    }

    function saveConfig(url, anonKey) {
        cfg = { url: String(url || '').replace(/\/+$/, ''), anonKey: String(anonKey || '') };
        try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
        return cfg;
    }

    function isConfigured() {
        if (!cfg.url || !cfg.anonKey) loadConfig();   // tolerate being asked early
        return !!(cfg.url && cfg.anonKey);
    }

    /* ---- نشست ------------------------------------------------------------ */
    var session = null;

    function loadSession() {
        try {
            var raw = localStorage.getItem(SESSION_KEY);
            session = raw ? JSON.parse(raw) : null;
        } catch (e) { session = null; }
        return session;
    }

    function storeSession(s) {
        session = s;
        try {
            if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
            else localStorage.removeItem(SESSION_KEY);
        } catch (e) {}
        return session;
    }

    function currentUser() {
        return session && session.user ? session.user : null;
    }
    function isLoggedIn() { return !!(session && session.access_token); }

    /* ---- ترجمه‌ی خطاها به فارسی ------------------------------------------ */
    var MESSAGES = {
        REGISTRATION_CLOSED: 'ثبت‌نام در حال حاضر بسته است.',
        USERNAME_REQUIRED:   'نام کاربری ماینکرفت الزامی است.',
        USERNAME_INVALID:    'نام ماینکرفت باید ۳ تا ۱۶ حرف انگلیسی، عدد یا _ باشد.',
        USERNAME_TAKEN:      'این نام ماینکرفت قبلاً ثبت شده است.',
        TEAM_CREATION_CLOSED:'ساخت تیم جدید در حال حاضر بسته است.',
        MAX_TEAMS_REACHED:   'ظرفیت تیم‌ها تکمیل است؛ تیم جدیدی نمی‌توان ساخت.',
        TEAM_FULL:           'این تیم پر است.',
        ALREADY_IN_TEAM:     'شما در حال حاضر عضو یک تیم هستید. اول از آن خارج شوید.',
        JOIN_CLOSED:         'عضویت در تیم‌ها در حال حاضر بسته است.',
        OWNER_CANNOT_LEAVE:  'شما کاپیتان تیم هستید؛ اول کاپیتانی را واگذار یا تیم را حذف کنید.',
        BANNED:              'حساب شما مسدود شده است.',
        NOT_A_MEMBER:        'این بازیکن عضو تیم نیست.',
        NOT_ALLOWED:         'اجازه‌ی این کار را ندارید.',
        TEAM_NOT_FOUND:      'تیم پیدا نشد.'
    };

    function humanize(raw) {
        var t = String(raw || '');
        for (var key in MESSAGES) {
            if (t.indexOf(key) !== -1) return MESSAGES[key];
        }
        if (/duplicate key.*teams_name_uniq/i.test(t)) return 'تیمی با این نام از قبل وجود دارد.';
        if (/duplicate key.*profiles_username_uniq/i.test(t)) return MESSAGES.USERNAME_TAKEN;
        if (/teams_name_len/i.test(t)) return 'نام تیم باید بین ۲ تا ۲۴ کاراکتر باشد.';
        if (/duplicate key/i.test(t)) return 'این مورد از قبل ثبت شده است.';
        if (/Invalid login credentials/i.test(t)) return 'نام کاربری/ایمیل یا رمز عبور اشتباه است.';
        if (/Email not confirmed/i.test(t)) return 'ایمیل شما هنوز تأیید نشده است.';
        if (/User already registered/i.test(t)) return 'این ایمیل قبلاً ثبت‌نام کرده است.';
        if (/Password should be at least/i.test(t)) return 'رمز عبور باید حداقل ۶ کاراکتر باشد.';
        if (/rate limit|too many/i.test(t)) return 'تعداد تلاش زیاد بود؛ کمی صبر کنید.';
        if (/row-level security|permission denied/i.test(t)) return 'اجازه‌ی این کار را ندارید.';
        if (/Failed to fetch|NetworkError|fetch failed/i.test(t)) return 'ارتباط با سرور برقرار نشد؛ اینترنت را بررسی کنید.';
        return t || 'خطای ناشناخته';
    }

    /* ---- درخواست پایه ---------------------------------------------------- */
    function headers(extra) {
        var h = {
            'apikey': cfg.anonKey,
            'Authorization': 'Bearer ' + ((session && session.access_token) || cfg.anonKey),
            'Content-Type': 'application/json'
        };
        for (var k in (extra || {})) h[k] = extra[k];
        return h;
    }

    function request(path, options) {
        options = options || {};
        if (!isConfigured()) {
            return Promise.reject(new Error('سیستم حساب کاربری هنوز پیکربندی نشده است.'));
        }
        return fetch(cfg.url + path, {
            method: options.method || 'GET',
            headers: headers(options.headers),
            body: options.body ? JSON.stringify(options.body) : undefined,
            cache: 'no-store'
        }).then(function (res) {
            return res.text().then(function (text) {
                var data = null;
                if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
                if (!res.ok) {
                    var msg = (data && (data.message || data.error_description ||
                                        data.error || data.msg || data.hint)) || text ||
                              ('HTTP ' + res.status);
                    var err = new Error(humanize(msg));
                    err.raw = msg; err.status = res.status;
                    throw err;
                }
                return data;
            });
        }, function (netErr) {
            throw new Error(humanize(netErr && netErr.message));
        });
    }

    function rest(path, options)  { return request('/rest/v1' + path, options); }
    function rpc(fn, args)        { return rest('/rpc/' + fn, { method: 'POST', body: args || {} }); }

    /* ---- تازه‌سازی توکن -------------------------------------------------- */
    function refreshIfNeeded() {
        if (!session || !session.refresh_token) return Promise.resolve(false);
        var expiresAt = session.expires_at || 0;
        if (expiresAt * 1000 > Date.now() + 60000) return Promise.resolve(false);
        return request('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST', body: { refresh_token: session.refresh_token }
        }).then(function (data) {
            applyAuthResponse(data);
            return true;
        }).catch(function () { storeSession(null); return false; });
    }

    function applyAuthResponse(data) {
        if (!data || !data.access_token) return null;
        var expiresAt = data.expires_at ||
            Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
        return storeSession({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: expiresAt,
            user: data.user || (session && session.user) || null
        });
    }

    /* ---- ثبت‌نام / ورود / خروج ------------------------------------------- */
    function checkUsername(name) {
        return rpc('username_available', { p_username: name });
    }

    function signUp(opts) {
        var username = String(opts.username || '').trim();
        var email = String(opts.email || '').trim();
        var password = String(opts.password || '');

        if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return Promise.reject(new Error(MESSAGES.USERNAME_INVALID));
        if (!/^\S+@\S+\.\S+$/.test(email))          return Promise.reject(new Error('ایمیل معتبر وارد کنید.'));
        if (password.length < 6)                    return Promise.reject(new Error('رمز عبور باید حداقل ۶ کاراکتر باشد.'));

        return checkUsername(username).then(function (free) {
            if (free === false) throw new Error(MESSAGES.USERNAME_TAKEN);
            return request('/auth/v1/signup', {
                method: 'POST',
                body: { email: email, password: password, data: { mc_username: username } }
            });
        }).then(function (data) {
            if (data && data.access_token) { applyAuthResponse(data); return { session: true, user: data.user }; }
            return { session: false, user: data && data.user, needsConfirm: true };
        });
    }

    // ورود با ایمیل یا نام ماینکرفتی
    function signIn(login, password) {
        var id = String(login || '').trim();
        if (!id) return Promise.reject(new Error('نام کاربری یا ایمیل را وارد کنید.'));

        // نام ماینکرفتی را به ایمیل ترجمه می‌کنیم. رمز عبور هم فرستاده می‌شود
        // چون سرور فقط در صورت درست بودن رمز ایمیل را برمی‌گرداند (تا کسی
        // نتواند با حدس زدن نام کاربری، ایمیل بازیکنان را جمع کند).
        var resolveEmail = id.indexOf('@') > -1
            ? Promise.resolve(id)
            : rpc('email_for_login', { p_login: id, p_password: password })
                  .then(function (mail) {
                      if (!mail) throw new Error('نام کاربری یا رمز عبور اشتباه است.');
                      return mail;
                  });

        return resolveEmail.then(function (email) {
            return request('/auth/v1/token?grant_type=password', {
                method: 'POST', body: { email: email, password: password }
            });
        }).then(function (data) {
            applyAuthResponse(data);
            return session;
        });
    }

    function signOut() {
        var done = function () { storeSession(null); };
        if (!session) { done(); return Promise.resolve(); }
        return request('/auth/v1/logout', { method: 'POST' }).then(done, done);
    }

    // The page the recovery link should come back to. Works from any
    // sub-directory (GitHub Pages serves this site under /Netheraxia/).
    function siteUrl() {
        if (typeof location === 'undefined') return '';
        var path = location.pathname.replace(/[^/]*$/, '');   // strip the filename
        return location.origin + path;
    }

    function resetPassword(email) {
        var target = siteUrl() + '?recovery=1';
        return request('/auth/v1/recover?redirect_to=' + encodeURIComponent(target), {
            method: 'POST',
            body: { email: String(email || '').trim() }
        });
    }

    // Supabase returns the tokens in the URL fragment:
    //   #access_token=...&refresh_token=...&type=recovery
    // Read them, adopt the session, and clean the address bar so the
    // tokens are not left sitting in history.
    function consumeRecoveryLink() {
        if (typeof location === 'undefined') return null;
        var frag = String(location.hash || '').replace(/^#/, '');
        var qs   = String(location.search || '').replace(/^\?/, '');
        var p    = new URLSearchParams(frag || qs);

        var errDesc = p.get('error_description') || p.get('error');
        if (errDesc) {
            cleanUrl();
            return { error: /expired|invalid/i.test(errDesc)
                ? 'لینک بازیابی منقضی یا نامعتبر است. دوباره درخواست بدهید.'
                : decodeURIComponent(errDesc) };
        }

        var token = p.get('access_token');
        var type  = p.get('type');
        if (!token || type !== 'recovery') return null;

        storeSession({
            access_token: token,
            refresh_token: p.get('refresh_token'),
            expires_at: Math.floor(Date.now() / 1000) + parseInt(p.get('expires_in') || '3600', 10),
            user: null
        });
        cleanUrl();
        return { recovery: true };
    }

    function cleanUrl() {
        try {
            if (typeof history !== 'undefined' && history.replaceState) {
                history.replaceState(null, '', location.pathname);
            }
        } catch (e) {}
    }

    // Set a new password for the signed-in (or just-recovered) user.
    function updatePassword(newPassword) {
        if (String(newPassword || '').length < 6) {
            return Promise.reject(new Error('رمز عبور باید حداقل ۶ کاراکتر باشد.'));
        }
        if (!isLoggedIn()) {
            return Promise.reject(new Error('لینک بازیابی معتبر نیست؛ دوباره درخواست بدهید.'));
        }
        return request('/auth/v1/user', {
            method: 'PUT', body: { password: String(newPassword) }
        });
    }

    /* ---- پروفایل --------------------------------------------------------- */
    // Ask the auth server who this token belongs to, and cache it on the
    // session. Needed because a restored/refreshed session may carry no user.
    function fetchUser() {
        if (!isLoggedIn()) return Promise.resolve(null);
        if (session.user && session.user.id) return Promise.resolve(session.user);
        return request('/auth/v1/user').then(function (u) {
            if (u && u.id) { session.user = u; storeSession(session); }
            return u || null;
        });
    }

    function myProfile() {
        if (!isLoggedIn()) return Promise.resolve(null);
        return fetchUser().then(function (u) {
            if (!u || !u.id) return null;
            return rest('/profiles?select=*&id=eq.' + u.id + '&limit=1')
                .then(function (rows) {
                    var row = (rows && rows[0]) || null;
                    // RLS lets a player read only their own row; fall back to
                    // the auth record so the name is never blank.
                    if (!row && u.user_metadata && u.user_metadata.mc_username) {
                        row = { id: u.id, mc_username: u.user_metadata.mc_username,
                                email: u.email, is_admin: false, is_banned: false,
                                created_at: u.created_at };
                    }
                    return row;
                });
        });
    }

    /* ---- تیم‌ها ----------------------------------------------------------- */
    function getConfig() { return rpc('public_config'); }

    function listTeams() {
        return rest('/teams_public?select=*&order=created_at.asc');
    }

    function myMembership() {
        if (!isLoggedIn()) return Promise.resolve(null);
        return rpc('my_membership');
    }

    function createTeam(team) {
        if (!isLoggedIn()) return Promise.reject(new Error('اول وارد حساب خود شوید.'));
        var name = String(team.name || '').trim();
        if (name.length < 2 || name.length > 24) {
            return Promise.reject(new Error('نام تیم باید بین ۲ تا ۲۴ کاراکتر باشد.'));
        }
        var flag = team.flag ? String(team.flag) : null;
        if (flag && flag.length > 400000) {
            return Promise.reject(new Error('تصویر پرچم خیلی بزرگ است؛ عکس کوچک‌تری انتخاب کنید.'));
        }
        return fetchUser().then(function (u) {
            if (!u || !u.id) throw new Error('نشست معتبر نیست؛ دوباره وارد شوید.');
            return rest('/teams', {
                method: 'POST',
                headers: { 'Prefer': 'return=representation' },
                body: {
                    name: name,
                    description: String(team.description || '').trim().slice(0, 200) || null,
                    emoji: team.emoji || '🛡️',
                    flag: flag,
                    color: team.color || '#2f86ff',
                    owner_id: u.id
                }
            });
        }).then(function (rows) { return (rows && rows[0]) || null; });
    }

    function joinTeam(teamId) {
        if (!isLoggedIn()) return Promise.reject(new Error('اول وارد حساب خود شوید.'));
        return fetchUser().then(function (u) {
            if (!u || !u.id) throw new Error('نشست معتبر نیست؛ دوباره وارد شوید.');
            return rest('/team_members', {
                method: 'POST',
                headers: { 'Prefer': 'return=representation' },
                body: { team_id: teamId, user_id: u.id, is_leader: false }
            });
        });
    }

    function leaveTeam(teamId) {
        if (!isLoggedIn()) return Promise.reject(new Error('اول وارد حساب خود شوید.'));
        return fetchUser().then(function (u) {
            if (!u || !u.id) throw new Error('نشست معتبر نیست؛ دوباره وارد شوید.');
            return rest('/team_members?team_id=eq.' + teamId + '&user_id=eq.' + u.id,
                        { method: 'DELETE' });
        });
    }

    function kickMember(teamId, userId) {
        return rest('/team_members?team_id=eq.' + teamId + '&user_id=eq.' + userId,
                    { method: 'DELETE' });
    }

    function deleteTeam(teamId) {
        return rest('/teams?id=eq.' + teamId, { method: 'DELETE' });
    }

    function updateTeam(teamId, patch) {
        return rest('/teams?id=eq.' + teamId, { method: 'PATCH', body: patch });
    }

    function transferLeadership(teamId, newOwnerId) {
        return rpc('transfer_leadership', { p_team_id: teamId, p_new_owner: newOwnerId });
    }

    /* ---- مدیریت (ادمین) --------------------------------------------------- */
    function getSettings() {
        return rest('/app_settings?select=*&id=eq.1&limit=1')
            .then(function (rows) { return (rows && rows[0]) || null; });
    }
    function updateSettings(patch) {
        patch.updated_at = new Date().toISOString();
        return rest('/app_settings?id=eq.1', {
            method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: patch
        });
    }
    function listPlayers() {
        return rest('/profiles?select=*&order=created_at.desc');
    }
    function setPlayerFlags(userId, patch) {
        return rest('/profiles?id=eq.' + userId, { method: 'PATCH', body: patch });
    }
    function adminAddMember(teamId, userId) {
        return rest('/team_members', {
            method: 'POST', headers: { 'Prefer': 'return=representation' },
            body: { team_id: teamId, user_id: userId, is_leader: false }
        });
    }

    /* ---- راه‌اندازی ------------------------------------------------------- */
    function init() {
        loadConfig();
        loadSession();
        return refreshIfNeeded().then(function () { return session; });
    }

    try { loadConfig(); } catch (e) {}

    global.NXAuth = {
        init: init,
        loadConfig: loadConfig, saveConfig: saveConfig, isConfigured: isConfigured,
        config: function () { return { url: cfg.url, anonKey: cfg.anonKey }; },
        session: function () { return session; },
        user: currentUser, isLoggedIn: isLoggedIn,
        signUp: signUp, signIn: signIn, signOut: signOut, resetPassword: resetPassword,
        fetchUser: fetchUser,
        consumeRecoveryLink: consumeRecoveryLink, updatePassword: updatePassword, siteUrl: siteUrl,
        checkUsername: checkUsername, myProfile: myProfile,
        getConfig: getConfig, listTeams: listTeams, myMembership: myMembership,
        createTeam: createTeam, joinTeam: joinTeam, leaveTeam: leaveTeam,
        kickMember: kickMember, deleteTeam: deleteTeam, updateTeam: updateTeam,
        transferLeadership: transferLeadership,
        getSettings: getSettings, updateSettings: updateSettings,
        listPlayers: listPlayers, setPlayerFlags: setPlayerFlags,
        adminAddMember: adminAddMember,
        humanize: humanize, rest: rest, rpc: rpc, refresh: refreshIfNeeded
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
