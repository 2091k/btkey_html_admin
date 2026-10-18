/**
 * store.mjs —— 把 SQLite 包装成 workers.js 认识的「KV 接口」
 *
 * workers.js 里的数据访问只有这几种：
 *   KV.get(key) / KV.put(key, value, {expirationTtl}) / KV.delete(key) / KV.list({prefix})
 *   key = bt_list（整个号池文本）、bt_categories、claiminfo:xxx、claimbyreq:xxx、rl:xxx:分钟
 *
 * 这里把它们各自映射到真正的 SQL 表和行，而不是「一个大字符串」：
 *   bt_list       ↔ serials 表（一行一个号；put 时做差异同步，只改变化的行）
 *   bt_categories ↔ categories 表
 *   claiminfo:*   ↔ claims 表
 *   claimbyreq:*  ↔ claim_reqs 表
 *   rl:*          ↔ rate 表
 *   其它 key      ↔ kv 表（行为与 KV 一致，带 TTL）
 *
 * 好处：workers.js 的业务代码（后台页面、增删改、导出）一行都不用改，
 * 数据却是真·SQL；并发占号另外走 db.claimAtomic()，由 workers.js 的 apiClaim 直接调用。
 */

/** 一行记录 → 原来的 "序列号|设备|时间|状态|备注|分类" 文本（与 workers.js 的 serializeRecord 同规则） */
function lineOf(r) {
  const serial = String(r.serial ?? '');
  const device = String(r.device ?? '');
  const time = String(r.time ?? '');
  const status = String(r.status ?? '');
  const note = String(r.note ?? '');
  const category = String(r.category ?? '');
  const activated = !!(device || time || status);
  if (!activated && !category) return note ? `${serial}|${note}` : serial;
  const parts = [serial, device, time, status, note];
  if (category) parts.push(category);
  return parts.join('|');
}

/** 文本行 → 记录（workers.js 的 parseRecord 同规则，兼容老的两段格式） */
function recordOf(line) {
  const arr = String(line).split('|');
  if (arr.length >= 3) {
    return {
      serial: (arr[0] || '').trim(),
      device: (arr[1] || '').trim(),
      time: (arr[2] || '').trim(),
      status: (arr[3] || '').trim(),
      note: (arr[4] || '').trim(),
      category: (arr[5] || '').trim(),
    };
  }
  return {
    serial: (arr[0] || '').trim(),
    device: '', time: '', status: '',
    note: (arr[1] || '').trim(),
    category: '',
  };
}

export const KV_DATA_KEY = 'bt_list';
export const KV_CAT_KEY = 'bt_categories';

export class SqlKV {
  constructor(db) {
    this.db = db;
    /** workers.js 用它走原子占号路径 */
    this.sql = db;
  }

  // ───────── 读 ─────────

  async get(key) {
    const k = String(key);

    if (k === KV_DATA_KEY) {
      const rows = this.db.listSerials();
      if (!rows.length) return null;
      return rows.map(lineOf).join('\n');
    }
    if (k === KV_CAT_KEY) {
      const cats = this.db.listCategories();
      return cats.length ? JSON.stringify(cats) : null;
    }
    if (k.startsWith('claiminfo:')) {
      const row = this.db.claimGet(k.slice('claiminfo:'.length));
      if (!row) return null;
      return JSON.stringify({ request_id: row.request_id, at: Number(row.at), confirmed: !!row.confirmed });
    }
    if (k.startsWith('claimbyreq:')) {
      const row = this.db.getClaimReq(k.slice('claimbyreq:'.length));
      if (!row) return null;
      return JSON.stringify({ serial: row.serial, category: row.category, at: Number(row.at) });
    }
    if (k.startsWith('rl:')) {
      return this.db.kvGet(k);
    }
    return this.db.kvGet(k);
  }

  // ───────── 写 ─────────

  async put(key, value, opts) {
    const k = String(key);
    const v = String(value == null ? '' : value);
    const ttl = Number((opts && opts.expirationTtl) || 0);

    if (k === KV_DATA_KEY) {
      const records = v.split('\n').map((s) => s.trim()).filter(Boolean).map(recordOf).filter((r) => r.serial);
      this.db.syncSerials(records);
      return null;
    }
    if (k === KV_CAT_KEY) {
      let cats = [];
      try { cats = JSON.parse(v); } catch { cats = []; }
      if (!Array.isArray(cats)) cats = [];
      this.db.replaceCategories(cats);
      return null;
    }
    if (k.startsWith('claiminfo:')) {
      let meta = {};
      try { meta = JSON.parse(v); } catch { meta = {}; }
      this.db.claimPut(k.slice('claiminfo:'.length), {
        requestId: meta.request_id || '',
        at: Number(meta.at) || 0,
        confirmed: !!meta.confirmed,
        ttl: ttl || 86400,
      });
      return null;
    }
    if (k.startsWith('claimbyreq:')) {
      let meta = {};
      try { meta = JSON.parse(v); } catch { meta = {}; }
      const serial = String(meta.serial || '');
      if (serial) {
        this.db.db.prepare(
          `INSERT INTO claim_reqs (request_id, serial, category, at, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(request_id) DO UPDATE SET serial = excluded.serial,
             category = excluded.category, at = excluded.at, expires_at = excluded.expires_at`
        ).run(k.slice('claimbyreq:'.length), serial, String(meta.category || ''),
          Number(meta.at) || Math.floor(Date.now() / 1000),
          Math.floor(Date.now() / 1000) + (ttl || 604800));
      }
      return null;
    }
    this.db.kvPut(k, v, ttl);
    return null;
  }

  async delete(key) {
    const k = String(key);
    if (k === KV_DATA_KEY) {
      this.db.syncSerials([]);
      return null;
    }
    if (k === KV_CAT_KEY) {
      this.db.replaceCategories([]);
      return null;
    }
    if (k.startsWith('claiminfo:')) {
      this.db.claimDelete(k.slice('claiminfo:'.length));
      return null;
    }
    if (k.startsWith('claimbyreq:')) {
      this.db.deleteClaimReq(k.slice('claimbyreq:'.length));
      return null;
    }
    this.db.kvDelete(k);
    return null;
  }

  // ───────── 列表（导出/迁移用） ─────────

  async list(opts = {}) {
    const prefix = String(opts.prefix || '');
    const names = [];

    const pushIf = (name) => {
      if (!prefix || name.startsWith(prefix)) names.push(name);
    };

    pushIf(KV_DATA_KEY);
    pushIf(KV_CAT_KEY);

    if (!prefix || prefix.startsWith('claiminfo')) {
      for (const k of this.db.listClaimKeys('claiminfo:')) pushIf(k);
    }
    if (!prefix || prefix.startsWith('claimbyreq')) {
      for (const k of this.db.listClaimKeys('claimbyreq:')) pushIf(k);
    }
    for (const k of this.db.kvKeys(prefix)) pushIf(k);

    return { keys: names.map((name) => ({ name })), list_complete: true, cursor: undefined };
  }

  /** 本地实现用：不需要分页游标 */
  keys() {
    const out = [KV_DATA_KEY, KV_CAT_KEY];
    out.push(...this.db.listClaimKeys('claiminfo:'));
    out.push(...this.db.listClaimKeys('claimbyreq:'));
    out.push(...this.db.kvKeys(''));
    return out;
  }
}
