/**
 * test-ubuntu.mjs —— 验证「Ubuntu 运行壳」能跑通（不改 workers.js）
 *
 *   node test-ubuntu.mjs
 *
 * 覆盖：
 *   ① .env 占位密码时拒绝启动
 *   ② 启动后：登录页 / 登录 / 批量导号 / 列表
 *   ③ 小程序后端要用的接口：/api/ping、/api/categories、/api/claim、/api/confirm、/api/release
 *   ④ 取号幂等（同一 request_id 不会占两个号）+ exclude 跳过
 *   ⑤ 数据落盘（KV 文件里真的有号，重启不丢）
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18788;
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'test_api_token_0123456789abcdef';
const ADMIN = { user: 'admin', pass: 'TestPass123' };

const work = mkdtempSync(join(tmpdir(), 'btkey-'));
const DB_PATH = join(work, 'btkey.db');
const LEGACY_KV_FILE = join(work, 'legacy-kv.json');

let pass = 0;
const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) pass += 1;
  else fails.push(msg + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
};

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.mjs'], {
    cwd: DIR,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      LEGACY_KV_FILE,
      ADMIN_USER: ADMIN.user,
      ADMIN_PASS: ADMIN.pass,
      ADMIN_TOKEN: 'test_admin_token',
      API_TOKEN: TOKEN,
      ...extraEnv,
    },
  });
  child.on('error', () => {});
  return child;
}

async function waitReady(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/ping', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const json = (path, { method = 'GET', body, cookie } = {}) => fetch(BASE + path, {
  method,
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + TOKEN,
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});

// ───────── ① 占位密码应拒绝启动 ─────────
{
  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.mjs'], {
    cwd: DIR,
    stdio: 'ignore',
    env: {
      ...process.env, PORT: String(PORT + 1), DB_PATH: join(work, 'db2.db'),
      ADMIN_USER: 'admin', ADMIN_PASS: '改成你的后台密码',
    },
  });
  const code = await new Promise((resolve) => {
    child.on('exit', resolve);
    setTimeout(() => { child.kill(); resolve('timeout'); }, 6000);
  });
  ok(code === 1, '占位密码应直接退出（exit 1）', code);
}

// ───────── ② 启动 ─────────
const server = startServer();
const ready = await waitReady();
ok(ready, 'server.mjs 应能启动并响应 /api/ping');

if (ready) {
  // 登录页
  {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    ok(r.status === 200 && html.includes('name="login"'), '未登录应返回登录页');
  }

  // 登录拿 Cookie
  let cookie = '';
  {
    const body = new URLSearchParams({ login: '1', user: ADMIN.user, pass: ADMIN.pass });
    const r = await fetch(BASE + '/', { method: 'POST', body, redirect: 'manual' });
    cookie = ((r.headers.getSetCookie ? r.headers.getSetCookie() : [])[0] || '').split(';')[0];
    ok(r.status === 302 && !!cookie, '登录应 302 并下发 Cookie', { status: r.status, cookie });
  }

  // 建分类
  {
    const body = new URLSearchParams({ add_category: '1', new_cat: 'wxminiapp', back_cat: '' });
    const r = await fetch(BASE + '/', { method: 'POST', body, headers: { Cookie: cookie }, redirect: 'manual' });
    ok(r.status === 302, '新建分类应 302', r.status);
  }

  // 往该分类导 3 个号
  {
    const body = new URLSearchParams({
      add_batch: '1', batch: 'BT-U-001\nBT-U-002\nBT-U-003', cat: 'wxminiapp', back_cat: 'wxminiapp',
    });
    const r = await fetch(BASE + '/', { method: 'POST', body, headers: { Cookie: cookie }, redirect: 'manual' });
    ok(r.status === 302, '批量导号应 302', r.status);

    const list = await (await fetch(BASE + '/', { headers: { Cookie: cookie } })).text();
    ok(list.includes('BT-U-001') && list.includes('BT-U-003'), '列表应出现导入的号');
  }

  // /api/categories
  {
    const r = await json('/api/categories');
    const d = await r.json();
    ok(r.status === 200 && d.ok, '/api/categories 应 200', { status: r.status, d });
    ok(JSON.stringify(d).includes('wxminiapp'), '分类里应有 wxminiapp', d);
  }

  // /api/claim
  let claimed = '';
  {
    const r = await json('/api/claim', { method: 'POST', body: { category: 'wxminiapp', request_id: 'req_ubuntu_001' } });
    const d = await r.json();
    claimed = d.serial || '';
    ok(r.status === 200 && d.ok && /^BT-U-00[123]$/.test(claimed), '取号应返回池子里的号', { status: r.status, d });
  }

  // 幂等：同一 request_id 再取，应返回同一个号
  {
    const r = await json('/api/claim', { method: 'POST', body: { category: 'wxminiapp', request_id: 'req_ubuntu_001' } });
    const d = await r.json();
    ok(d.ok && d.serial === claimed && d.repeated === true, '同一 request_id 应幂等返回同一个号', d);
  }

  // exclude：跳过刚占的号
  {
    const r = await json('/api/claim', { method: 'POST', body: { category: 'wxminiapp', request_id: 'req_ubuntu_002', exclude: [claimed] } });
    const d = await r.json();
    ok(d.ok && d.serial && d.serial !== claimed, 'exclude 应跳过指定号', d);
  }

  // /api/confirm
  {
    const r = await json('/api/confirm', { method: 'POST', body: { serial: claimed, request_id: 'req_ubuntu_001' } });
    const d = await r.json();
    ok(r.status === 200 && d.ok, '/api/confirm 应 200', { status: r.status, d });
  }

  // 参数校验
  {
    const r1 = await json('/api/claim', { method: 'POST', body: { category: '', request_id: 'req_ubuntu_003' } });
    ok(r1.status === 400, '分类为空应 400', r1.status);
    const r2 = await json('/api/claim', { method: 'POST', body: { category: 'wxminiapp', request_id: 'short' } });
    ok(r2.status === 400, 'request_id 太短应 400', r2.status);
  }

  // 无令牌访问数据接口
  {
    const r = await fetch(BASE + '/api/serials');
    ok([401, 503].includes(r.status), '无令牌访问 /api/serials 应被拒', r.status);
  }

  // ───────── ③ 备份导出 ─────────
  let backup = null;
  {
    const r = await fetch(BASE + '/?export=json', { headers: { Cookie: cookie } });
    const text = await r.text();
    ok(r.status === 200, '导出 JSON 应 200', r.status);
    ok(/attachment; filename="btkey-backup-\d+\.json"/.test(r.headers.get('content-disposition') || ''),
      '导出应作为附件下载', r.headers.get('content-disposition'));
    try { backup = JSON.parse(text); } catch { backup = null; }
    ok(!!backup && backup.format === 'btkey-backup' && backup.version === 1, '备份格式标识应正确', backup && backup.format);
    ok(backup && backup.kv && /BT-U-001/.test(backup.kv.bt_list), '备份里应含序列号', backup && backup.kv && backup.kv.bt_list.slice(0, 60));
    ok(backup && Array.isArray(backup.categories) && backup.categories.includes('wxminiapp'), '备份里应含分类', backup && backup.categories);
    ok(backup && backup.counts.serials === 3, '备份统计的序列号数量应正确', backup && backup.counts);
    ok(backup && backup.config.API_TOKEN === '***已隐藏***', '默认不导出真实密钥', backup && backup.config.API_TOKEN);
    ok(backup && backup.config.ADMIN_USER === ADMIN.user, '配置里应含后台账号');
    ok(backup && Object.keys(backup.kv).some((k) => k.startsWith('claimbyreq:')), '备份里应含占号记录');
  }

  // 带 secrets=1 时导出真实密钥
  {
    const r = await fetch(BASE + '/?export=json&secrets=1', { headers: { Cookie: cookie } });
    const d = await r.json();
    ok(d.config.API_TOKEN === TOKEN, '勾选包含密钥时应导出真实 API_TOKEN', d.config.API_TOKEN);
  }

  // kv.json 格式（能直接当 data/btkey-kv.json 用）
  {
    const r = await fetch(BASE + '/?export=kv', { headers: { Cookie: cookie } });
    const d = await r.json();
    ok(r.status === 200 && d.bt_list && typeof d.bt_list.v === 'string', 'kv 导出应是 {key:{v}} 结构', Object.keys(d).slice(0, 4));
    ok(/BT-U-001/.test(d.bt_list.v), 'kv 导出里应有序列号');
  }

  // 纯文本导出
  {
    const r = await fetch(BASE + '/?export=txt', { headers: { Cookie: cookie } });
    const text = await r.text();
    const lines = text.replace(/^\uFEFF/, '').split('\n').filter(Boolean);
    ok(r.status === 200 && lines.length === 3, '纯文本导出应为 3 行', lines.length);
    ok(lines.includes('BT-U-001'), '纯文本里应有 BT-U-001', lines);
  }

  // 未登录不能导出
  {
    const r = await fetch(BASE + '/?export=json', { redirect: 'manual' });
    ok(r.status === 302, '未登录导出应被拦回登录页', r.status);
  }

  // ───────── ④ 备份导入 ─────────
  /** Location 里的 + 是空格，断言前还原 */
  const locOf = (h) => decodeURIComponent(String(h || '').replace(/\+/g, ' '));
  const postForm = (fields, extra = {}) => fetch(BASE + '/', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
    ...extra,
  });
  const readList = async () => (await (await fetch(BASE + '/', { headers: { Cookie: cookie } })).text());

  // 合并导入：删掉一个号后用备份恢复
  {
    await fetch(BASE + '/?del_sn=BT-U-002', { headers: { Cookie: cookie }, redirect: 'manual' });
    ok(!(await readList()).includes('BT-U-002'), '删除后列表不应再有 BT-U-002');

    const r = await postForm({ backup_import: '1', import_mode: 'merge', backup_text: JSON.stringify(backup) });
    const loc = locOf(r.headers.get('location'));
    ok(r.status === 302, '导入应 302 回到列表', r.status);
    ok(/已合并导入/.test(loc), '导入后应提示合并结果', loc);
    ok((await readList()).includes('BT-U-002'), '备份里被删的号应被恢复');
  }

  // 再导一次：合并模式应全部跳过
  {
    const r = await postForm({ backup_import: '1', import_mode: 'merge', backup_text: JSON.stringify(backup) });
    const loc = locOf(r.headers.get('location'));
    ok(/新增 0 条/.test(loc), '重复导入应全部跳过', loc);
  }

  // 纯文本导入（一行一个序列号）
  {
    const r = await postForm({ backup_import: '1', import_mode: 'merge', backup_text: 'BT-TXT-001\nBT-TXT-002' });
    const loc = locOf(r.headers.get('location'));
    ok(/新增 2 条/.test(loc), '纯文本导入应新增 2 条', loc);
    const html = await readList();
    ok(html.includes('BT-TXT-001') && html.includes('BT-TXT-002'), '纯文本导入的号应出现在列表');
  }

  // 覆盖导入：列表应只剩备份里的号
  {
    const r = await postForm({ backup_import: '1', import_mode: 'replace', backup_text: JSON.stringify(backup) });
    const loc = locOf(r.headers.get('location'));
    ok(/已覆盖导入/.test(loc), '覆盖导入应提示', loc);
    const html = await readList();
    ok(html.includes('BT-U-001') && !html.includes('BT-TXT-001'), '覆盖后只应保留备份里的号', { hasTxt: html.includes('BT-TXT-001') });
  }

  // 文件上传方式导入
  {
    const fd = new FormData();
    fd.append('backup_import', '1');
    fd.append('import_mode', 'merge');
    fd.append('backup_file', new File([JSON.stringify({
      format: 'btkey-backup', version: 1, kv: { bt_list: 'BT-FILE-001\nBT-FILE-002' },
    })], 'backup.json', { type: 'application/json' }));
    const r = await fetch(BASE + '/', { method: 'POST', headers: { Cookie: cookie }, body: fd, redirect: 'manual' });
    const loc = locOf(r.headers.get('location'));
    ok(r.status === 302 && /新增 2 条/.test(loc), '上传文件导入应新增 2 条', loc);
    ok((await readList()).includes('BT-FILE-001'), '上传导入的号应出现在列表');
  }

  // 空内容 / 无效内容
  {
    const r1 = await postForm({ backup_import: '1', import_mode: 'merge', backup_text: '   ' });
    const loc1 = locOf(r1.headers.get('location'));
    ok(/没有拿到内容/.test(loc1), '空内容应提示', loc1);

    const r2 = await postForm({ backup_import: '1', import_mode: 'merge', backup_text: '{"format":"btkey-backup","kv":{}}' });
    const loc2 = locOf(r2.headers.get('location'));
    ok(/没有可用的数据/.test(loc2), '空备份应提示没有数据', loc2);
  }

  // 占号记录恢复后仍然幂等（req_ubuntu_001 已有记录）
  {
    const r = await json('/api/claim', { method: 'POST', body: { category: 'wxminiapp', request_id: 'req_ubuntu_001' } });
    const d = await r.json();
    ok(d.ok && d.repeated === true, '导入后同一 request_id 仍应幂等', { ok: d.ok, repeated: d.repeated, error: d.error });
  }
}

