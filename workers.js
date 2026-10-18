/**
 * BTKEY 激活码管理后台（Cloudflare Worker 单文件）
 *
 * ── 存储 ────────────────────────────────────────────────
 *   KV: bt_KV
 *     bt_list        每行一条序列号，字段用 | 分隔
 *                    序列号|设备ID|激活时间|状态|备注|分类
 *                    老数据（1~2 段）自动兼容：序列号 或 序列号|备注
 *                    未激活的号若既无备注也无分类，仍按「序列号」一行存，便于人眼查看
 *     bt_categories  分类名 JSON 数组，如 ["默认","2024批次"]
 *                    未分类不用存，用空字符串表示（界面显示为「未分类」）
 *
 * ── 路由总览 ─────────────────────────────────────────────
 *   GET  /api/serials?api=serials  安全数据接口（HMAC 签名 / Bearer / 管理员登录态）
 *   GET  /api/categories           分类列表 + 每个分类的号量统计
 *   GET  /api/ping                 连通性自检
 *   GET  /?device_id=&serial=      客户端激活验证（原有逻辑，返回 on / off / off-1）
 *   GET  /?logout                  退出登录
 *   GET  /?del_sn=&cat=            删除单条序列号（需登录）
 *   GET  /?del_cat=&mode=keep|wipe 删除分类（keep=号归未分类，wipe=连号一起删，需登录）
 *   POST 表单：登录 / 新建分类 / 单个添加 / 批量添加 / 保存备注 / 改分类
 *
 * ── 环境变量 ─────────────────────────────────────────────
 *   bt_KV             KV 绑定（必须）
 *   ADMIN_USER        ！后台账号
 *   ADMIN_PASS        后台密码
 *   ADMIN_TOKEN       可选，登录 Cookie 的令牌值；不配则用兼容旧值（建议配置）
 *   API_SECRET        可选，数据接口 HMAC 签名密钥；不配则该接口返回 503（不裸奔）
 *   API_TOKEN         可选，给「自己的后端」用的 Bearer 令牌（推荐路线，见 API 说明面板）
 *   API_IP_ALLOW      可选，逗号分隔的 IP 白名单，支持 "1.2.3." 前缀写法
 *   API_MAX_PER_MIN   可选，每分钟最多调用次数，默认 60
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const KV = env.bt_KV;
    const ADMIN_USER = env.ADMIN_USER;
    const ADMIN_PASS = env.ADMIN_PASS;
    const LOGIN_TOKEN = env.ADMIN_TOKEN || "admin_login_ok_2026";
    const KV_DATA_KEY = "bt_list";
    const KV_CAT_KEY = "bt_categories";
    const YEAR_SEC = 31536000;
    const UNCAT = "__uncat__";          // 未分类的 URL 哨兵值（分类名禁止使用）
    const ALLCAT = "__all__";           // 「全部」筛选的哨兵值（分类名禁止使用）
    const CAT_MAX_LEN = 24;
    const API_TS_WINDOW = 300;          // 签名有效期（秒）
    const API_MAX_PER_MIN = Number(env.API_MAX_PER_MIN || 60);

    let msg = url.searchParams.get("m") || "";

    // ==================== 工具函数 ====================
    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
      ));
    }
    function enc(s) { return encodeURIComponent(String(s ?? "")); }

    /** 北京时间字符串（Worker 运行时是 UTC，这里手动 +8） */
    function beijingNow() {
      const t = new Date(Date.now() + 8 * 3600 * 1000);
      const p = n => String(n).padStart(2, "0");
      return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} `
        + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
    }
    function nowSec() { return Math.floor(Date.now() / 1000); }

    // 获取全部激活码数据（原始行）
    async function getAllData() {
      const raw = await KV.get(KV_DATA_KEY);
      if (!raw) return [];
      return raw.split("\n").filter(l => l.trim() !== "");
    }
    // 保存全部数据到KV
    async function saveData(list) {
      await KV.put(KV_DATA_KEY, list.join("\n"));
    }

    /**
     * 一行 → 记录对象。兼容三种历史格式：
     *   序列号
     *   序列号|备注
     *   序列号|设备ID|激活时间|状态|备注|分类（后两段可为空）
     */
    function parseRecord(line) {
      const arr = String(line).split("|");
      if (arr.length >= 3) {
        return {
          serial: (arr[0] || "").trim(),
          device: (arr[1] || "").trim(),
          time: (arr[2] || "").trim(),
          status: (arr[3] || "").trim(),
          note: (arr[4] || "").trim(),
          category: (arr[5] || "").trim()
        };
      }
      return {
        serial: (arr[0] || "").trim(),
        device: "", time: "", status: "",
        note: (arr[1] || "").trim(),
        category: ""
      };
    }

    /**
     * 记录对象 → 一行。保持紧凑，避免每次写回都往老数据上堆空字段：
     *   未激活且无分类 → 序列号 或 序列号|备注
     *   有设备/时间/状态/分类 → 序列号|设备ID|激活时间|状态|备注[|分类]
     */
    function serializeRecord(r) {
      const serial = r.serial;
      const activated = !!(r.device || r.time || r.status);
      if (!activated && !r.category) return r.note ? `${serial}|${r.note}` : serial;
      const parts = [serial, r.device, r.time, r.status, r.note];
      if (r.category) parts.push(r.category);
      return parts.join("|");
    }

    /* 序列号四态（status 字段）：
     *   ""/"未激活"  可发放（available）
     *   "已领取"     已被小程序占号发出去，但客户端还没激活（issued）
     *   "已激活"     客户端已用 device_id 激活（activated）
     *   "已作废"     人工作废，不再可发放也不可激活（void）
     */
    function isVoid(r) { return r.status === "已作废"; }
    function isClaimed(r) { return r.status === "已领取"; }
    /** 是否已激活：以状态为准，并兼容老数据「有设备+时间即已激活」 */
    function isActivated(r) {
      if (isVoid(r) || isClaimed(r)) return false;
      if (r.status === "已激活") return true;
      return !!(r.device && r.time);
    }
    /** 可发放：没被占、没激活、没作废、且没有设备 */
    function isAvailable(r) {
      return !isVoid(r) && !isClaimed(r) && !isActivated(r) && !r.device;
    }
    function statusText(r) {
      if (isVoid(r)) return "已作废";
      if (isClaimed(r)) return "已领取";
      return isActivated(r) ? "已激活" : "未激活";
    }
    /** 给接口用的状态码：available / issued / activated / void */
    function statusCode(r) {
      if (isVoid(r)) return "void";
      if (isClaimed(r)) return "issued";
      return isActivated(r) ? "activated" : "available";
    }

    async function getRecords() {
      return (await getAllData()).map(parseRecord).filter(r => r.serial);
    }
    async function saveRecords(records) {
      await saveData(records.map(serializeRecord));
    }

    async function getCategories() {
      const raw = await KV.get(KV_CAT_KEY);
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x.trim()) : [];
      } catch { return []; }
    }
    async function saveCategories(list) {
      await KV.put(KV_CAT_KEY, JSON.stringify(list));
    }
    /** 分类名清洗：去空格、去掉 | 和换行、限长，返回 "" 表示非法 */
    function sanitizeCat(name) {
      const s = String(name ?? "").replace(/[|\r\n]/g, " ").trim().slice(0, CAT_MAX_LEN);
      if (!s || s === UNCAT || s === ALLCAT || s === "未分类") return "";
      return s;
    }
    /** 分类清单 = 显式登记的分类 ∪ 数据里出现过的分类（防止两者不同步） */
    function allCategoryNames(cats, records) {
      const set = new Set(cats);
      for (const r of records) if (r.category) set.add(r.category);
      return [...set].sort((a, b) => a.localeCompare(b, "zh"));
    }
    /** 每个分类的号量统计，key 为分类名（未分类为 ""） */
    function catStats(records) {
      const map = new Map();
      for (const r of records) {
        const k = r.category || "";
        const cur = map.get(k) || { total: 0, activated: 0, claimed: 0, available: 0 };
        cur.total++;
        if (isActivated(r)) cur.activated++;
        if (isClaimed(r)) cur.claimed++;
        if (isAvailable(r)) cur.available++;
        map.set(k, cur);
      }
      return map;
    }

    // 获取登录Session
    function getSessionCookie() {
      const cookies = request.headers.get("Cookie") || "";
      const cookieMap = {};
      cookies.split("; ").forEach(item => {
        const [k, v] = item.split("=");
        cookieMap[k] = v;
      });
      return cookieMap;
    }
    // 设置登录Cookie
    function setLoginCookie() {
      return `admin_token=${LOGIN_TOKEN}; Max-Age=${YEAR_SEC}; Path=/; HttpOnly; SameSite=Lax`;
    }
    // 清空登录Cookie
    function clearLoginCookie() {
      return `admin_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
    }
    // 读取当前登录状态
    function isLogin() {
      const ck = getSessionCookie();
      return ck.admin_token === LOGIN_TOKEN;
    }
    // 跳转响应
    function redirect(location, cookie = "") {
      const headers = new Headers({ Location: location });
      if (cookie) headers.append("Set-Cookie", cookie);
      return new Response("", { status: 302, headers });
    }
    /** 操作完成后回到列表（保留分类筛选 + 提示语），避免刷新重复提交 */
    function backUrl(cat, m) {
      const q = new URLSearchParams();
      if (cat !== null && cat !== undefined) q.set("cat", cat);
      if (m) q.set("m", m);
      const s = q.toString();
      return "/" + (s ? "?" + s : "");
    }
    /** 表单/链接里传递当前筛选用的值：全部=__all__，未分类=__uncat__，其它=分类名 */
    function backCatValue(catFilter) {
      return catFilter === null ? ALLCAT : (catFilter === "" ? UNCAT : catFilter);
    }
    // 纯文本返回（API接口）
    function textRes(content) {
      return new Response(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    // JSON 返回
    function jsonRes(obj, status = 200) {
      return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }
    // HTML页面返回
    function htmlRes(html, setCookie = null) {
      const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
      if (setCookie) headers.append("Set-Cookie", setCookie);
      return new Response(html, { headers });
    }

    // ==================== 备份 / 恢复用到的工具 ====================
    /** 以附件形式下载（导出备份用） */
    function downloadRes(content, contentType, filename) {
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store"
        }
      });
    }
    /** 导出配置时把密钥打码；reveal=true 时才输出真实值 */
    function maskSecret(v, reveal) {
      const s = String(v == null ? "" : v);
      if (!s) return "";
      if (reveal) return s;
      return "***已隐藏***";
    }
    /** 列出 KV 里的全部 key（Cloudflare 用 list()，本地 FileKV 用 keys()，两者都兼容） */
    async function listAllKeys(prefix = "") {
      const out = [];
      if (typeof KV.list === "function") {
        let cursor;
        for (let guard = 0; guard < 50; guard++) {
          const page = await KV.list({ prefix, cursor });
          for (const k of page.keys || []) out.push(k.name);
          if (page.list_complete || !page.cursor) break;
          cursor = page.cursor;
        }
        return out;
      }
      if (typeof KV.keys === "function") {
        return KV.keys().filter(k => String(k).startsWith(prefix));
      }
      return out;
    }

    // ==================== 安全数据接口用到的加密/限流工具 ====================
    function safeEqual(a, b) {
      if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
      let r = 0;
      for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return r === 0;
    }
    async function hmacHex(secret, message) {
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
      return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    }
    function clientIp() {
      return (request.headers.get("cf-connecting-ip")
        || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim());
    }
    function ipAllowed() {
      const allow = String(env.API_IP_ALLOW || "").split(",").map(s => s.trim()).filter(Boolean);
      if (!allow.length) return true;
      const ip = clientIp();
      return allow.some(a => ip === a || (a.endsWith(".") && ip.startsWith(a)));
    }
    /** KV 计数限流（分钟粒度，尽力而为，KV 最终一致性下允许少量误差） */
    async function rateLimited(bucket) {
      const key = `rl:${bucket}:${Math.floor(Date.now() / 60000)}`;
      const cur = Number((await KV.get(key)) || 0);
      if (cur >= API_MAX_PER_MIN) return true;
      await KV.put(key, String(cur + 1), { expirationTtl: 120 });
      return false;
    }

    // ==================== 发号相关（只给小程序后端调用，Bearer 令牌） ====================
    const PENDING_TTL = 300;   // 占位后多久没确认就回收（秒）

    async function readJsonBody() {
      try { return await request.json(); } catch { return null; }
    }
    async function claimInfo(serial) {
      try { return JSON.parse((await KV.get("claiminfo:" + serial)) || "null"); } catch { return null; }
    }

    /** 回收「已领取」但迟迟没 confirm 的占位，避免号被永久占死 */
    async function reclaimStaleClaims(records) {
      let reclaimed = 0;
      for (const r of records) {
        if (!isClaimed(r)) continue;
        const meta = await claimInfo(r.serial);
        if (meta && meta.confirmed) continue;
        const at = meta ? Number(meta.at || 0) : 0;
        if (!at || nowSec() - at > PENDING_TTL) {
          r.status = "";
          reclaimed++;
          await KV.delete("claiminfo:" + r.serial);
          if (meta && meta.request_id) await KV.delete("claimbyreq:" + meta.request_id);
        }
      }
      return reclaimed;
    }

    /** POST /api/claim  body { category, request_id, exclude? } → 占一个号（幂等） */
    async function apiClaim() {
      const body = await readJsonBody();
      if (!body) return jsonRes({ ok: false, error: "bad_json" }, 400);
      const category = String(body.category || "").trim().slice(0, 64);
      const requestId = String(body.request_id || "").trim();
      // exclude：调用方在小程序后端里发现这个号已被别的用户占过，要求跳过（最多 20 个）
      const exclude = Array.isArray(body.exclude)
        ? body.exclude.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20)
        : [];
      if (!category) return jsonRes({ ok: false, error: "bad_category" }, 400);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return jsonRes({ ok: false, error: "bad_request_id" }, 400);

      // 幂等：同一个 request_id 重复请求，返回上次那个号，不再占新号
      const cachedRaw = await KV.get("claimbyreq:" + requestId);
      if (cachedRaw) {
        let meta = null;
        try { meta = JSON.parse(cachedRaw); } catch {}
        if (meta && meta.serial) {
          return jsonRes({ ok: true, repeated: true, serial: meta.serial, category: meta.category || category });
        }
      }

      // ── SQL 数据层（Ubuntu 版 / 自建服务器）：一条 UPDATE…RETURNING 原子占号 ──
      // 并发下绝不会把同一个号发给两个人；Cloudflare KV 版本没有这个对象，自动走下面的老逻辑
      const sqlStore = (env.bt_DB && typeof env.bt_DB.claimAtomic === "function")
        ? env.bt_DB
        : (KV && typeof KV.sql === "object" && KV.sql && typeof KV.sql.claimAtomic === "function" ? KV.sql : null);
      if (sqlStore) {
        try {
          const serial = sqlStore.claimAtomic({
            category, exclude, requestId, at: nowSec(), pendingTtl: PENDING_TTL
          });
          if (!serial) return jsonRes({ ok: false, error: "out_of_stock", category });
          return jsonRes({ ok: true, serial, category, claimed_at: beijingNow() });
        } catch (e) {
          return jsonRes({ ok: false, error: "claim_failed", detail: String(e && e.message || e) }, 500);
        }
      }

      const records = await getRecords();
      if (await reclaimStaleClaims(records)) await saveRecords(records);

      const pick = records.find((r) => isAvailable(r)
        && (r.category || "") === category
        && !exclude.includes(r.serial));
      if (!pick) return jsonRes({ ok: false, error: "out_of_stock", category });

      const at = nowSec();
      pick.status = "已领取";
      await saveRecords(records);
      await KV.put("claiminfo:" + pick.serial,
        JSON.stringify({ request_id: requestId, at, confirmed: false }), { expirationTtl: 86400 });
      await KV.put("claimbyreq:" + requestId,
        JSON.stringify({ serial: pick.serial, category, at }), { expirationTtl: 604800 });
      return jsonRes({ ok: true, serial: pick.serial, category, claimed_at: beijingNow() });
    }

    /** POST /api/confirm  body { serial, request_id } —— 小程序后端落库成功后确认发货 */
    async function apiConfirm() {
      const body = await readJsonBody();
      if (!body) return jsonRes({ ok: false, error: "bad_json" }, 400);
      const serial = String(body.serial || "").trim();
      const requestId = String(body.request_id || "").trim();
      if (!serial) return jsonRes({ ok: false, error: "bad_serial" }, 400);

      const records = await getRecords();
      const rec = records.find((r) => r.serial === serial);
      if (!rec) return jsonRes({ ok: false, error: "not_found" }, 404);
      if (isVoid(rec)) return jsonRes({ ok: false, error: "is_void" }, 409);
      if (isAvailable(rec)) return jsonRes({ ok: false, error: "not_claimed" }, 409);

      const meta = await claimInfo(serial);
      if (meta && meta.request_id && requestId && meta.request_id !== requestId) {
        return jsonRes({ ok: false, error: "request_mismatch" }, 409);
      }

      rec.status = "已领取";
      await saveRecords(records);
      await KV.put("claiminfo:" + serial, JSON.stringify({
        request_id: requestId || (meta && meta.request_id) || "",
        at: (meta && meta.at) || nowSec(),
        confirmed: true
      }), { expirationTtl: 2592000 });
      return jsonRes({ ok: true, serial });
    }

    /** POST /api/release  body { serial, request_id } —— 落库失败时把号还回池子 */
    async function apiRelease() {
      const body = await readJsonBody();
      if (!body) return jsonRes({ ok: false, error: "bad_json" }, 400);
      const serial = String(body.serial || "").trim();
      const requestId = String(body.request_id || "").trim();
      if (!serial) return jsonRes({ ok: false, error: "bad_serial" }, 400);

      const records = await getRecords();
      const rec = records.find((r) => r.serial === serial);
      if (!rec) return jsonRes({ ok: false, error: "not_found" }, 404);
      if (isActivated(rec)) return jsonRes({ ok: false, error: "already_activated" }, 409);

      rec.status = "";
      await saveRecords(records);
      await KV.delete("claiminfo:" + serial);
      if (requestId) await KV.delete("claimbyreq:" + requestId);
      return jsonRes({ ok: true, serial });
    }

    /** POST /api/void  body { serial, request_id? } —— 人工作废一个号（不可再发放、不可激活） */
    async function apiVoid() {
      const body = await readJsonBody();
      if (!body) return jsonRes({ ok: false, error: "bad_json" }, 400);
      const serial = String(body.serial || "").trim();
      const requestId = String(body.request_id || "").trim();
      if (!serial) return jsonRes({ ok: false, error: "bad_serial" }, 400);

      const records = await getRecords();
      const rec = records.find((r) => r.serial === serial);
      if (!rec) return jsonRes({ ok: false, error: "not_found" }, 404);

      const meta = await claimInfo(serial);
      rec.status = "已作废";
      await saveRecords(records);
      await KV.delete("claiminfo:" + serial);
      if (requestId) await KV.delete("claimbyreq:" + requestId);
      else if (meta && meta.request_id) await KV.delete("claimbyreq:" + meta.request_id);
      return jsonRes({ ok: true, serial, status: "void" });
    }

    /** GET /api/status?serials=a,b,c —— 小程序后端查激活状态用 */
    async function apiStatus() {
      const serials = (url.searchParams.get("serials") || "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
      if (!serials.length) return jsonRes({ ok: false, error: "missing_serials" }, 400);

      const records = await getRecords();
      const map = new Map(records.map((r) => [r.serial, r]));
      return jsonRes({
        ok: true,
        server_time: beijingNow(),
        list: serials.map((s) => {
          const r = map.get(s);
          if (!r) {
            return { serial: s, found: false, status: "missing", activated: false, activated_at: "", device_id: "", category: "" };
          }
          return {
            serial: s,
            found: true,
            status: statusCode(r),
            activated: isActivated(r),
            activated_at: r.time || "",
            device_id: r.device || "",
            category: r.category || ""
          };
        })
      });
    }

    // ==================== 路由0：安全数据接口 ====================
    // 支持两种写法：/?api=serials 或 /api/serials
    const apiName = url.searchParams.get("api")
      || (url.pathname.startsWith("/api/") ? url.pathname.slice(5).replace(/\/+$/, "") : "");

    if (apiName) {
      if (!ipAllowed()) return jsonRes({ ok: false, error: "ip_forbidden" }, 403);
      if (await rateLimited(clientIp() || "anon")) {
        return jsonRes({ ok: false, error: "rate_limited", limit_per_min: API_MAX_PER_MIN }, 429);
      }

      // 参数（分类：缺省/空=全部，__uncat__=未分类，其它=分类名）
      // 待签名串用的是「客户端原样传来的值」，所以 only 不传时按空串参与签名
      const rawCat = url.searchParams.get("category");
      const catKey = rawCat === null ? null : rawCat.trim();
      const onlyRaw = (url.searchParams.get("only") || "").trim();
      const only = onlyRaw || "all";   // all | available | activated

      // ── 写接口（claim / confirm / release）只允许服务器用 Bearer 令牌调用 ──
      //    小程序绝不能拿到这个令牌，所以这里不接受管理员 Cookie，也不接受 HMAC
      const WRITE_APIS = ["claim", "confirm", "release", "void"];
      const isWriteApi = WRITE_APIS.includes(apiName);
      const bearerOk = !!env.API_TOKEN
        && safeEqual(request.headers.get("Authorization") || "", `Bearer ${env.API_TOKEN}`);

      if (isWriteApi && !bearerOk) {
        return jsonRes({ ok: false, error: "unauthorized" }, 401);
      }

      // ── 读接口鉴权：① 管理员登录态（后台面板自测）② Bearer 令牌 ③ HMAC 签名 ──
      let authed = isWriteApi;      // 写接口上面已经验过 Bearer
      let authMode = isWriteApi ? "bearer" : "";
      if (!authed && isLogin()) {
        authed = true; authMode = "admin_session";
      } else if (!authed && bearerOk) {
        authed = true; authMode = "bearer";
      }

      const ts = Number(url.searchParams.get("ts") || 0);
      const nonce = (url.searchParams.get("nonce") || "").trim();
      const sign = (url.searchParams.get("sign") || "").trim().toLowerCase();

      if (!authed) {
        if (!env.API_SECRET) return jsonRes({ ok: false, error: "api_not_configured" }, 503);
        if (!ts || !nonce || !sign) return jsonRes({ ok: false, error: "missing_sign" }, 401);
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return jsonRes({ ok: false, error: "bad_nonce" }, 401);
        if (Math.abs(nowSec() - ts) > API_TS_WINDOW) {
          return jsonRes({ ok: false, error: "expired", window_sec: API_TS_WINDOW }, 401);
        }
        // 待签名字符串：api\n分类\nonly\nts\nnonce
        // 各参数按客户端实际发送的原样值参与（缺省即空串），避免「少传参数导致签名对不上」
        const canonical = [apiName, rawCat === null ? "" : rawCat, onlyRaw, ts, nonce].join("\n");
        const expect = await hmacHex(env.API_SECRET, canonical);
        if (!safeEqual(expect, sign)) return jsonRes({ ok: false, error: "bad_sign" }, 401);
        // 防重放（KV 写入有最终一致性，属尽力而为的第二道防线）
        const nk = "nonce:" + nonce;
        if (await KV.get(nk)) return jsonRes({ ok: false, error: "replayed" }, 401);
        await KV.put(nk, "1", { expirationTtl: 600 });
        authMode = "hmac";
      }

      // ── 发号相关接口（只给小程序后端调用）──
      if (apiName === "claim") return apiClaim();
      if (apiName === "confirm") return apiConfirm();
      if (apiName === "release") return apiRelease();
      if (apiName === "void") return apiVoid();
      if (apiName === "status") return apiStatus();

      const records = await getRecords();
      const genAt = beijingNow();

      // ── 连通性自检 ──
      if (apiName === "ping") {
        return jsonRes({ ok: true, api: "ping", auth: authMode, server_time: genAt, ts: nowSec() });
      }

      // ── 分类列表（含号量统计，小程序选分类用） ──
      if (apiName === "categories") {
        const stats = catStats(records);
        const names = allCategoryNames(await getCategories(), records);
        const list = names.map(name => {
          const s = stats.get(name) || { total: 0, activated: 0, claimed: 0, available: 0 };
          return { name, total: s.total, activated: s.activated, claimed: s.claimed, available: s.available };
        });
        const un = stats.get("") || { total: 0, activated: 0, claimed: 0, available: 0 };
        return jsonRes({
          ok: true,
          server_time: genAt,
          count: list.length,
          categories: list,
          uncategorized: {
            name: "", display: "未分类",
            total: un.total, activated: un.activated, claimed: un.claimed, available: un.available
          }
        });
      }

      // ── 某个分类下的全部序列号信息 ──
      if (apiName === "serials") {
        const all = catKey === null || catKey === "" || catKey === "*";
        const wantUncat = catKey === UNCAT;
        const wanted = all ? null : (wantUncat ? "" : catKey);

        const scoped = all ? records : records.filter(r => (r.category || "") === wanted);
        const filtered = scoped.filter(r => {
          if (only === "available") return isAvailable(r);   // 不含「已领取」和「已作废」
          if (only === "activated") return isActivated(r);
          return true;
        });

        return jsonRes({
          ok: true,
          scope: all ? "all" : (wantUncat ? "uncategorized" : "category"),
          category: all ? null : (wantUncat ? "" : catKey),
          category_display: all ? "全部" : (wantUncat ? "未分类" : catKey),
          only: ["available", "activated"].includes(only) ? only : "all",
          server_time: genAt,
          count: filtered.length,
          total: scoped.length,
          activated: scoped.filter(isActivated).length,
          claimed: scoped.filter(isClaimed).length,
          available: scoped.filter(isAvailable).length,
          list: filtered.map(r => ({
            serial: r.serial,
            category: r.category,
            category_display: r.category || "未分类",
            activated: isActivated(r),
            status: statusText(r),
            status_code: statusCode(r),
            device_id: r.device,
            activated_at: r.time,
            note: r.note
          }))
        });
      }

      return jsonRes({ ok: false, error: "unknown_api", api: apiName }, 404);
    }

    // ==================== 路由1：激活验证API /?device_id=xxx&serial=xxx ====================
    if (url.searchParams.has("device_id") && url.searchParams.has("serial")) {
      const deviceId = url.searchParams.get("device_id").trim();
      const serial = url.searchParams.get("serial").trim();
      if (!deviceId || !serial) return textRes("off");

      const records = await getRecords();
      const rec = records.find(r => r.serial === serial);

      if (!rec) return textRes("off");
      // 作废的号直接判无效（不能再被激活）
      if (isVoid(rec)) return textRes("off");
      if (isActivated(rec)) {
        return rec.device === deviceId ? textRes("on") : textRes("off-1");
      }

      // 未激活（含已领取未激活），绑定设备
      rec.device = deviceId;
      rec.time = beijingNow();
      rec.status = "已激活";
      await saveRecords(records);
      return textRes("on");
    }

    // ==================== 路由2：退出登录 ?logout ====================
    if (url.searchParams.has("logout")) {
      return redirect("/", clearLoginCookie());
    }

    // 分类筛选：null=全部，""=未分类，其它=分类名
    const catParam = url.searchParams.has("cat") ? url.searchParams.get("cat") : null;
    const catFilter = (catParam === null || catParam === ALLCAT)
      ? null
      : (catParam === UNCAT ? "" : catParam);

    // ==================== POST表单处理（后台增删改逻辑） ====================
    if (request.method === "POST") {
      const formData = await request.formData();

      // 登录提交（唯一允许未登录的操作）
      if (formData.has("login")) {
        const user = formData.get("user")?.trim() ?? "";
        const pass = formData.get("pass")?.trim() ?? "";
        if (user === ADMIN_USER && pass === ADMIN_PASS) {
          return redirect("/", setLoginCookie());
        }
        msg = "账号或密码错误";
      } else if (!isLogin()) {
        // 写操作必须先登录（老版本这里没有校验，等于任何人都能增删数据）
        msg = "登录已失效，请重新登录";
      } else {
        const cats = await getCategories();
        const records = await getRecords();
        // 保留当前筛选：表单里带 hidden 的 back_cat（__all__ 代表「全部」）
        const backRaw = formData.has("back_cat") ? formData.get("back_cat") : catParam;
        const backCat = backRaw === ALLCAT ? null : backRaw;

        /** 表单里选中的分类：优先「新建分类」输入框，其次下拉选择 */
        async function pickCategory() {
          const fresh = sanitizeCat(formData.get("cat_new"));
          if (fresh) {
            if (!cats.includes(fresh)) {
              cats.push(fresh);
              await saveCategories(cats);
            }
            return fresh;
          }
          const sel = String(formData.get("cat") ?? "").trim();
          if (!sel || sel === UNCAT || sel === ALLCAT || sel === "未分类") return "";
          if (!cats.includes(sel)) {
            cats.push(sel);
            await saveCategories(cats);
          }
          return sel;
        }

        // 新建分类
        if (formData.has("add_category")) {
          const name = sanitizeCat(formData.get("new_cat"));
          if (!name) {
            msg = `分类名无效：不能为空、不能含 | 和换行、不能叫「未分类」，最长 ${CAT_MAX_LEN} 字`;
          } else if (cats.includes(name)) {
            msg = `分类「${name}」已存在`;
          } else {
            cats.push(name);
            await saveCategories(cats);
            msg = `分类「${name}」已创建`;
          }
          return redirect(backUrl(backCat, msg));
        }

        // 单个添加激活码（可选分类，也可以直接新建分类）
        if (formData.has("add_single")) {
          const sn = (formData.get("serial")?.trim() ?? "").replace(/[|\r\n]/g, "");
          const cat = await pickCategory();
          if (!sn) {
            msg = "序列号不能为空";
          } else if (records.some(r => r.serial === sn)) {
            msg = "已存在";
          } else {
            records.unshift({ serial: sn, device: "", time: "", status: "", note: "", category: cat });
            await saveRecords(records);
            msg = `添加成功${cat ? `（分类：${cat}）` : "（未分类）"}`;
          }
          return redirect(backUrl(backCat, msg));
        }

        // 批量添加（整批归入所选分类）
        if (formData.has("add_batch")) {
          const batchText = formData.get("batch") ?? "";
          const cat = await pickCategory();
          const exist = new Set(records.map(r => r.serial));
          const items = batchText.split("\n")
            .map(i => i.replace(/[|\r\n]/g, "").trim())
            .filter(i => i && !exist.has(i));
          // 同一次提交里的重复也要去掉
          const uniq = [...new Set(items)];
          if (uniq.length > 0) {
            const addList = uniq.map(sn => ({
              serial: sn, device: "", time: "", status: "", note: "", category: cat
            }));
            await saveRecords([...addList, ...records]);
            msg = `批量添加成功：${uniq.length} 条${cat ? `（分类：${cat}）` : "（未分类）"}`;
          } else {
            msg = "无新数据";
          }
          return redirect(backUrl(backCat, msg));
        }

        // 保存备注
        if (formData.has("save_note")) {
          const sn = formData.get("sn")?.trim() ?? "";
          const note = (formData.get("note")?.trim() ?? "").replaceAll("|", " ");
          const rec = records.find(r => r.serial === sn);
          if (rec) {
            rec.note = note;
            await saveRecords(records);
            msg = "备注已保存";
          } else {
            msg = "序列号不存在";
          }
          return redirect(backUrl(backCat, msg));
        }

        // 修改单条序列号的分类
        if (formData.has("move_sn")) {
          const sn = formData.get("sn")?.trim() ?? "";
          const cat = await pickCategory();
          const rec = records.find(r => r.serial === sn);
          if (rec) {
            rec.category = cat;
            await saveRecords(records);
            msg = `「${sn}」已归到${cat ? `分类「${cat}」` : "未分类"}`;
          } else {
            msg = "序列号不存在";
          }
          return redirect(backUrl(backCat, msg));
        }

        // ==================== 导入备份（备份 / 恢复） ====================
        // 支持三种来源：
        //   ① 本页导出的 btkey-backup-*.json（含 config + kv）
        //   ② btkey-kv-*.json（{ key: { v: "..." } }，也可直接当 data/btkey-kv.json 用）
        //   ③ 纯文本，一行一个序列号
        if (formData.has("backup_import")) {
          const mode = String(formData.get("import_mode") || "merge") === "replace" ? "replace" : "merge";
          let raw = "";

          const fileVal = formData.get("backup_file");
          if (fileVal && typeof fileVal === "object" && typeof fileVal.text === "function") {
            const text = await fileVal.text().catch(() => "");
            if (text && text.trim()) raw = text;
          }
          if (!raw) raw = String(formData.get("backup_text") ?? "");
          raw = raw.replace(/^\uFEFF/, "").trim();

          if (!raw) {
            msg = "没有拿到内容：请选择备份文件，或把备份内容粘贴到文本框";
            return redirect(backUrl(backCat, msg));
          }

          // 解析成 { key: 字符串值 }
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }

          const kvMap = {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const src = (parsed.kv && typeof parsed.kv === "object") ? parsed.kv : parsed;
            for (const [k, v] of Object.entries(src)) {
              if (typeof v === "string") kvMap[k] = v;
              else if (v && typeof v === "object" && typeof v.v === "string") kvMap[k] = v.v;
            }
            if (Array.isArray(parsed.categories) && !kvMap[KV_CAT_KEY]) {
              kvMap[KV_CAT_KEY] = JSON.stringify(parsed.categories);
            }
          } else {
            // 非 JSON：当纯序列号文本
            kvMap[KV_DATA_KEY] = raw;
          }

          const incomingRaw = String(kvMap[KV_DATA_KEY] ?? "").trim();
          const incoming = incomingRaw
            ? incomingRaw.split("\n").map(s => s.trim()).filter(Boolean).map(parseRecord).filter(r => r.serial)
            : [];

          if (!incoming.length && !kvMap[KV_CAT_KEY]) {
            msg = "备份里没有可用的数据（既没有序列号，也没有分类）";
            return redirect(backUrl(backCat, msg));
          }

          // ① 序列号：合并 / 覆盖
          let added = 0, filled = 0, skipped = 0;
          if (mode === "replace") {
            const seen = new Set();
            const next = [];
            for (const rec of incoming) {
              if (seen.has(rec.serial)) { skipped++; continue; }
              seen.add(rec.serial);
              next.push(rec);
            }
            await saveRecords(next);
            added = next.length;
          } else {
            const bySn = new Map(records.map(r => [r.serial, r]));
            for (const rec of incoming) {
              const cur = bySn.get(rec.serial);
              if (!cur) {
                records.push(rec);
                bySn.set(rec.serial, rec);
                added++;
                continue;
              }
              // 合并时不覆盖已有信息，只把本地空着的字段补齐
              let touched = false;
              for (const f of ["device", "time", "status", "note", "category"]) {
                if (!cur[f] && rec[f]) { cur[f] = rec[f]; touched = true; }
              }
              if (touched) filled++; else skipped++;
            }
            if (added || filled) await saveRecords(records);
          }

          // ② 分类
          let catMerged = 0;
          const rawCats = String(kvMap[KV_CAT_KEY] ?? "").trim();
          if (rawCats) {
            let catsIn = [];
            try { catsIn = JSON.parse(rawCats); } catch { catsIn = rawCats.split("\n"); }
            if (!Array.isArray(catsIn)) catsIn = String(catsIn).split("\n");
            const clean = [...new Set(catsIn.map(sanitizeCat).filter(Boolean))];
            const cur = await getCategories();
            const merged = mode === "replace" ? clean : [...new Set([...cur, ...clean])];
            catMerged = merged.length - cur.length;
            await saveCategories(merged);
          }

          // ③ 占号记录（保证导入后同一 request_id 不会重复发号）
          let claimRestored = 0;
          for (const [k, v] of Object.entries(kvMap)) {
            if (k === KV_DATA_KEY || k === KV_CAT_KEY) continue;
            if (k.startsWith("claiminfo:") || k.startsWith("claimbyreq:")) {
              await KV.put(k, v, { expirationTtl: k.startsWith("claiminfo:") ? 86400 : 604800 });
              claimRestored++;
            }
          }

          msg = mode === "replace"
            ? `已覆盖导入：序列号 ${added} 条、分类 ${catMerged >= 0 ? catMerged : 0} 个新增、占号记录 ${claimRestored} 条`
            : `已合并导入：新增 ${added} 条、补全 ${filled} 条、跳过 ${skipped} 条；分类新增 ${Math.max(0, catMerged)} 个、占号记录 ${claimRestored} 条`;
          return redirect(backUrl(backCat, msg));
        }

        msg = "未知操作";
        return redirect(backUrl(backCat, msg));
      }
    }

    // ==================== GET删除激活码 ?del_sn=xxx（需登录） ====================
    if (url.searchParams.has("del_sn")) {
      if (!isLogin()) return redirect(backUrl(catParam, "登录已失效，请重新登录"));
      const delSn = url.searchParams.get("del_sn").trim();
      const records = await getRecords();
      const left = records.filter(r => r.serial !== delSn);
      await saveRecords(left);
      return redirect(backUrl(catParam, left.length < records.length
        ? `已删除序列号「${delSn}」`
        : `序列号「${delSn}」不存在`));
    }

    // ==================== GET删除分类 ?del_cat=名称&mode=keep|wipe（需登录） ====================
    if (url.searchParams.has("del_cat")) {
      if (!isLogin()) return redirect(backUrl(catParam, "登录已失效，请重新登录"));
      const name = String(url.searchParams.get("del_cat") || "");
      const wipe = url.searchParams.get("mode") === "wipe";
      if (!name) return redirect(backUrl(catParam, "分类名不能为空"));

      const cats = (await getCategories()).filter(c => c !== name);
      const records = await getRecords();
      let removed = 0;
      let moved = 0;
      const kept = [];
      for (const r of records) {
        if ((r.category || "") === name) {
          if (wipe) { removed++; continue; }
          r.category = "";
          moved++;
        }
        kept.push(r);
      }
      await saveCategories(cats);
      if (wipe) await saveRecords(kept);
      else if (moved) await saveRecords(kept);

      msg = wipe
        ? `已删除分类「${name}」及其 ${removed} 个序列号`
        : `已删除分类「${name}」，${moved} 个序列号已归入未分类`;
      // 删的就是当前筛选的分类时，回到全部列表
      if (catFilter === name) return redirect(backUrl(null, msg));
      return redirect(backUrl(catParam, msg));
    }

    // ==================== GET 导出备份 ?export=json|kv|txt（需登录） ====================
    //   json：完整备份（数据 + 配置），用于「备份 / 恢复」页面的导入
    //   kv  ：直接就是本地版 data/btkey-kv.json 的内容，Ubuntu 部署时可以直接用
    //   txt ：只导序列号纯文本，一行一个（贴到「批量添加」里也能用）
    if (url.searchParams.has("export")) {
      if (!isLogin()) return redirect(backUrl(catParam, "登录已失效，请重新登录"));
      const kind = String(url.searchParams.get("export") || "json").toLowerCase();
      const reveal = url.searchParams.get("secrets") === "1";
      const allRecords = await getRecords();
      const cats = await getCategories();
      const stamp = beijingNow().replace(/[-: ]/g, "").slice(0, 12);   // 202610181012

      if (kind === "txt") {
        const body = allRecords.map(r => r.serial).join("\n");
        return downloadRes("\uFEFF" + body, "text/plain; charset=utf-8", `btkey-serials-${stamp}.txt`);
      }

      // 把 KV 里所有相关 key 原样导出（含占号记录，导入后幂等性也不丢）
      const kvDump = {};
      kvDump[KV_DATA_KEY] = String((await KV.get(KV_DATA_KEY)) ?? "");
      kvDump[KV_CAT_KEY] = String((await KV.get(KV_CAT_KEY)) ?? "");
      const claimKeys = [
        ...(await listAllKeys("claiminfo:")),
        ...(await listAllKeys("claimbyreq:"))
      ];
      for (const k of claimKeys) kvDump[k] = String((await KV.get(k)) ?? "");

      if (kind === "kv") {
        // 结构就是 { key: { v: "值" } }，等价于本地 FileKV 文件
        const fileKv = {};
        for (const [k, v] of Object.entries(kvDump)) fileKv[k] = { v };
        return downloadRes(JSON.stringify(fileKv, null, 2),
          "application/json; charset=utf-8", `btkey-kv-${stamp}.json`);
      }

      const backup = {
        format: "btkey-backup",
        version: 1,
        exported_at: beijingNow(),
        counts: {
          serials: allRecords.length,
          categories: cats.length,
          claim_records: claimKeys.length
        },
        config: {
          ADMIN_USER,
          ADMIN_TOKEN: maskSecret(LOGIN_TOKEN, reveal),
          API_TOKEN: maskSecret(env.API_TOKEN, reveal),
          API_SECRET: maskSecret(env.API_SECRET, reveal),
          API_IP_ALLOW: String(env.API_IP_ALLOW || ""),
          API_MAX_PER_MIN,
          note: reveal ? "已包含真实密钥，请妥善保管" : "密钥已打码，需要时重新生成即可"
        },
        categories: cats,
        kv: kvDump
      };
      return downloadRes(JSON.stringify(backup, null, 2),
        "application/json; charset=utf-8", `btkey-backup-${stamp}.json`);
    }

    // ==================== 渲染页面HTML ====================
    const loginStatus = isLogin();

    // 登录页HTML
    const loginHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>管理员登录</title>
