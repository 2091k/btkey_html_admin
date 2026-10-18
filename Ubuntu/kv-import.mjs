/**
 * kv-import.mjs —— 把 Cloudflare KV（或老的 kv.json）导进本地 SQLite
 *
 * 用法：
 *   # ① 从 Cloudflare 导出两个 key（或直接用后台「💾 备份 / 恢复 → kv.json」下载）
 *   npx wrangler kv:key get --namespace-id=<ID> "bt_list" > bt_list.txt
 *   npx wrangler kv:key get --namespace-id=<ID> "bt_categories" > bt_categories.json
 *
 *   # ② 导入到 SQLite（默认 ./data/btkey.db，可用 --db 指定）
 *   node --experimental-sqlite kv-import.mjs bt_list.txt bt_categories.json
 *   node --experimental-sqlite kv-import.mjs bt_list.txt bt_categories.json --db ./data/btkey.db
 *
 *   # ③ 也可以直接导一份老的 kv.json（后台导出的那种 {key:{v}} 结构）
 *   node --experimental-sqlite kv-import.mjs data/btkey-kv.json
 *
 * 特点：只「补」，不删。已存在的号会保留原来的状态（不会把你已经发出去的号重置）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { SerialDB } from './db.mjs';
import { SqlKV, KV_DATA_KEY, KV_CAT_KEY } from './store.mjs';

const argv = process.argv.slice(2);
const dbFlag = argv.indexOf('--db');
const dbFile = dbFlag > -1 ? argv[dbFlag + 1] : (process.env.DB_PATH || './data/btkey.db');
const files = argv.filter((a, i) => i !== dbFlag && i !== dbFlag + 1);

if (!files.length) {
  console.error('用法: node --experimental-sqlite kv-import.mjs <bt_list.txt|kv.json> [bt_categories.json] [--db ./data/btkey.db]');
  process.exit(1);
}

const db = new SerialDB(dbFile);
const kv = new SqlKV(db);
const before = db.count();

// ───────── 情况 A：一次给一个老的 kv.json（后台导出的整份） ─────────
const first = files[0];
if (!existsSync(first)) {
  console.error('找不到文件: ' + first);
  process.exit(1);
}
const firstText = readFileSync(first, 'utf8').replace(/^\uFEFF/, '').trim();

let kvJson = null;
if (first.toLowerCase().endsWith('.json') || firstText.startsWith('{')) {
  try { kvJson = JSON.parse(firstText); } catch { kvJson = null; }
}

if (kvJson && typeof kvJson === 'object' && !Array.isArray(kvJson)) {
  // 兼容：{ key: { v } } 或 { kv: { key: 字符串 } } 或 { key: "字符串" }
  const src = (kvJson.kv && typeof kvJson.kv === 'object') ? kvJson.kv : kvJson;
  let serials = 0;
  for (const [k, rec] of Object.entries(src)) {
    const v = rec && typeof rec === 'object' ? String(rec.v ?? '') : String(rec ?? '');
    if (k === KV_DATA_KEY) {
      serials = v.split('\n').map((s) => s.trim()).filter(Boolean).length;
      await kv.put(k, v);
    } else if (k === KV_CAT_KEY || k.startsWith('claiminfo:') || k.startsWith('claimbyreq:')) {
      await kv.put(k, v);
    }
  }
  console.log(`✓ 已从 ${first} 导入：序列号 ${serials} 行`);
} else {
  // ───────── 情况 B：纯文本号列表 + 可选分类文件 ─────────
  const rows = firstText.split('\n').map((s) => s.trim()).filter(Boolean);
  // 与库里现有的号合并（不覆盖已有状态）
  const existing = await kv.get(KV_DATA_KEY);
  const existSet = new Set((existing || '').split('\n').filter(Boolean).map((l) => l.split('|')[0]));
  const merged = (existing ? existing + '\n' : '') + rows.filter((l) => !existSet.has(l.split('|')[0])).join('\n');
  await kv.put(KV_DATA_KEY, merged);
  console.log(`✓ 已导入序列号 ${rows.length} 行（库里原有 ${existSet.size} 个）`);

  if (files[1]) {
    const catFile = files[1];
    if (!existsSync(catFile)) {
      console.error('找不到文件: ' + catFile);
      process.exit(1);
    }
    const raw = readFileSync(catFile, 'utf8').trim();
    let cats = null;
    try { cats = JSON.parse(raw); } catch { cats = null; }
    if (!Array.isArray(cats)) cats = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    const cur = db.listCategories();
    const mergedCats = [...new Set([...cur, ...cats.filter((c) => typeof c === 'string' && c.trim())])];
    await kv.put(KV_CAT_KEY, JSON.stringify(mergedCats));
    console.log(`✓ 已导入分类 ${cats.length} 个（合并后 ${mergedCats.length} 个）`);
  }
}

// ───────── 汇总 ─────────
const after = db.count();
const cats = db.listCategories();
const stats = {};
for (const r of db.listSerials()) {
  const k = r.category || '(未分类)';
  stats[k] = (stats[k] || 0) + 1;
}
console.log(`\n数据库: ${db.file}`);
console.log(`序列号: ${before} → ${after} 条（新增 ${after - before}）`);
console.log('分类  : ' + (cats.length ? cats.join('、') : '(无)'));
console.log('分布  :');
for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v} 条`);
console.log('\n导入完成，重启服务后生效：systemctl restart btkey-server');
db.close();