// ───────── ⑥ 数据落盘（SQLite：一行一个号，不是一整段文本） ─────────
{
  ok(existsSync(DB_PATH), '应生成 SQLite 数据库文件', DB_PATH);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((r) => r.name);
  for (const t of ['serials', 'categories', 'claims', 'claim_reqs', 'rate', 'kv']) {
    ok(tables.includes(t), `数据库里应有表 ${t}`, tables);
  }
  const rows = db.prepare('SELECT serial, status, category FROM serials').all();
  ok(rows.length >= 3, 'serials 表里应有序列号行', rows.length);
  ok(rows.some((r) => r.serial === 'BT-U-001'), 'serials 表里应有 BT-U-001', rows.map((r) => r.serial).slice(0, 6));
  ok(rows.some((r) => r.category === 'wxminiapp'), '序列号的行里应存有分类');
  ok(db.prepare('SELECT COUNT(*) AS c FROM categories').get().c >= 1, 'categories 表里应有分类');
  ok(db.prepare("SELECT COUNT(*) AS c FROM claims WHERE serial = 'BT-U-001'").get().c >= 1,
    'claims 表里应记录占号信息');
  const reqRow = db.prepare("SELECT * FROM claim_reqs WHERE request_id = 'req_ubuntu_001'").get();
  ok(!!reqRow && reqRow.serial === 'BT-U-001', 'claim_reqs 表里应记录幂等键', reqRow);
  db.close();
}