<style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
        background: linear-gradient(135deg, #42a5f5, #4789d4);
        font-family:"Microsoft YaHei",sans-serif;
        display:flex;
        align-items:center;
        justify-content:center;
        min-height:100vh;
        padding:15px;
    }
    .login-box{
        background:#fff;
        width:100%;
        max-width:400px;
        padding:40px 30px;
        border-radius:16px;
        box-shadow:0 8px 30px rgba(0,0,0,0.15);
        animation: fadeIn 0.4s ease;
    }
    @keyframes fadeIn {
        from{opacity:0;transform:translateY(-20px);}
        to{opacity:1;transform:translateY(0);}
    }
    .login-box h2{
        text-align:center;
        margin-bottom:30px;
        color:#222;
        font-size:24px;
        font-weight:600;
    }
    .input-item{
        margin-bottom:20px;
    }
    .input-item label{
        display:block;
        margin-bottom:8px;
        color:#555;
        font-size:14px;
    }
    input{
        width:100%;
        padding:12px 15px;
        border:1px solid #e0e0e0;
        border-radius:8px;
        font-size:15px;
        transition:0.2s;
    }
    input:focus{
        outline:none;
        border-color:#42a5f5;
        box-shadow:0 0 0 3px rgba(66,165,245,0.15);
    }
    button{
        width:100%;
        padding:13px;
        background:#42a5f5;
        color:#fff;
        border:none;
        border-radius:8px;
        font-size:16px;
        font-weight:500;
        cursor:pointer;
        transition:0.2s;
        margin-top:10px;
    }
    button:hover{
        background:#3393e0;
    }
    .error{
        color:#f44336;
        text-align:center;
        margin-top:15px;
        font-size:13px;
    }
