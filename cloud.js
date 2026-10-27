/* =========================================================
   学业互助 · 云端接入层
   ---------------------------------------------------------
   职责边界：
     CloudAuth  —— 账号体系（邮箱密码 / 邮箱验证码 / 手机验证码 / 微信授权）
     CloudData  —— 数据读写（问答、回答、资料、点赞、计数、文件）
   本文件不碰 DOM，UI 由 app.js 负责。
   ========================================================= */
(function (global) {
  'use strict';

  /* publicConfig：由云服务开通结果直接下发，前端唯一允许持有的凭据。
     只需 endpoint + publishableKey（Web 端微信登录还需 oauthRelayBaseUrl）。 */
  const CONFIG = {
    resourceId: 'wbcs_BkYX7kh0sIZaj6lO3IkY94',
    endpoint: 'https://scnu-study-hub.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_O2ngHzth8TvlF9B3wjtN2u_PfNR4fC06x7efmmpDT55K6j4c7tQTIo1'
  };

  const TBL = {
    questions: 'questions',
    answers: 'answers',
    resources: 'resources',
    votes: 'answer_votes',
    profiles: 'profiles',
    courses: 'courses',
    favorites: 'favorites',
    follows: 'course_follows',
    ai: 'ai_sessions',
    notifs: 'notifications'
  };

  /* 上传限制：与后端无关的前端前置校验，避免无谓请求 */
  const UPLOAD = {
    maxBytes: 20 * 1024 * 1024,
    exts: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'zip', 'rar', '7z',
      'txt', 'md', 'csv', 'c', 'cpp', 'h', 'java', 'py', 'js', 'json', 'png', 'jpg', 'jpeg',
      /* 提问附件 / AI 附件常用的文本与图片格式 */
      'html', 'htm', 'css', 'ts', 'go', 'rs', 'sql', 'xml', 'yml', 'yaml', 'tex', 'log',
      'ipynb', 'gif', 'webp']
  };

  let client = null;
  let initError = null;

  /* 云端只接受与 endpoint 完全一致的 Origin。
     如果把 index.html 当本地文件双击打开（file://），或者从别的域名 / 预览链接进来，
     所有 /.cloud 请求都会被浏览器按跨域拦掉，表现就是 Safari 报「TypeError: Load failed」、
     列表全空、登录必然失败。这里提前识别，直接告诉用户该怎么打开。 */
  const ORIGIN_MISMATCH = (function () {
    try {
      const here = global.location && global.location.origin;
      if (!here || here === 'null') return '本地文件';
      if (here === CONFIG.endpoint) return '';
      return here;
    } catch (e) { return ''; }
  })();

  if (ORIGIN_MISMATCH) {
    initError = ORIGIN_MISMATCH === '本地文件'
      ? '当前是直接打开本地文件，云端功能不可用。请改从 https://scnu-study-hub.app.workbuddy.host/ 访问。'
      : '当前域名（' + ORIGIN_MISMATCH + '）无权调用云端服务，请改用 https://scnu-study-hub.app.workbuddy.host/ 访问本站。';
  } else if (!global.WorkBuddyCloud || typeof global.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
    initError = '云端 SDK 未能加载，页面只能浏览缓存内容。请检查网络后刷新。';
  } else {
    try {
      client = global.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CONFIG.endpoint,
        oauthRelayBaseUrl: CONFIG.oauthRelayBaseUrl,
        publishableKey: CONFIG.publishableKey
      });
    } catch (e) {
      initError = '云端服务初始化失败：' + (e && e.message ? e.message : '未知原因');
      client = null;
    }
  }

  /* ---------------- 错误文案归一 ---------------- */

  /* 服务端错误文案本地化：命中已知模式就换成中文，未命中的原样返回 */
  const AUTH_MESSAGE_ZH = [
    [/incorrect|invalid.{0,12}(password|credential)|wrong password|bad password/i, '邮箱或密码不正确，请重试。'],
    [/(code|token|otp).{0,20}(expired)|expired.{0,20}(code|token|otp)/i, '验证码已过期，请重新获取。'],
    [/invalid.{0,12}(code|token|otp|verification)/i, '验证码不正确，请重新输入。'],
    [/too many|rate.?limit|频繁|per minute|up to \d+ .{0,12}(message|email|code)/i, '发送太频繁了，同一邮箱 / 手机号每分钟只能发一次，请稍后再试。'],
    [/password.{0,20}(required|missing)|(required|missing).{0,20}password/i, '该邮箱首次使用，需要先设置密码完成注册。'],
    [/(not found|no such user|user not exist)/i, '账号不存在或凭证不正确。']
  ];

  function localize(message) {
    if (!message) return message;
    for (let i = 0; i < AUTH_MESSAGE_ZH.length; i++) {
      if (AUTH_MESSAGE_ZH[i][0].test(message)) return AUTH_MESSAGE_ZH[i][1];
    }
    return message;
  }

  function authError(error) {
    if (!error) return '操作失败，请稍后重试。';
    const kind = error.kind || '';
    if (kind === 'unauthenticated' || kind === 'invalid_grant') return '登录状态已失效，请重新登录。';
    if (kind === 'network' || kind === 'backend-unavailable') return '网络异常或服务暂时不可用，请稍后重试。';
    if (error.code === '429') return '请求过于频繁，请稍后再试。';
    return localize(error.message || String(error));
  }

  function authFail(error) {
    return { ok: false, kind: (error && error.kind) || '', message: authError(error) };
  }

  function dbError(error) {
    if (!error) return '操作失败，请稍后重试。';
    const code = error.code;
    const msg = String(error.message || '');

    // 行级安全与权限这两种拒绝，服务端返回的 code 不一定稳定，因此同时看文案
    if (/login required|not authenticated|jwt/i.test(msg)) return '请先登录后再操作。';
    if (code === '42501' || /permission denied|row-level security|violates row-level/i.test(msg)) {
      return '没有权限执行该操作，请确认已登录，且内容属于你本人。';
    }
    if (code === '23505' || /duplicate key/i.test(msg)) return '该内容已存在，请勿重复提交。';
    if (code === '23503' || /foreign key/i.test(msg)) return '关联的内容不存在或已被删除。';
    if (code === '42P01' || /does not exist/i.test(msg)) return '数据表尚未就绪，请联系管理员。';
    if (code === 'P0002') return '目标内容不存在或已被删除。';
    return localize(msg) || '操作失败，请稍后重试。';
  }

  function storageError(error) {
    if (!error) return '文件操作失败，请稍后重试。';
    if (error.name === 'CloudStoragePathError') return '文件路径不合法，无法上传。';
    const msg = String(error.message || error);
    if (/failed to fetch|network|load failed|timeout/i.test(msg)) {
      return '无法连接云端存储，请确认已登录并检查网络后重试。';
    }
    if (/login required|permission denied|not authenticated/i.test(msg)) {
      return '请先登录后再上传或下载文件。';
    }
    return localize(msg);
  }

  function guard() {
    if (!client) throw new Error(initError || '云端服务未就绪');
  }

  /* =========================================================
     账号端点直连
     ---------------------------------------------------------
     SDK 只封装了「邮箱」版的重置 / 设置密码；同一组服务端端点
     其实同时接受手机号（实测 /v1/verification 传 phone_number +
     usage=PASSWORD_RESET 会正常校验账号），因此手机号账号也能
     自助设置密码，不必先有邮箱。
     ========================================================= */

  const AUTH_BASE = '/.cloud/auth';

  /** 与 SDK 内部一致：11 位大陆手机号归一化成 "+86 138xxxxxxxx" */
  function toE164(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (/^0086\d{11}$/.test(digits)) return '+86 ' + digits.slice(4);
    if (/^86\d{11}$/.test(digits)) return '+86 ' + digits.slice(2);
    if (/^1\d{10}$/.test(digits)) return '+86 ' + digits;
    return String(phone || '').trim();
  }

  /** 反向：把 "+86 138xxxxxxxx" 还原成 11 位，用于表单预填 */
  function toLocalPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (/^0086\d{11}$/.test(digits)) return digits.slice(4);
    if (/^86\d{11}$/.test(digits)) return digits.slice(2);
    return digits;
  }

  function resetErrorText(desc) {
    const msg = String(desc || '');
    if (/账号不存在|not found|no such|user not exist/i.test(msg)) return '该账号还没有在平台上注册，请先注册。';
    if (/(verification|token).{0,24}(invalid|expired|incorrect|not match)|(invalid|expired|incorrect).{0,24}(verification|token)/i.test(msg)) {
      return '验证码不正确或已过期，请重新获取。';
    }
    if (/per minute|too many|rate.?limit|频繁/i.test(msg)) return '发送太频繁了，同一账号每分钟只能发一次，请稍后再试。';
    if (/password/i.test(msg) && /short|length|least|weak|invalid|require/i.test(msg)) return '新密码不符合要求，请至少 6 位。';
    return localize(msg) || '操作失败，请稍后重试。';
  }

  /** 直接调用账号端点，返回统一的 { ok, data | message } */
  async function authHttp(path, body) {
    try {
      const res = await global.fetch(CONFIG.endpoint + AUTH_BASE + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wb-webapp-access-key': CONFIG.publishableKey
        },
        body: JSON.stringify(body)
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        const desc = (data && (data.error_description || data.message || data.error)) || '';
        return { ok: false, message: resetErrorText(desc) };
      }
      return { ok: true, data: data || {} };
    } catch (e) {
      return { ok: false, message: '网络异常，请检查网络后重试。' };
    }
  }

  /* =========================================================
     CloudAuth
     ========================================================= */

  const CloudAuth = {
    get enabled() { return !!client; },
    get initError() { return initError; },

    async getSession() {
      if (!client) return { session: null, error: initError };
      const { data, error } = await client.auth.getSession();
      if (error) return { session: null, error: authError(error) };
      return { session: data || null, error: null };
    },

    /** 读取当前用户的账号资料（邮箱 / 手机号等），用于设置页展示绑定情况 */
    async getUser() {
      if (!client) return { ok: false, user: null, message: initError };
      if (typeof client.auth.getUser !== 'function') return { ok: false, user: null, message: '当前云端版本不支持读取账号资料。' };
      const { data, error } = await client.auth.getUser();
      if (error) return { ok: false, user: null, message: authError(error) };
      return { ok: true, user: data || null };
    },

    /**
     * 读取当前账号同时绑定的登录方式（邮箱 / 手机号）与是否已有密码。
     * 平台 getUser 未必会带出手机号，所以以数据库 my_contacts() 为准。
     */
    async getMyContacts() {
      if (!client || typeof client.database.rpc !== 'function') {
        return { ok: false, email: '', phone: '', hasPassword: null };
      }
      try {
        const { data, error } = await client.database.rpc('my_contacts', {});
        if (error) return { ok: false, email: '', phone: '', hasPassword: null, message: dbError(error) };
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || row.ok !== true) return { ok: false, email: '', phone: '', hasPassword: null };
        return {
          ok: true,
          email: row.email || '',
          phone: row.phone || '',
          hasPassword: row.has_password === true
        };
      } catch (e) {
        return { ok: false, email: '', phone: '', hasPassword: null };
      }
    },

    onAuthStateChange(cb) {
      if (!client) return null;
      try { return client.auth.onAuthStateChange(cb); } catch (e) { return null; }
    },

    /**
     * 密码登录：account 传字符串＝邮箱，传 { phone } 则为手机号账号。
     * SDK 内部会把手机号归一化成 +86 xxx 作为账号名。
     */
    async signInWithPassword(account, password) {
      guard();
      const body = typeof account === 'string'
        ? { email: account, password: password }
        : Object.assign({}, account, { password: password });
      const { data, error } = await client.auth.signInWithPassword(body);
      if (error) return authFail(error);
      return { ok: true, session: data };
    },

    /** 发送验证码：email 与 phone 互斥，只传其中一个 */
    async sendOtp(target) {
      guard();
      const { data, error } = await client.auth.sendOtp(target);
      if (error) return authFail(error);
      return {
        ok: true,
        verificationId: data.verificationId,
        isExistingUser: data.isExistingUser
      };
    },

    /**
     * 校验验证码并建立会话。
     * @param {{email?:string, phone?:string, verificationId:string,
     *          isExistingUser:boolean, token:string, password?:string}} payload
     */
    async verifyOtp(payload) {
      guard();
      const { data, error } = await client.auth.verifyOtp(payload);
      if (error) return authFail(error);
      return { ok: true, session: data };
    },

    /**
     * 只校验验证码，不建立会话。
     * 用于「给已登录账号加绑第二种登录方式」——此时不能走 verifyOtp，
     * 否则会把当前会话换成被验证的那个身份。
     */
    async verifyCodeOnly(verificationId, code) {
      if (!verificationId) return { ok: false, message: '验证码已失效，请重新发送。' };
      const res = await authHttp('/v1/verification/verify', {
        verification_id: verificationId,
        verification_code: String(code || '')
      });
      if (!res.ok) return { ok: false, message: res.message };
      const token = res.data && res.data.verification_token;
      if (!token) return { ok: false, message: '验证码校验失败，请重新获取。' };
      return { ok: true, token: token };
    },

    /**
     * 忘记密码 / 给账号补密码 第 1 步：发送重置验证码。
     * target 传 'a@b.com' 或 { email } 走邮箱；传 { phone: '138...' } 走短信。
     * 返回带 updateUser({nonce, password}) 的句柄，行为与 SDK 邮箱版一致。
     */
    async startPasswordReset(target) {
      guard();
      const isPhone = !!target && typeof target === 'object' && !!target.phone;

      if (!isPhone) {
        const email = typeof target === 'string' ? target : (target && target.email) || '';
        const { data, error } = await client.auth.resetPasswordForEmail(email);
        if (error) return authFail(error);
        return { ok: true, method: 'email', handle: data };
      }

      const phone = toE164(target.phone);
      const sent = await authHttp('/v1/verification', {
        phone_number: phone,
        usage: 'PASSWORD_RESET',
        target: 'USER'
      });
      if (!sent.ok) return { ok: false, method: 'phone', message: sent.message };

      const vid = sent.data && sent.data.verification_id;
      if (!vid) return { ok: false, method: 'phone', message: '验证码发送失败，请稍后重试。' };

      return {
        ok: true,
        method: 'phone',
        handle: {
          verificationId: vid,
          phone: phone,
          /* 与 SDK 的 handle.updateUser 同签名，调用方无需区分邮箱 / 手机号 */
          updateUser: async function (payload) {
            const checked = await authHttp('/v1/verification/verify', {
              verification_id: vid,
              verification_code: (payload && payload.nonce) || ''
            });
            if (!checked.ok) return { ok: false, message: checked.message };

            const token = checked.data && checked.data.verification_token;
            if (!token) return { ok: false, message: '验证码校验失败，请重新获取。' };

            const written = await authHttp('/v1/reset', {
              phone_number: phone,
              new_password: (payload && payload.password) || '',
              verification_token: token
            });
            if (!written.ok) return { ok: false, message: written.message };

            // 与邮箱版一致：设置成功后顺带登录，未登录场景可直接继续使用
            try {
              const login = await client.auth.signInWithPassword({ phone: phone, password: payload.password });
              return { ok: true, session: login && !login.error ? login.data : null };
            } catch (e) {
              return { ok: true, session: null };
            }
          }
        }
      };
    },

    /** 第 2 步：用验证码写入新密码（邮箱 / 手机号句柄通用） */
    async finishPasswordReset(handle, nonce, password) {
      if (!handle || typeof handle.updateUser !== 'function') {
        return { ok: false, message: '请先获取重置验证码。' };
      }
      const out = await handle.updateUser({ nonce, password });
      if (!out) return { ok: false, message: '设置失败，请稍后重试。' };
      if (out.error) return authFail(out.error);
      if (out.ok === false) return { ok: false, message: out.message || '设置失败，请稍后重试。' };
      return { ok: true, session: out.session || out.data || null };
    },

    /**
     * 已登录状态下修改密码：先用旧密码换取 sudo 凭证，再写入新密码。
     * 部分账号（例如短信验证码注册、没有设置过密码）会失败，需要引导走「忘记密码」。
     */
    async changePassword(oldPassword, newPassword) {
      guard();
      if (typeof client.auth.resetPasswordForOld !== 'function') {
        return { ok: false, message: '当前云端版本不支持站内改密，请退出后用「忘记密码」重置。' };
      }
      const { data, error } = await client.auth.resetPasswordForOld({
        oldPassword: oldPassword,
        newPassword: newPassword
      });
      if (error) {
        const msg = String(error.message || '');
        if (error.status === 401 || error.status === 403 ||
            /incorrect|invalid|wrong|password|sudo/i.test(msg)) {
          return { ok: false, message: '当前密码不正确，请重新输入。' };
        }
        return authFail(error);
      }
      return { ok: true, session: data };
    },

    /**
     * 给当前账号加绑第二种登录方式（email / phone）。
     * 平台注册接口只收一种登录名，但账号表本身同时有 email 与 phone_number 两列，
     * 由 bind_contact 这个 SECURITY DEFINER 函数在服务端写入，登录时两种标识都会命中同一账号。
     */
    async bindContact(kind, value) {
      guard();
      if (typeof client.database.rpc !== 'function') {
        return { ok: false, message: '当前云端版本不支持绑定，请刷新页面重试。' };
      }
      const { data, error } = await client.database.rpc('bind_contact', { p_kind: kind, p_value: value });
      if (error) return { ok: false, message: dbError(error) };
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.ok !== true) {
        const code = row && row.code;
        const label = kind === 'phone' ? '手机号' : '邮箱';
        const message = code === 'TAKEN' ? '这个' + label + '已经被另一个账号占用了，需要先把那个账号处理掉。'
          : code === 'BAD_PHONE' ? '手机号格式不正确，请填写 11 位大陆手机号。'
          : code === 'BAD_EMAIL' ? '邮箱格式不正确，请检查后重试。'
          : code === 'NOAUTH' ? '登录状态已失效，请重新登录后再试。'
          : '绑定失败，请稍后重试。';
        return { ok: false, code: code, message: message };
      }
      return { ok: true, value: row.value || value };
    },

    /** 解绑第二种登录方式；若会导致账号没有任何登录名，服务端会拒绝 */
    async unbindContact(kind) {
      guard();
      if (typeof client.database.rpc !== 'function') {
        return { ok: false, message: '当前云端版本不支持解绑，请刷新页面重试。' };
      }
      const { data, error } = await client.database.rpc('unbind_contact', { p_kind: kind });
      if (error) return { ok: false, message: dbError(error) };
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.ok !== true) {
        const code = row && row.code;
        return {
          ok: false,
          code: code,
          message: code === 'LAST'
            ? '这是当前账号唯一的登录方式，解绑后就无法登录了，所以没有解除。'
            : '解绑失败，请稍后重试。'
        };
      }
      return { ok: true };
    },

    /** 微信授权登录：返回跳转地址，由 SDK 之外的代码负责导航 */
    async startWechatLogin() {
      guard();
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'wechat',
        redirectTo: global.location.origin
      });
      if (error) return authFail(error);
      const url = data && data.url;
      if (!url) return { ok: false, message: '未能获取微信授权地址，请稍后重试。' };
      return { ok: true, url };
    },

    /** 应用启动时无条件调用：消费 ?code=&state= ，无 code 时返回 session=null 且不报错 */
    async handleWechatCallback() {
      if (!client || typeof client.auth.handleWechatWebCallback !== 'function') {
        return { session: null, error: null };
      }
      const { data, error } = await client.auth.handleWechatWebCallback();
      if (error) return { session: null, error: authError(error) };
      return { session: data || null, error: null };
    },

    async signOut() {
      guard();
      const { error } = await client.auth.signOut();
      if (error) return authFail(error);
      return { ok: true };
    }
  };

  /* =========================================================
     CloudData
     ========================================================= */

  const CloudData = {
    UPLOAD,

    /** 一次性拉取全部业务数据；返回原始行，由 app.js 转成内存模型 */
    async fetchAll(uid) {
      guard();
      const EMPTY = Promise.resolve({ data: [], error: null });
      const [q, a, r, v, p, c, f, cf] = await Promise.all([
        client.database.from(TBL.questions).select('*').order('created_at', { ascending: false }).limit(500),
        client.database.from(TBL.answers).select('*').order('created_at', { ascending: true }).limit(2000),
        client.database.from(TBL.resources).select('*').order('created_at', { ascending: false }).limit(500),
        client.database.from(TBL.votes).select('answer_id'),
        uid
          ? client.database.from(TBL.profiles).select('*').eq('owner_id', uid).limit(1)
          : EMPTY,
        client.database.from(TBL.courses).select('*').order('sort_order', { ascending: true }).limit(200),
        // 收藏 / 关注课程：行级安全自动只返回本人行，客户端无需按 uid 过滤
        uid ? client.database.from(TBL.favorites).select('*') : EMPTY,
        uid ? client.database.from(TBL.follows).select('*') : EMPTY
      ]);

      const failed = [q, a, r, v, p, c, f, cf].find((x) => x && x.error);
      if (failed) throw new Error(dbError(failed.error));

      return {
        questions: q.data || [],
        answers: a.data || [],
        resources: r.data || [],
        votes: v.data || [],
        profiles: p.data || [],
        courses: c.data || [],
        favorites: f.data || [],
        follows: cf.data || []
      };
    },

    async insertQuestion(row) {
      guard();
      const { data, error } = await client.database.from(TBL.questions).insert(row).select();
      if (error) throw new Error(dbError(error));
      if (!data || !data.length) throw new Error('问题未能保存，请确认已登录后重试。');
      return data[0];
    },

    async insertAnswer(row) {
      guard();
      const { data, error } = await client.database.from(TBL.answers).insert(row).select();
      if (error) throw new Error(dbError(error));
      if (!data || !data.length) throw new Error('回答未能保存，请确认已登录后重试。');
      return data[0];
    },

    async insertResource(row) {
      guard();
      const { data, error } = await client.database.from(TBL.resources).insert(row).select();
      if (error) throw new Error(dbError(error));
      if (!data || !data.length) throw new Error('资料未能保存，请确认已登录后重试。');
      return data[0];
    },

    /** 回写 AI 摘要（仅资料上传者本人可写，行级安全限定 owner_id） */
    async updateResourceSummary(id, summary, aiReady) {
      guard();
      const { data, error } = await client.database
        .from(TBL.resources)
        .update({
          summary: String(summary || ''),
          ai_ready: aiReady === undefined ? true : !!aiReady,
          updated_at: new Date().toISOString()
        })
        .eq('id', Number(id))
        .select();
      if (error) throw new Error(dbError(error));
      if (!data || !data.length) throw new Error('摘要未能写回，只有上传者本人可以更新该资料。');
      return data[0];
    },

    /** 删除问题（级联删除其下回答与投票由数据库外键负责） */
    async deleteQuestion(id) {
      guard();
      const { data, error } = await client.database.from(TBL.questions).delete().eq('id', Number(id)).select();
      if (error) throw new Error(dbError(error));
      if (!data || !data.length) throw new Error('只有提问者本人可以删除该问题。');
    },

    async deleteAnswer(id) {
      guard();
      const { data, error } = await client.database.from(TBL.answers).delete().eq('id', Number(id)).select();
      if (error) throw new Error(dbError(error));
      if (!data || !data.length) throw new Error('只有回答者本人可以删除该回答。');
    },

    /** 采纳 / 取消采纳：写在自己名下的问题行上，行级安全天然限定为提问者 */
    async setAcceptedAnswer(questionId, answerId) {
      guard();
      const { data, error } = await client.database
        .from(TBL.questions)
        .update({ accepted_answer_id: answerId == null ? null : Number(answerId) })
        .eq('id', Number(questionId))
        .select();
      if (error) throw new Error(dbError(error));
      if (!data || !data.length) throw new Error('只有提问者本人可以采纳回答。');
    },

    /** 点赞：走数据库函数原子完成「取消/新增 + 计数」，返回最新票数 */
    async toggleVote(answerId) {
      guard();
      const { data, error } = await client.database.rpc('toggle_answer_vote', { a_id: Number(answerId) });
      if (error) throw new Error(dbError(error));
      return typeof data === 'number' ? data : null;
    },

    async bumpQuestionView(questionId) {
      if (!client) return null;
      const { data, error } = await client.database.rpc('bump_question_view', { q_id: Number(questionId) });
      if (error) return null; // 计数失败不影响阅读
      return typeof data === 'number' ? data : null;
    },

    async bumpResourceDownload(resourceId) {
      if (!client) return null;
      const { data, error } = await client.database.rpc('bump_resource_download', { r_id: Number(resourceId) });
      if (error) throw new Error(dbError(error));
      return typeof data === 'number' ? data : null;
    },

    /** 昵称：先更新本人资料行，不存在则新建；随后同步到本人已发布内容的署名 */
    async saveNickname(uid, nickname) {
      guard();
      const up = await client.database
        .from(TBL.profiles)
        .update({ nickname, updated_at: new Date().toISOString() })
        .eq('owner_id', uid)
        .select();

      if (up.error) throw new Error(dbError(up.error));

      if (!up.data || !up.data.length) {
        const ins = await client.database.from(TBL.profiles).insert({ nickname }).select();
        if (ins.error && ins.error.code !== '23505') throw new Error(dbError(ins.error));
      }

      await Promise.all([
        client.database.from(TBL.questions).update({ author: nickname }).eq('owner_id', uid),
        client.database.from(TBL.answers).update({ author: nickname }).eq('owner_id', uid),
        client.database.from(TBL.resources).update({ author: nickname }).eq('owner_id', uid)
      ]);
    },

    /**
     * 头像：把前端压缩好的 data URL 写进 profiles.avatar_url。
     * 不入对象存储——头像只有几十 KB，存成 data URL 不用签名、不会过期，
     * 换设备 / 重新登录都能立刻显示。传 null 表示换回默认首字头像。
     */
    async saveAvatar(uid, dataUrl, nickname) {
      guard();
      const patch = { avatar_url: dataUrl || null, updated_at: new Date().toISOString() };
      const up = await client.database
        .from(TBL.profiles)
        .update(patch)
        .eq('owner_id', uid)
        .select();

      if (up.error) throw new Error(dbError(up.error));

      if (!up.data || !up.data.length) {
        const ins = await client.database
          .from(TBL.profiles)
          .insert({ nickname: nickname || '华师同学', avatar_url: patch.avatar_url })
          .select();
        if (ins.error && ins.error.code !== '23505') throw new Error(dbError(ins.error));
      }
      return patch.avatar_url || '';
    },

    /**
     * 注销账号：服务端函数会先删本人全部内容行，再删 auth.users 里那一行。
     * 确认词必须由用户手动输入（服务端二次校验），避免误触。
     */
    async deleteAccount(confirmWord) {
      guard();
      if (typeof client.database.rpc !== 'function') {
        return { ok: false, message: '当前云端版本不支持注销，请刷新页面重试。' };
      }
      const { data, error } = await client.database.rpc('delete_my_account', { p_confirm: confirmWord });
      if (error) return { ok: false, message: dbError(error) };
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.ok !== true) {
        const code = row && row.code;
        return {
          ok: false,
          code: code,
          message: code === 'BAD_CONFIRM' ? '确认词不正确，请输入「注销」两个字。'
            : code === 'NOAUTH' ? '登录状态已失效，请重新登录后再试。'
            : '注销失败，请稍后重试。'
        };
      }
      return { ok: true };
    },

    /* ---------------- 收藏 / 关注课程 / AI 留痕 ---------------- */

    /** 切换收藏；返回 true 表示已收藏，false 表示已取消 */
    async toggleFavorite(targetType, targetId, wantOn) {
      guard();
      const t = String(targetType);
      const id = Number(targetId);
      if (wantOn) {
        const { error } = await client.database
          .from(TBL.favorites)
          .insert({ target_type: t, target_id: id });
        if (error && error.code !== '23505') throw new Error(dbError(error));
        return true;
      }
      const { error } = await client.database
        .from(TBL.favorites)
        .delete()
        .eq('target_type', t)
        .eq('target_id', id);
      if (error) throw new Error(dbError(error));
      return false;
    },

    /** 关注 / 取关课程 */
    async toggleCourseFollow(courseId, wantOn) {
      guard();
      const id = Number(courseId);
      if (wantOn) {
        const { error } = await client.database.from(TBL.follows).insert({ course_id: id });
        if (error && error.code !== '23505') throw new Error(dbError(error));
        return true;
      }
      const { error } = await client.database.from(TBL.follows).delete().eq('course_id', id);
      if (error) throw new Error(dbError(error));
      return false;
    },

    /* ---------------- 通知（有同学回答了我的问题） ----------------
       写入端不在前端：answers 表上的数据库触发器负责给提问者插入通知，
       这样无论从网页、还是以后的其它入口回答，提问者都不会漏。
       前端只读自己的行、只改自己的已读状态。 */

    /** 拉取我的通知（行级安全已限定 owner_id = 当前用户） */
    async fetchNotifications(uid, limit) {
      if (!client || !uid) return [];
      try {
        const { data, error } = await client.database
          .from(TBL.notifs)
          .select('*')
          .eq('owner_id', uid)
          .order('created_at', { ascending: false })
          .limit(limit || 100);
        if (error) return [];   // 通知属于增强信息，失败不打断主流程
        return data || [];
      } catch (e) {
        return [];
      }
    },

    /** 把这些通知标为已读；传空数组则不动 */
    async markNotificationsRead(ids) {
      guard();
      const list = (ids || []).map(Number).filter(function (n) { return n > 0; });
      if (!list.length) return true;
      const { error } = await client.database
        .from(TBL.notifs)
        .update({ read_at: new Date().toISOString() })
        .in('id', list);
      if (error) throw new Error(dbError(error));
      return true;
    },

    /** AI 调用留痕：失败不阻断主流程，静默返回 null */
    async saveAiSession(row) {
      if (!client) return null;
      try {
        const { data, error } = await client.database.from(TBL.ai).insert(row).select();
        if (error) return null;
        return data && data[0];
      } catch (e) {
        return null;
      }
    },

    /* ---------------- 文件存储 ---------------- */

    validateFile(file) {
      if (!file) return '请选择要上传的文件。';
      if (file.size <= 0) return '文件内容为空，请换一个文件。';
      if (file.size > UPLOAD.maxBytes) {
        return '文件超过 ' + Math.round(UPLOAD.maxBytes / 1024 / 1024) + ' MB 上限，请压缩后再上传。';
      }
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (UPLOAD.exts.indexOf(ext) === -1) {
        return '暂不支持 .' + (ext || '未知') + ' 格式，请上传 pdf / office 文档 / 压缩包 / 代码或图片。';
      }
      return null;
    },

    buildPath(uid, fileName, kind) {
      guard();
      const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
      const rand = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      // shared/<uid>/... ：所有已登录同学都可读，仅上传者可改删
      // kind：res（资料）/ qa（提问附件），仅决定目录，读写规则一致
      return client.storage.sharedPath(uid, (kind || 'res') + '/' + rand + '.' + ext);
    },

    async uploadFile(path, file) {
      guard();
      let res;
      try {
        res = await client.storage.upload(path, file, {
          contentType: file.type || 'application/octet-stream'
        });
      } catch (e) {
        throw new Error(storageError(e));
      }
      if (res && res.error) throw new Error(storageError(res.error));
      return res && res.data;
    },

    async getDownloadUrl(path, ttl) {
      guard();
      let res;
      try {
        res = await client.storage.createSignedUrl(path, ttl || 600);
      } catch (e) {
        throw new Error(storageError(e));
      }
      if (res && res.error) throw new Error(storageError(res.error));
      const d = res && res.data;
      if (!d) return null;
      return d.signedUrl || d.url || d.signedURL || (typeof d === 'string' ? d : null);
    }
  };

  /* =========================================================
     CloudAI —— 云服务免密钥大模型通道
     ---------------------------------------------------------
     约束（来自官方文档，必须遵守）：
       1. 必须 stream: true —— 非流式会被 SDK 以 request_stream_required 直接拒绝
       2. messages[0] 必须是应用自己的 system —— SDK 不会补默认值
       3. 一次性任务（摘要 / 提示）不传 conversationId
       4. 模型列表可能为空，必须显式处理，不能硬编码 model id 兜底
       5. `auto` 模型路由极慢（实测 60 秒不返回），必须显式指定模型 id
     ========================================================= */

  const AI_MODEL_PREFERENCE = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'hy3'];
  const VISION_MODEL_PREFERENCE = ['glm-5v-turbo', 'glm-4.6v'];
  let cachedModelId = null;
  let cachedVisionModelId = null;

  async function pickModel() {
    if (cachedModelId) return cachedModelId;
    const models = await client.llm.models.list();
    const usable = (models || []).filter((m) => m.disabled !== true);
    if (!usable.length) return null;
    const preferred = AI_MODEL_PREFERENCE
      .map((id) => usable.find((m) => m.id === id))
      .find(Boolean);
    cachedModelId = (preferred || usable[0]).id;
    return cachedModelId;
  }

  /* 能看图的模型：只在用户真的传了图片时才切过去 */
  async function pickVisionModel() {
    if (cachedVisionModelId) return cachedVisionModelId;
    const models = await client.llm.models.list();
    const usable = (models || []).filter((m) => m.disabled !== true);
    const preferred = VISION_MODEL_PREFERENCE
      .map((id) => usable.find((m) => m.id === id))
      .find(Boolean);
    if (!preferred) return null;
    cachedVisionModelId = preferred.id;
    return cachedVisionModelId;
  }

  function aiError(error) {
    const e = (error && error.error) ? error.error : {};
    const code = String(e.code || '');
    if (/^auth_/.test(code)) return '云端模型通道未授权，请检查应用配置。';
    if (/^quota_/.test(code)) return 'AI 额度已用完或请求过于频繁，请稍后再试。';
    if (/^request_/.test(code)) return 'AI 请求参数有误，请重试。';
    if (/^(gateway_|model_|internal_)/.test(code)) return 'AI 服务暂时不可用，请稍后重试。';
    return 'AI 调用失败：' + (e.message || (error && error.message) || '未知原因');
  }

  /* 统一的流式调用：网关 / 模型类错误重试一次；参数、额度、鉴权类错误不重试 */
  async function runChat(modelId, messages, opts) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let text = '';
        for await (const chunk of client.llm.chat.completions.create({
          model: modelId,
          messages: messages,
          stream: true,
          temperature: opts.temperature == null ? 0.6 : opts.temperature
        })) {
          const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (d && d.content) {
            text += d.content;
            if (opts.onDelta) opts.onDelta(d.content, text);
          }
        }
        if (!text) throw new Error('模型没有返回内容，请重试。');
        return text;
      } catch (e) {
        lastError = e;
        const code = (e && e.error && e.error.code) || '';
        if (!/^(gateway_|model_|internal_)/.test(code)) break;
      }
    }
    throw new Error(aiError(lastError));
  }

  const CloudAI = {
    ready() { return !!client; },

    /** 探测模型通道是否可用（不消耗额度） */
    async available() {
      if (!client) return false;
      try { return !!(await pickModel()); } catch (e) { return false; }
    },

    /** 流式对话；onDelta(chunk, fullText) 每收到一段文本回调一次，返回完整文本 */
    async chat(opts) {
      guard();
      const modelId = await pickModel();
      if (!modelId) throw new Error('当前没有可用的大模型，请稍后再试。');
      return runChat(modelId, [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user }
      ], opts);
    },

    /**
     * 看图对话：images 传 data URL（data:image/jpeg;base64,...）。
     * 自动切到视觉模型，其余规则与 chat 一致（必须流式）。
     */
    async chatWithImage(opts) {
      guard();
      const modelId = await pickVisionModel();
      if (!modelId) throw new Error('当前没有可用的视觉模型，请把图片里的文字打出来再试试。');

      const content = [{ type: 'text', text: opts.user }];
      (opts.images || []).forEach(function (url) {
        content.push({ type: 'image_url', image_url: { url: url } });
      });

      return runChat(modelId, [
        { role: 'system', content: opts.system },
        { role: 'user', content: content }
      ], opts);
    },

    /** 资料摘要：输入资料元信息（可选正文节选），返回中文摘要 */
    summarize(prompt, onDelta) {
      return this.chat({
        system: '你是学习资料摘要助手，服务对象是大学生。只依据用户给出的资料信息作答，绝不编造未提及的内容。'
          + '输出格式严格如下，不要写标题、不要用 markdown 符号：\n'
          + '第一段：100-160 字，说明这份资料讲什么、覆盖哪些内容、适合什么阶段使用。\n'
          + '换行写「要点：」，再用 1. 2. 3. 逐条列出 3 条要点，每条 15-25 字。\n'
          + '换行写「建议：」，一句话说明什么情况下值得一看，不超过 30 字。',
        user: prompt,
        temperature: 0.5,
        onDelta: onDelta
      });
    },

    /** 答疑提示：给思路不给答案 */
    hint(prompt, onDelta) {
      return this.chat({
        system: '你是大学生学习答疑助手。针对同学的问题：先点明考查的知识点，再给 2-3 步思路提示，'
          + '不要直接给出完整答案。用中文，简洁，总长不超过 150 字。',
        user: prompt,
        temperature: 0.6,
        onDelta: onDelta
      });
    }
  };

  /* =========================================================
     管理后台（CloudAdmin）
     ---------------------------------------------------------
     所有跨用户操作都走数据库 SECURITY DEFINER 函数：
     函数内部先校验 public.is_admin()，前端拿不到越权能力。
     ========================================================= */

  const ADMIN_MSG = {
    FORBIDDEN: '当前账号没有管理权限。',
    NOT_AUTH: '请先登录后再进管理后台。',
    BAD_CODE: '邀请码不正确，请确认后重试。',
    SELF: '不能在这里删除自己的账号。',
    BAD_TARGET: '目标账号无效。',
    EMPTY_TITLE: '公告标题不能为空。'
  };

  function adminError(error) {
    const raw = String((error && error.message) || error || '');
    const keys = Object.keys(ADMIN_MSG);
    for (let i = 0; i < keys.length; i++) {
      if (raw.indexOf(keys[i]) >= 0) return ADMIN_MSG[keys[i]];
    }
    return dbError(error);
  }

  async function adminRpc(fn, args) {
    guard();
    const { data, error } = await client.database.rpc(fn, args || {});
    if (error) throw new Error(adminError(error));
    return data;
  }

  const CloudAdmin = {
    ready() { return !!client; },

    /** 只读自己那一行：行级安全保证查不到别人 */
    async isAdmin() {
      if (!client) return false;
      const { data, error } = await client.database.from('admins').select('user_id').limit(1);
      if (error) return false;
      return !!(data && data.length);
    },

    claim(code) { return adminRpc('admin_claim', { p_code: String(code || '') }); },
    overview() { return adminRpc('admin_overview', {}); },
    users(q, limit, offset) {
      return adminRpc('admin_users', { p_q: q || '', p_limit: limit || 50, p_offset: offset || 0 });
    },
    content(kind, q, limit, offset) {
      return adminRpc('admin_content', {
        p_kind: kind, p_q: q || '', p_limit: limit || 50, p_offset: offset || 0
      });
    },
    deleteContent(kind, id) {
      return adminRpc('admin_delete_content', { p_kind: kind, p_id: Number(id) });
    },
    deleteUser(uid) { return adminRpc('admin_delete_user', { p_uid: String(uid) }); },
    broadcast(title, body) {
      return adminRpc('admin_broadcast', { p_title: title || '', p_body: body || '' });
    },
    notices() { return adminRpc('admin_notices', {}); },
    toggleHot(id) { return adminRpc('admin_toggle_hot', { p_id: Number(id) }); }
  };

  global.CloudAuth = CloudAuth;
  global.CloudData = CloudData;
  global.CloudAI = CloudAI;
  global.CloudAdmin = CloudAdmin;
  global.CLOUD_CONFIG = CONFIG;
})(window);