// ───────── ⑦ 并发取号不会重发（SQL 原子占号的核心价值） ─────────
{
  ok(ready, '服务未启动，跳过并发测试');
  if (ready) {
    // 先补 12 个号
    const batch = Array.from({ length: 12 }, (_, i) => 'BT-CC-' + String(i + 1).padStart(3, '0')).join('\n');
    const cookie2 = await (async () => {
      const body = new URLSearchParams({ login: '1', user: ADMIN.user, pass: ADMIN.pass });
      const r = await fetch(BASE + '/', { method: 'POST', body, redirect: 'manual' });
      return ((r.headers.getSetCookie() || [])[0] || '').split(';')[0];
    })();
    await fetch(BASE + '/', {
      method: 'POST', headers: { Cookie: cookie2 }, redirect: 'manual',
      body: new URLSearchParams({ add_batch: '1', batch, cat: 'wxminiapp', back_cat: 'wxminiapp' }),
    });

    // 20 个并发请求抢这 12 个号
    const jobs = Array.from({ length: 20 }, (_, i) =>
      json('/api/claim', {
        method: 'POST',
        body: { category: 'wxminiapp', request_id: 'req_cc_' + String(i + 1).padStart(4, '0') },
      }).then((r) => r.json()).catch(() => ({ ok: false })));
    const results = await Promise.all(jobs);
    const got = results.filter((d) => d && d.ok && d.serial).map((d) => d.serial);
    const uniq = new Set(got);
    ok(got.length > 0, '并发取号应至少有成功的', got.length);
    ok(uniq.size === got.length, '并发取号不允许发出重复的号', { got: got.length, uniq: uniq.size, dup: got.filter((s, i) => got.indexOf(s) !== i) });

    // 每个发出去的号，库里都应变成「已领取」，且一批号里至少拿到一部分
    const { DatabaseSync } = await import('node:sqlite');
    const db2 = new DatabaseSync(DB_PATH);
    const bad = [];
    for (const s of got) {
      const row = db2.prepare('SELECT status FROM serials WHERE serial = ?').get(s);
      if (!row || row.status !== '已领取') bad.push({ serial: s, status: row && row.status });
    }
    ok(bad.length === 0, '并发取到的号在库里都应标记为已领取', bad);
    const ccClaimed = db2.prepare("SELECT COUNT(*) AS c FROM serials WHERE serial LIKE 'BT-CC-%' AND status = '已领取'").get().c;
    ok(ccClaimed >= 12 || got.length >= 12, '刚导入的那批号应被并发取走', { ccClaimed, got: got.length });
    db2.close();
  }
}