</style>
</head>
<body>
<div class="login-box">
    <h2>管理员登录</h2>
    <form method="post">
        <div class="input-item">
            <label>管理员账号</label>
            <input name="user" placeholder="请输入账号" required>
        </div>
        <div class="input-item">
            <label>登录密码</label>
            <input name="pass" type="password" placeholder="请输入密码" required>
        </div>
        <button name="login">安全登录</button>
        <div class="error">${esc(msg)}</div>
    </form>
</div>
</body>
</html>
`;

    // 未登录直接输出登录页
    if (!loginStatus) return htmlRes(loginHtml);

    // ---------- 数据准备 ----------
    const allRecords = await getRecords();
    const categories = allCategoryNames(await getCategories(), allRecords);
    const stats = catStats(allRecords);

    // 当前筛选下的记录
    const viewRecords = catFilter === null
      ? allRecords
      : allRecords.filter(r => (r.category || "") === catFilter);
    const viewTitle = catFilter === null ? "全部" : (catFilter === "" ? "未分类" : catFilter);

    // 分类下拉选项
    const catOptions = (selected) => [
      `<option value="${UNCAT}"${selected === "" ? " selected" : ""}>未分类</option>`,
      ...categories.map(c => `<option value="${esc(c)}"${c === selected ? " selected" : ""}>${esc(c)}</option>`)
    ].join("");

    // 列表行
    let tableRows = "";
    for (const r of viewRecords) {
      const catName = r.category || "未分类";
      tableRows += `
        <tr>
            <td class="sn-cell">${esc(r.serial)}</td>
            <td>
                <form method="post" class="inline-form">
                    <input type="hidden" name="sn" value="${esc(r.serial)}">
                    <input type="hidden" name="back_cat" value="${esc(backCatValue(catFilter))}">
                    <select name="cat">${catOptions(r.category)}</select>
                    <button name="move_sn">保存</button>
                </form>
            </td>
            <td>${esc(r.device || "-")}</td>
            <td>${esc(r.time || "-")}</td>
            <td class="${isActivated(r) ? "st-on" : "st-off"}">${esc(statusText(r))}</td>
            <td>
                <form method="post" class="inline-form">
                    <input type="hidden" name="sn" value="${esc(r.serial)}">
                    <input type="hidden" name="back_cat" value="${esc(backCatValue(catFilter))}">
                    <input type="text" name="note" value="${esc(r.note)}" style="width:100px;padding:4px;">
                    <button name="save_note">保存</button>
                </form>
            </td>
            <td>
                <a href="?del_sn=${enc(r.serial)}&cat=${enc(backCatValue(catFilter))}"
                   class="del-btn" onclick="return confirm('确定删除序列号 ${esc(r.serial)} ？')">删除</a>
            </td>
        </tr>
      `;
    }
    if (viewRecords.length === 0) tableRows = `<tr><td colspan="7">暂无数据</td></tr>`;

    // 分类筛选标签
    const un = stats.get("") || { total: 0, activated: 0 };
    let filterBar = `<a href="/" class="${catFilter === null ? "active" : ""}">全部 (${allRecords.length})</a>`;
    filterBar += `<a href="/?cat=${UNCAT}" class="${catFilter === "" ? "active" : ""}">未分类 (${un.total})</a>`;
    for (const c of categories) {
      const s = stats.get(c) || { total: 0, activated: 0 };
      filterBar += `<a href="/?cat=${enc(c)}" class="${catFilter === c ? "active" : ""}">${esc(c)} (${s.total})</a>`;
    }

    // 分类管理行
    let catRows = "";
    const totalAct = allRecords.filter(isActivated).length;
    catRows += `
        <tr>
            <td>未分类</td><td>${un.total}</td><td>${un.activated}</td><td>${un.total - un.activated}</td>
            <td class="muted">默认归类，不可删除</td>
        </tr>`;
    for (const c of categories) {
      const s = stats.get(c) || { total: 0, activated: 0 };
      catRows += `
        <tr>
            <td>${esc(c)}</td>
            <td>${s.total}</td>
            <td>${s.activated}</td>
            <td>${s.total - s.activated}</td>
            <td>
                <a href="/?cat=${enc(c)}" class="green-btn">查看</a>
                <a href="?del_cat=${enc(c)}&mode=keep&cat=${enc(backCatValue(catFilter))}"
                   class="del-btn"
                   onclick="return confirm('仅删除分类「${esc(c)}」？\\n该分类下的 ${s.total} 个序列号会归到「未分类」，不会被删除。')">删分类（留号）</a>
                <a href="?del_cat=${enc(c)}&mode=wipe&cat=${enc(backCatValue(catFilter))}"
                   class="del-btn danger"
                   onclick="return confirm('删除分类「${esc(c)}」并连同其下 ${s.total} 个序列号一起删除？\\n此操作不可恢复！')">删分类 + 删号</a>
            </td>
        </tr>`;
    }
    if (categories.length === 0) {
      catRows += `<tr><td colspan="5" class="muted">还没有自定义分类，可在上方新建，或在添加序列号时直接新建</td></tr>`;
    }

    const adminHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>激活码管理系统</title>
<style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:#f5f7fa;font-size:14px;font-family: "Microsoft YaHei", sans-serif;}

    .container{display:flex;min-height:100vh;position:relative;}
    @media (max-width:768px){
        .container{flex-direction:column;}
    }

    .sidebar{
        width:220px;
        background:#2c3e50;
        color:white;
        padding:15px 0;
        flex-shrink:0;
        transition:all 0.3s ease;
        position:relative;
    }
    .sidebar.collapsed{
        width:70px;
    }

    .sidebar-header {
        padding: 0 15px 12px;
        margin-bottom:12px;
        border-bottom:1px dashed #445;
        font-size:16px;
        white-space:nowrap;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .sidebar.collapsed .sidebar-header span.text{
        display:none;
    }
    .sidebar.collapsed .sidebar-header {
        justify-content: center;
        padding: 0 5px 12px;
    }

    .menu-item{
        padding:12px 15px;
        cursor:pointer;
        border-left:3px solid transparent;
        margin-bottom:4px;
        transition:0.2s;
        display:flex;
        align-items:center;
        gap:8px;
        white-space:nowrap;
    }
    .menu-item .icon{
        font-size:16px;
        width:20px;
        text-align:center;
    }
    .sidebar.collapsed .menu-item{
        justify-content:center;
        padding:12px 5px;
    }
    .sidebar.collapsed .menu-item .text{
        display:none;
    }
    .menu-item.active{background:#34495e;border-left:3px solid #3498db;color:#fff;}
    .menu-item:hover{background:#34495e;}

    @media (max-width:768px){
        .sidebar{width:100% !important;padding:10px 0 !important;}
        .sidebar-header {
            text-align:center;
            padding:0 10px 8px;
            margin-bottom:8px;
            font-size:16px;
            justify-content: center;
        }
        .sidebar.collapsed .sidebar-header span.text{display:inline;}
        .menu-item{
            display:inline-flex;
            border-left:none;
            border-bottom:3px solid transparent;
            margin:0 4px;
            padding:8px 10px;
            font-size:13px;
            justify-content:center;
        }
        .sidebar.collapsed .menu-item .text{display:inline;}
        .menu-item.active{border-left:none;border-bottom:3px solid #3498db;}
    }

    .logout-fixed {
        position: absolute;
        top: 15px;
        right: 20px;
        z-index: 999;
    }
    .logout-fixed a {
        display: inline-block;
        padding: 8px 12px;
        color: #ff6b6b;
        text-decoration: none;
        font-size: 14px;
    }
    @media (max-width:768px){
        .logout-fixed {
            top: 10px;
            right: 10px;
        }
        .logout-fixed a {
            font-size: 13px;
            padding: 6px 8px;
        }
    }

    .content{flex:1;padding:15px;transition:all 0.3s ease;}
    @media (max-width:768px){.content{padding:10px;}}
    .content-title{font-size:18px;margin-bottom:15px;color:#333;font-weight:bold;}
    .box{background:#fff;padding:15px;margin-bottom:15px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);}
    .panel{display:none;}
    .panel.active{display:block;}

    input,textarea,select{padding:8px 10px;margin:6px 0;width:100%;max-width:380px;border:1px solid #ddd;border-radius:4px;background:#fff;font-size:14px;}
    textarea{min-height:80px;resize:vertical;}
    select{max-width:200px;}
    button{padding:8px 16px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;margin:6px 4px;}
    .del-btn{background:#dc3545;padding:4px 10px;font-size:12px;color:#fff;text-decoration:none;border-radius:4px;display:inline-block;margin:2px 2px;}
    .del-btn.danger{background:#a71d2a;}
    .green{background:#28a745;}
    .green-btn{background:#28a745;padding:4px 10px;font-size:12px;color:#fff;text-decoration:none;border-radius:4px;display:inline-block;margin:2px 2px;}
    .inline-form{display:inline-flex;gap:4px;align-items:center;margin:0;}
    .inline-form select,.inline-form input{margin:0;}
    .muted{color:#888;font-size:12px;}

    .filter-bar{margin:4px 0 10px;display:flex;flex-wrap:wrap;gap:6px;}
    .filter-bar a{
        padding:4px 10px;border-radius:14px;background:#eef2f7;color:#33475b;
        text-decoration:none;font-size:12px;border:1px solid #dde5ee;
    }
    .filter-bar a.active{background:#007bff;color:#fff;border-color:#007bff;}

    .table-wrap{overflow-x:auto;width:100%;margin-top:10px;}
    table{border-collapse:collapse;width:100%;min-width:900px;white-space:nowrap;}
    td,th{border:1px solid #ddd;padding:8px;text-align:center;}
    th{background:#f8f9fa;}
    .sn-cell{font-family:Consolas,Menlo,monospace;}
    .st-on{color:#1a7f37;font-weight:bold;}
    .st-off{color:#999;}
    @media (max-width:768px){
        td,th{padding:6px 4px;font-size:12px;}
    }

    .msg{background:#d4edda;color:#155724;padding:8px 12px;border-radius:4px;margin-bottom:10px;}
    .tip{background:#f8f9fa;padding:10px;border-radius:4px;font-size:12px;color:#666;margin-top:10px;line-height:1.6;}
    .tip code{background:#eef2f7;padding:1px 4px;border-radius:3px;font-family:Consolas,Menlo,monospace;}
    pre.out{background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;font-size:12px;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin-top:10px;}
    .warn{background:#fff3cd;color:#8a5a00;border:1px solid #ffe3a3;padding:10px;border-radius:4px;font-size:12px;margin-bottom:12px;line-height:1.6;}
</style>
</head>
<body>

<div class="container">
    <div class="logout-fixed">
        <a href="?logout">🚪 退出登录</a>
    </div>

    <div class="sidebar" id="sidebar">
        <div class="sidebar-header" id="menuToggle">
            <span class="icon">☰</span>
            <span class="text">功能菜单</span>
        </div>

        <div class="menu-item active" onclick="showPanel('list')">
            <span class="icon">📋</span> <span class="text">激活码列表</span>
        </div>
        <div class="menu-item" onclick="showPanel('add')">
            <span class="icon">➕</span> <span class="text">单个添加</span>
        </div>
        <div class="menu-item" onclick="showPanel('batch')">
            <span class="icon">📄</span> <span class="text">批量添加</span>
        </div>
        <div class="menu-item" onclick="showPanel('cat')">
            <span class="icon">🗂</span> <span class="text">分类管理</span>
        </div>
        <div class="menu-item" onclick="showPanel('backup')">
            <span class="icon">💾</span> <span class="text">备份 / 恢复</span>
        </div>
        <div class="menu-item" onclick="showPanel('api')">
            <span class="icon">📡</span> <span class="text">API说明</span>
        </div>
    </div>

    <div class="content">
        ${msg ? `<div class="msg">${esc(msg)}</div>` : ""}

        <div class="panel active" id="panel-list">
            <div class="content-title">📋 激活码列表 <span class="muted">（当前：${esc(viewTitle)} · ${viewRecords.length} 条 · 已激活 ${viewRecords.filter(isActivated).length} 条）</span></div>
            <div class="filter-bar">${filterBar}</div>
            <div class="box">
                <div class="table-wrap">
                    <table>
                        <tr><th>序列号</th><th>分类</th><th>设备ID</th><th>激活时间</th><th>状态</th><th>备注</th><th>操作</th></tr>
                        ${tableRows}
                    </table>
                </div>
                <div class="tip">全部序列号：${allRecords.length} 条 · 已激活：${totalAct} 条 · 未激活：${allRecords.length - totalAct} 条</div>
            </div>
        </div>

        <div class="panel" id="panel-add">
            <div class="content-title">➕ 单个添加激活码</div>
            <div class="box">
                <form method="post">
                    <input type="hidden" name="back_cat" value="${esc(backCatValue(catFilter))}">
                    激活码：<input name="serial" placeholder="请输入序列号" required>
                    添加到分类：
                    <select name="cat">${catOptions("")}</select>
                    <br>或新建分类（填了就以这里为准）：
                    <input name="cat_new" placeholder="新分类名，可留空">
                    <button name="add_single" class="green">确认添加</button>
                </form>
                <div class="tip">分类名不能包含 <code>|</code> 和换行，最长 ${CAT_MAX_LEN} 字；留空即为「未分类」。</div>
            </div>
        </div>

        <div class="panel" id="panel-batch">
            <div class="content-title">📄 批量添加激活码</div>
            <div class="box">
                <form method="post">
                    <input type="hidden" name="back_cat" value="${esc(backCatValue(catFilter))}">
                    一行一个序列号：<br>
                    <textarea name="batch" placeholder="一行一个序列号"></textarea><br>
                    整批归入分类：
                    <select name="cat">${catOptions("")}</select>
                    <br>或新建分类（填了就以这里为准）：
                    <input name="cat_new" placeholder="新分类名，可留空">
                    <button name="add_batch" class="green">批量导入</button>
                </form>
                <div class="tip">已存在的序列号会自动跳过，不会改掉它原来的分类和激活状态。</div>
            </div>
        </div>

        <div class="panel" id="panel-cat">
            <div class="content-title">🗂 分类管理</div>
            <div class="box">
                <form method="post">
                    <input type="hidden" name="back_cat" value="${esc(backCatValue(catFilter))}">
                    新建分类：<input name="new_cat" placeholder="分类名，例如 BarTender 2022" required>
                    <button name="add_category" class="green">新建分类</button>
                </form>
            </div>
            <div class="box">
                <div class="table-wrap">
                    <table>
                        <tr><th>分类</th><th>序列号总数</th><th>已激活</th><th>未激活</th><th>操作</th></tr>
                        ${catRows}
                    </table>
                </div>
                <div class="tip">
                    删除分类有两种方式：<br>
                    · <b>删分类（留号）</b>：只删分类本身，分类下的序列号全部归到「未分类」，激活状态和备注都不受影响。<br>
                    · <b>删分类 + 删号</b>：连同分类下的序列号一起删除，<b>不可恢复</b>，请谨慎操作。
                </div>
            </div>
        </div>

        <div class="panel" id="panel-backup">
            <div class="content-title">💾 备份 / 恢复</div>

            <div class="box">
                <div class="content-title" style="font-size:15px;">① 导出</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;">
                    <a data-export="json" href="?export=json"
                       style="display:inline-block;padding:9px 16px;background:#42a5f5;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;">
                        ⬇ 完整备份（JSON）
                    </a>
                    <a data-export="kv" href="?export=kv"
                       style="display:inline-block;padding:9px 16px;background:#26a69a;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;">
                        ⬇ kv.json（老格式 / 回迁用）
                    </a>
                    <a data-export="txt" href="?export=txt"
                       style="display:inline-block;padding:9px 16px;background:#78909c;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;">
                        ⬇ 序列号纯文本
                    </a>
                </div>
                <label style="display:flex;align-items:center;gap:8px;margin:6px 0 10px;font-size:13px;color:#444;">
                    <input type="checkbox" id="withSecrets" style="width:auto;max-width:none;margin:0;">
                    备份里包含真实密钥（API_TOKEN / ADMIN_TOKEN / API_SECRET）—— 默认打码
                </label>
                <div class="tip">
                    <b>完整备份（JSON）</b>：序列号 + 分类 + 占号记录 + 配置，可以用下面的「导入」原样恢复，搬家首选。<br>
                    <b>kv.json</b>：老格式（整份号池文本），用于回迁 Cloudflare 版，或给还没升级的老版本导入。<br>
                    <b>序列号纯文本</b>：一行一个，贴到「批量添加」里也能用。<br>
                    数据现在存在 SQLite 里（<code>data/btkey.db</code>），服务器上整库备份用 <code>sqlite3 data/btkey.db ".backup ..."</code>。<br>
                    勾选「包含真实密钥」后导出的文件请妥善保管，别上传到公开位置。
                </div>
            </div>

            <div class="box">
                <div class="content-title" style="font-size:15px;">② 导入</div>
                <form method="post" enctype="multipart/form-data">
                    <input type="hidden" name="back_cat" value="${esc(backCatValue(catFilter))}">
                    <div style="margin-bottom:10px;">
                        选择备份文件（.json / .txt）：
                        <input type="file" name="backup_file" accept=".json,.txt,application/json,text/plain"
                               style="display:inline-block;width:auto;max-width:none;padding:6px;">
                    </div>
                    <div style="margin-bottom:6px;">或者把备份内容直接粘贴到下面：</div>
                    <textarea name="backup_text" placeholder="支持三种：① 上面导出的 btkey-backup-*.json；② btkey-kv-*.json；③ 一行一个序列号的纯文本" style="width:100%;max-width:none;height:130px;box-sizing:border-box;"></textarea>
                    <div style="margin:12px 0;font-size:13px;color:#444;line-height:2;">
                        导入方式：
                        <label style="display:inline-flex;align-items:center;gap:6px;margin-right:20px;">
                            <input type="radio" name="import_mode" value="merge" checked style="width:auto;max-width:none;margin:0;">
                            合并（推荐：已存在的号保留原状态，只补新增和空白字段）
                        </label>
                        <label style="display:inline-flex;align-items:center;gap:6px;">
                            <input type="radio" name="import_mode" value="replace" style="width:auto;max-width:none;margin:0;">
                            覆盖（清空现有数据，按备份重建）
                        </label>
                    </div>
                    <button name="backup_import" class="green">开始导入</button>
                </form>
                <div class="warn">
                    ⚠️ <b>覆盖模式会清空现有全部序列号和分类</b>，导入前请先点上面「完整备份」导一份。<br>
                    同一份备份重复导入是安全的：合并模式会跳过已存在的号。
                </div>
            </div>
        </div>

        <div class="panel" id="panel-api">
            <div class="content-title">📡 API 说明</div>

            <div class="box">
                <div class="content-title" style="font-size:15px;">① 客户端激活验证（公开，无需签名）</div>
                <div class="tip">
                    调用：<code>https://你的域名/?device_id=FD6987&amp;serial=6666</code><br>
                    返回：<code>on</code> 验证成功 / <code>off</code> 无效序列号 / <code>off-1</code> 该号已绑定其它设备<br>
                    首次验证成功会自动写入设备ID、激活时间、状态=已激活。
                </div>
            </div>

            <div class="box">
                <div class="content-title" style="font-size:15px;">② 序列号数据接口（需签名，小程序取号用）</div>
                <div class="tip">
                    <b>接口</b>（两种写法等价）：<br>
                    <code>GET /api/serials</code> 或 <code>GET /?api=serials</code><br><br>
                    <b>参数</b>：<br>
                    <code>category</code> 分类名；留空或不传=全部；<code>${UNCAT}</code>=未分类<br>
                    <code>only</code> 可选：<code>all</code>（默认）/ <code>available</code>（只要未激活）/ <code>activated</code>（只要已激活）<br>
                    <code>ts</code> 当前 Unix 秒；<code>nonce</code> 随机串（8~64 位字母数字）；<code>sign</code> 小写十六进制签名<br><br>
                    <b>签名算法</b>：<code>sign = HMAC_SHA256(API_SECRET, 待签名串)</code> 的十六进制<br>
                    待签名串用换行拼接，<b>各参数按你实际发送的原样值参与，没传就是空串</b>：<br>
                    <code>api + "\\n" + category + "\\n" + only + "\\n" + ts + "\\n" + nonce</code><br>
                    其中 <code>api</code> 为 <code>serials</code> 或 <code>categories</code>（即 /api/ 后面的名字）<br>
                    例：请求 <code>serials?category=A&amp;only=available&amp;ts=1760000000&amp;nonce=abc12345</code> 时，
                    待签名串为 <code>serials\\nA\\navailable\\n1760000000\\nabc12345</code><br><br>
                    <b>有效期</b>：ts 与服务器时间相差 ±${API_TS_WINDOW} 秒内有效；nonce 10 分钟内不可重复（防重放）<br>
                    <b>限流</b>：每 IP 每分钟 ${API_MAX_PER_MIN} 次<br>
                    <b>返回</b>：每条含 <code>serial</code>、<code>category</code>、<code>activated</code>（是否激活）、<code>status</code>、<code>device_id</code>、<code>activated_at</code>（激活时间）、<code>note</code><br><br>
                    <b>另一个接口</b>：<code>GET /api/categories</code>（同样要签名）→ 分类清单 + 每个分类的总数/已激活/未激活，小程序选分类时用。
                </div>
                <div class="warn">
                    ⚠️ 安全提醒：小程序里放 <code>API_SECRET</code> 等于把它发给所有用户（包体可被反编译）。
                    推荐做法是<b>小程序先请求你自己的后端</b>（btsm.521156.xyz），由后端用 <code>Authorization: Bearer &lt;API_TOKEN&gt;</code> 调这个接口，
                    密钥只存在服务器上。若确实要小程序直连，至少开启 <code>API_IP_ALLOW</code> 白名单并定期轮换密钥。
                </div>
            </div>

            <div class="box">
                <div class="content-title" style="font-size:15px;">🧪 在线测试（用当前登录态，不需要签名）</div>
                分类：
                <select id="testCat">
                    <option value="">全部</option>
                    <option value="${UNCAT}">未分类</option>
                    ${categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
                </select>
                状态：
                <select id="testOnly">
                    <option value="all">全部</option>
                    <option value="available">仅未激活</option>
                    <option value="activated">仅已激活</option>
                </select>
                <button onclick="testApi('serials')">调用 /api/serials</button>
                <button onclick="testApi('categories')">调用 /api/categories</button>
                <pre class="out" id="testOut">点上面的按钮试试～</pre>
            </div>
        </div>
    </div>
</div>

<script>
const sidebar = document.getElementById('sidebar');
const menuToggle = document.getElementById('menuToggle');
document.addEventListener('DOMContentLoaded', function() {
    const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    if (collapsed) {
        sidebar.classList.add('collapsed');
    }
});
menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
});
function showPanel(name) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
    document.getElementById('panel-' + name).classList.add('active');
    document.querySelector(\`.menu-item[onclick="showPanel('\${name}')"]\`).classList.add('active');
}
// 备份导出：勾选「包含真实密钥」时，给三个下载链接带上 secrets=1
document.addEventListener('DOMContentLoaded', function() {
    const chk = document.getElementById('withSecrets');
    if (!chk) return;
    chk.addEventListener('change', function() {
        const suffix = chk.checked ? '&secrets=1' : '';
        document.querySelectorAll('a[data-export]').forEach(function(a) {
            a.href = '?export=' + a.dataset.export + suffix;
        });
    });
});
async function testApi(api) {
    const out = document.getElementById('testOut');
    const cat = document.getElementById('testCat').value;
    const only = document.getElementById('testOnly').value;
    const qs = new URLSearchParams({ api });
    if (api === 'serials') {
        if (cat) qs.set('category', cat);
        qs.set('only', only);
    }
    out.textContent = '请求中…';
    try {
        const res = await fetch('/?' + qs.toString(), { headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        out.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
        out.textContent = '调用失败：' + e;
    }
}
</script>
</body>
</html>
`;
    return htmlRes(adminHtml);
  }
}
