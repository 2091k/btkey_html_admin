/**
 * server.mjs —— 把 Cloudflare Worker（workers.js）包装成普通 Node HTTP 服务
 *
 * 数据层已从「KV（一个 key 存整段文本）」换成和 wxminiapp-server 一样的 SQLite：
 *   workers.js 仍然通过 KV 接口读写，但底下映射到真正的关系表（见 store.mjs / db.mjs）；
 *   占号走 db.claimAtomic()，一条 UPDATE…RETURNING，并发不会把同一个号发给两个人。
 *
 * 启动（Node 22.5+ 需要 --experimental-sqlite，Node 23.4+/24 不需要）：
 *   node --experimental-sqlite server.mjs
 *
 * 环境变量（也可写同目录 .env，真实环境变量优先）：
 *   PORT            监听端口，默认 8788
 *   DB_PATH         SQLite 文件，默认 ./data/btkey.db
 *   LEGACY_KV_FILE  老版本的 KV JSON（默认 ./data/btkey-kv.json）；首次启动会自动导入后改名
 *   ADMIN_USER / ADMIN_PASS / ADMIN_TOKEN / API_TOKEN / API_SECRET / API_IP_ALLOW / API_MAX_PER_MIN
 */
import http from 'node:http';
import { readFileSync, existsSync, renameSync } from 'node:fs';
import { SerialDB } from './db.mjs';
import { SqlKV, KV_DATA_KEY, KV_CAT_KEY } from './store.mjs';

// ① 读取同目录 .env（只支持 KEY=值 和整行 # 注释；真实环境变量优先）
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
} catch { /* 没有 .env 就用真实环境变量 */ }

const PORT = Number(process.env.PORT || 8788);
const DB_PATH = process.env.DB_PATH || './data/btkey.db';
const LEGACY_KV_FILE = process.env.LEGACY_KV_FILE || './data/btkey-kv.json';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const PLACEHOLDER = '改成你的后台密码';

// ② 参数检查：后台账号密码必须自己设
if (!ADMIN_USER || !ADMIN_PASS || ADMIN_PASS === PLACEHOLDER) {
  console.error('[错误] 请先在 .env 里设置后台账号密码：');
  console.error('       ADMIN_USER=你的账号');
  console.error('       ADMIN_PASS=你的密码（不要留空、不要用 .env 里的占位文字）');
  process.exit(1);
}

// ③ SQLite 数据层 + KV 兼容适配器
const db = new SerialDB(DB_PATH);
const kv = new SqlKV(db);
console.log('[btkey] 数据库    : ' + db.file);

// ④ 老的 KV JSON 自动迁移（只导一次，成功后把文件改名，避免重复导入）
try {
  if (existsSync(LEGACY_KV_FILE) && db.isEmpty()) {
    const raw = JSON.parse(readFileSync(LEGACY_KV_FILE, 'utf8'));
    let n = 0;
    for (const [k, rec] of Object.entries(raw || {})) {
      const v = rec && typeof rec === 'object' ? String(rec.v ?? '') : String(rec ?? '');
      if (k === KV_DATA_KEY) {
        const rows = v.split('\n').map((s) => s.trim()).filter(Boolean).length;
        await kv.put(k, v);
        n += rows;
        continue;
      }
      if (k === KV_CAT_KEY) { await kv.put(k, v); continue; }
      if (k.startsWith('claiminfo:') || k.startsWith('claimbyreq:')) { await kv.put(k, v); continue; }
    }
    const done = LEGACY_KV_FILE + '.imported';
    try { renameSync(LEGACY_KV_FILE, done); } catch { /* 改名失败不影响使用 */ }
    console.log(`[btkey] 已从 ${LEGACY_KV_FILE} 迁移 ${n} 条序列号到 SQLite`);
    console.log(`[btkey] 原文件已改名为 ${done}`);
  }
} catch (e) {
  console.warn('[btkey] 旧 KV 文件迁移失败（可忽略，稍后用后台「导入」恢复）：' + (e && e.message));
}

// ⑤ 加载 workers.js（ESM 语法但扩展名是 .js，用 data:URL 强制按 ESM 执行）
const src = readFileSync(new URL('./workers.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;

// ⑥ 构造 env
const env = {
  bt_KV: kv,        // workers.js 里的 KV 接口（底下是 SQL 表）
  bt_DB: db,        // 原子占号用
  ADMIN_USER,
  ADMIN_PASS,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  API_TOKEN: process.env.API_TOKEN || '',
  API_SECRET: process.env.API_SECRET || '',
  API_IP_ALLOW: process.env.API_IP_ALLOW || '',
  API_MAX_PER_MIN: process.env.API_MAX_PER_MIN || '60',
};

console.log('[btkey] 号池数量  : ' + db.count() + ' 条 · 分类 ' + db.listCategories().length + ' 个');
console.log('[btkey] 后台账号  : ' + ADMIN_USER);
console.log('[btkey] API_TOKEN : ' + (env.API_TOKEN ? '已配置（' + env.API_TOKEN.length + ' 位）' : '未配置 ← 小程序取号会失败'));
console.log('[btkey] API_SECRET: ' + (env.API_SECRET ? '已配置' : '未配置（/api/serials 签名接口不可用，走 Bearer 不受影响）'));

// ⑦ HTTP 服务
http.createServer(async (req, res) => {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = new URL(req.url, proto + '://' + (req.headers.host || '127.0.0.1'));
    const init = { method: req.method, headers: new Headers(req.headers) };
    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = req;
      init.duplex = 'half';
    }
    const resp = await worker.fetch(new Request(url, init), env);
    const headers = {};
    for (const [k, v] of resp.headers) headers[k] = v;
    const sc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    if (sc.length) headers['set-cookie'] = sc;
    res.writeHead(resp.status, headers);
    res.end(Buffer.from(await resp.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('internal_error: ' + (e && e.message ? e.message : String(e)));
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('[btkey] 已启动: http://0.0.0.0:' + PORT + '  （后台首页 / ，登录后才能增删号）');
});

// ⑧ 优雅退出：关掉 SQLite
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { db.close(); } catch {}
    process.exit(0);
  });
}