// ───────── ⑧ 老的 kv.json 自动迁移（数据怎么进来） ─────────
{
  const migWork = mkdtempSync(join(tmpdir(), 'btkey-mig-'));
  const legacy = join(migWork, 'btkey-kv.json');
  const migDb = join(migWork, 'btkey.db');
  const LEGACY = ['BT-M1|||未激活||wxminiapp', 'BT-M2||2026-09-01|已激活|老数据|wxminiapp'].join('\n');
  writeFileSync(legacy, JSON.stringify({
    bt_list: { v: LEGACY },
    bt_categories: { v: '["wxminiapp","默认"]' },
    'claiminfo:BT-M2': { v: '{"request_id":"req_mig_0001","at":1760000000,"confirmed":true}' },
    'claimbyreq:req_mig_0001': { v: '{"serial":"BT-M2","category":"wxminiapp","at":1760000000}' },
  }, null, 2), 'utf8');

  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.mjs'], {
    cwd: DIR,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(PORT + 2),
      DB_PATH: migDb,
      LEGACY_KV_FILE: legacy,
      ADMIN_USER: ADMIN.user,
      ADMIN_PASS: ADMIN.pass,
      ADMIN_TOKEN: 'test_admin_token',
      API_TOKEN: TOKEN,
    },
  });

  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + (PORT + 2) + '/api/ping', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (r.status === 200) { up = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  ok(up, '带旧 kv.json 时应能正常启动');

  if (up) {
    const { DatabaseSync } = await import('node:sqlite');
    const db3 = new DatabaseSync(migDb);
    const rows = db3.prepare('SELECT serial, device, time, status, note, category FROM serials ORDER BY pos').all();
    ok(rows.length === 2, '旧 kv.json 的 2 个号应被迁移进 serials 表', rows);
    ok(rows[1] && rows[1].status === '已激活' && rows[1].note === '老数据'
      && rows[1].time === '2026-09-01' && rows[1].category === 'wxminiapp',
      '迁移时状态/时间/备注/分类都应保留', rows[1]);
    ok(db3.prepare("SELECT COUNT(*) AS c FROM categories WHERE name IN ('wxminiapp','默认')").get().c === 2,
      '分类应被迁移', db3.prepare('SELECT name FROM categories').all());
    ok(db3.prepare("SELECT COUNT(*) AS c FROM claim_reqs WHERE request_id = 'req_mig_0001'").get().c === 1,
      '占号幂等记录应被迁移');
    db3.close();
    ok(existsSync(legacy + '.imported') && !existsSync(legacy),
      '迁移完成后旧文件应被改名，避免重复导入');
  }
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 250));
  try { rmSync(migWork, { recursive: true, force: true }); } catch {}
}

// ───────── ⑨ 为什么必须上 SQL：KV 的「读-改-写」并发会重发 ─────────
{
  const { SerialDB } = await import('./db.mjs');
  const { SqlKV } = await import('./store.mjs');

  // ① 老 KV 路径：读全量 → 挑一个 → 写回全量（没有原子性）
  const db1 = new SerialDB(':memory:');
  const kv1 = new SqlKV(db1);
  await kv1.put('bt_list', ['K1|||未激活||wxminiapp', 'K2|||未激活||wxminiapp', 'K3|||未激活||wxminiapp'].join('\n'));
  const kvClaim = async () => {
    const rows = (await kv1.get('bt_list')).split('\n').map((l) => l.split('|'));
    // 可发放 = 状态为空（老的"未激活"入库时已归一成空串）
    const pick = rows.find((a) => a[0] && (a[3] === '' || a[3] === '未激活') && !a[1]);
    if (!pick) return null;
    const serial = pick[0];
    pick[3] = '已领取';
    await kv1.put('bt_list', rows.map((a) => a.join('|')).join('\n'));
    return serial;
  };
  const kvGot = (await Promise.all([kvClaim(), kvClaim(), kvClaim(), kvClaim()])).filter(Boolean);
  ok(new Set(kvGot).size < kvGot.length, '（对照）KV 读改写路径并发确实会重发同一个号', kvGot);

  // ② SQL 路径：claimAtomic 一条 UPDATE…RETURNING
  const db2 = new SerialDB(':memory:');
  await db2.syncSerials(['S1', 'S2', 'S3'].map((s) => ({
    serial: s, device: '', time: '', status: '', note: '', category: 'wxminiapp',
  })));
  const now = Math.floor(Date.now() / 1000);
  const sqlGot = ['r1', 'r2', 'r3', 'r4']
    .map((rid, i) => db2.claimAtomic({ category: 'wxminiapp', requestId: 'req_' + rid + '0001', at: now + i }))
    .filter(Boolean);
  ok(sqlGot.length === 3, 'SQL 原子占号：3 个号只能发出 3 个', sqlGot);
  ok(new Set(sqlGot).size === sqlGot.length, 'SQL 原子占号不允许重发', sqlGot);
  db1.close();
  db2.close();
}

// 收尾：杀掉进程 + 清临时目录
try { server.kill(); } catch {}
await new Promise((r) => setTimeout(r, 300));
try { rmSync(work, { recursive: true, force: true }); } catch {}

if (fails.length) {
  console.log('\n=== ' + fails.length + ' 项未通过（通过 ' + pass + ' 项）===');
  fails.forEach((f) => console.log('ERR   ' + f));
  process.exitCode = 1;
} else {
  console.log(`\n✓ SQL 版序列号后台测试通过（${pass} 项断言：启动 / 登录 / 导号 / 取号 / 幂等 / 并发不重发 / 导出 / 导入 / SQL 落盘）`);
}
