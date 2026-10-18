/**
 * db.mjs —— 序列号后台的 SQLite 数据层（和小程序后端 wxminiapp-server 同一套做法）
 *
 * 为什么不再用 KV：
 *   KV 里整个号池是「一个 key 里的一整段文本」，取号 = 读全量 → 遍历挑一个 → 写回全量，
 *   号多了又慢又没法保证并发下不把同一个号发给两个人。
 *   换成 SQL 后：一行一个号，占号是一条 UPDATE ... RETURNING，天然原子。
 *
 * 表结构：
 *   serials      号池，一行一个号（serial 主键）
 *   categories   分类
 *   claims       号 → 占号信息（request_id / at / confirmed），带过期时间
 *   claim_reqs   request_id → 号（幂等：同一 request_id 重复请求返回同一个号）
 *   rate         限流计数（bucket + 分钟）
 *   kv           兜底：其它零散 key，行为与 KV 一致（带 TTL）
 *
 * 只用 Node 内置 node:sqlite（Node 22.5+ 需 --experimental-sqlite，23.4+ 不用）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS serials (
  serial     TEXT PRIMARY KEY,
  device     TEXT NOT NULL DEFAULT '',
  time       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT '',
  pos        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_serials_cat    ON serials(category, status);
CREATE INDEX IF NOT EXISTS idx_serials_pos    ON serials(pos);
-- 取号专用索引：category + status + pos，让「按顺序拿第一个可用号」直接走索引
CREATE INDEX IF NOT EXISTS idx_serials_claim  ON serials(category, status, pos);
-- 回收过期占位时按 status 过滤，必须有单列索引，否则每次取号都全表扫（几十万行时会明显变慢）
CREATE INDEX IF NOT EXISTS idx_serials_status ON serials(status);

CREATE TABLE IF NOT EXISTS categories (
  name       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS claims (
  serial     TEXT PRIMARY KEY,
  request_id TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL DEFAULT 0,
  confirmed  INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS claim_reqs (
  request_id TEXT PRIMARY KEY,
  serial     TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT NOT NULL,
  minute INTEGER NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, minute)
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * "可发放" 的 SQL 条件：没被占、没激活、没作废、没有设备（与 workers.js 的 isAvailable 对齐）
 * 注意：入库时会把老数据里的 "未激活" 归一成 ""（两者语义完全相同），
 * 所以这里能用等值 `status = ''`：等值 + (category,status,pos) 索引 → 直接定位第一条可用号。
 * 如果写成 `status IN ('', '未激活')`，SQLite 就没法用索引排序，会退化成全表排序。
 */
const AVAILABLE_SQL = "(status = '' AND device = '')";

/** 状态归一：老的 "未激活" 等于空串，统一存空串 */
function normalizeStatus(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '未激活' ? '' : s;
}

export class SerialDB {
  constructor(file = './data/btkey.db') {
    const target = file === ':memory:' ? file : path.resolve(file);
    if (target !== ':memory:') mkdirSync(path.dirname(target), { recursive: true });
    this.file = target;
    this.db = new DatabaseSync(target);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = OFF;');
    this.db.exec(SCHEMA);
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }

  // ───────────────── 序列号 ─────────────────

  /** 全部号，按 pos 升序（pos 小的排前面，等价于原来的「文件顺序」） */
  listSerials() {
    return this.db.prepare(
      'SELECT serial, device, time, status, note, category FROM serials ORDER BY pos ASC, serial ASC'
    ).all();
  }

  count() {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM serials').get().c || 0);
  }

  getSerial(serial) {
    return this.db.prepare(
      'SELECT serial, device, time, status, note, category FROM serials WHERE serial = ?'
    ).get(String(serial)) || null;
  }

  /**
   * 把一整份列表同步进库（对应原来 KV.put('bt_list', 文本)）：
   * 只更新真正变化的行，删掉列表里没有的行，并在同一个事务里维护 pos 顺序。
   * @param {{serial:string,device:string,time:string,status:string,note:string,category:string}[]} records
   * @returns {{added:number, updated:number, removed:number}}
   */
  syncSerials(records) {
    const list = (records || []).filter((r) => r && r.serial);
    const existing = new Map(
      this.db.prepare('SELECT serial, device, time, status, note, category, pos FROM serials').all()
        .map((r) => [r.serial, r])
    );

    const ins = this.db.prepare(
      `INSERT INTO serials (serial, device, time, status, note, category, pos, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upd = this.db.prepare(
      `UPDATE serials SET device = ?, time = ?, status = ?, note = ?, category = ?, pos = ?
       WHERE serial = ?`
    );
    const del = this.db.prepare('DELETE FROM serials WHERE serial = ?');

    let added = 0, updated = 0, removed = 0;
    const seen = new Set();
    const now = Math.floor(Date.now() / 1000);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const serial = String(r.serial);
        seen.add(serial);
        const cur = existing.get(serial);
        const status = normalizeStatus(r.status);
        if (!cur) {
          ins.run(serial, String(r.device || ''), String(r.time || ''), status,
            String(r.note || ''), String(r.category || ''), i, now);
          added++;
          continue;
        }
        const changed = cur.device !== String(r.device || '')
          || cur.time !== String(r.time || '')
          || cur.status !== status
          || cur.note !== String(r.note || '')
          || cur.category !== String(r.category || '')
          || Number(cur.pos) !== i;
        if (changed) {
          upd.run(String(r.device || ''), String(r.time || ''), status,
            String(r.note || ''), String(r.category || ''), i, serial);
          updated++;
        }
      }
      for (const serial of existing.keys()) {
        if (!seen.has(serial)) { del.run(serial); removed++; }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    return { added, updated, removed };
  }

  /** 原子占号：一条 UPDATE ... RETURNING，并发下绝不会把同一个号发给两个人 */
  claimAtomic({ category, exclude = [], requestId, at, pendingTtl = 300 }) {
    const ex = (exclude || []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 20);
    const placeholders = ex.map(() => '?').join(',');
    const now = Number(at || Math.floor(Date.now() / 1000));

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // ① 回收「已领取」但迟迟没 confirm 的占位（与 workers.js 的 reclaimStaleClaims 等价）
      this.db.prepare(
        `UPDATE serials SET status = ''
          WHERE status = '已领取'
            AND serial IN (
              SELECT s.serial FROM serials s
              LEFT JOIN claims c ON c.serial = s.serial
              WHERE s.status = '已领取'
                AND (c.serial IS NULL OR (c.confirmed = 0 AND (? - COALESCE(c.at, 0)) > ?))
            )`
      ).run(now, Number(pendingTtl));

      // ② 挑一个可用号并占住
      const pickSql = `
        UPDATE serials SET status = '已领取'
         WHERE serial = (
           SELECT serial FROM serials
            WHERE category = ? AND ${AVAILABLE_SQL}
              ${ex.length ? `AND serial NOT IN (${placeholders})` : ''}
            ORDER BY pos ASC, serial ASC
            LIMIT 1
         )
         RETURNING serial`;
      const row = this.db.prepare(pickSql).get(String(category), ...ex);
      if (!row || !row.serial) {
        this.db.exec('COMMIT');
        return null;
      }
      const serial = row.serial;

      // ③ 记幂等 + 占号信息
      this.db.prepare(
        `INSERT INTO claims (serial, request_id, at, confirmed, expires_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(serial) DO UPDATE SET request_id = excluded.request_id,
           at = excluded.at, confirmed = 0, expires_at = excluded.expires_at`
      ).run(serial, String(requestId || ''), now, now + 86400);

      this.db.prepare(
        `INSERT INTO claim_reqs (request_id, serial, category, at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET serial = excluded.serial,
           category = excluded.category, at = excluded.at, expires_at = excluded.expires_at`
      ).run(String(requestId || ''), serial, String(category || ''), now, now + 604800);

      this.db.exec('COMMIT');
      return serial;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  /** 按 request_id 取上次发的号（幂等用） */
  getClaimReq(requestId) {
    const row = this.db.prepare(
      'SELECT request_id, serial, category, at, expires_at FROM claim_reqs WHERE request_id = ?'
    ).get(String(requestId));
    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
    return row;
  }

  deleteClaimReq(requestId) {
    this.db.prepare('DELETE FROM claim_reqs WHERE request_id = ?').run(String(requestId));
  }

  // ───────────────── 分类 ─────────────────

  listCategories() {
    return this.db.prepare('SELECT name FROM categories ORDER BY created_at ASC, name ASC')
      .all().map((r) => r.name).filter((n) => typeof n === 'string' && n.trim());
  }

  /** 整份替换分类（保持顺序） */
  replaceCategories(list) {
    const names = (list || []).filter((n) => typeof n === 'string' && n.trim());
    const ins = this.db.prepare(
      'INSERT INTO categories (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING'
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM categories WHERE name NOT IN (' +
        (names.length ? names.map(() => '?').join(',') : "''") + ')').run(...names);
      const now = Math.floor(Date.now() / 1000);
      names.forEach((n, i) => ins.run(n, now + i));
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  // ───────────────── 占号记录 / 限流 / 兜底 KV ─────────────────

  claimGet(serial) {
    const row = this.db.prepare(
      'SELECT serial, request_id, at, confirmed, expires_at FROM claims WHERE serial = ?'
    ).get(String(serial));
    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
    return row;
  }

  claimPut(serial, { requestId = '', at = 0, confirmed = false, ttl = 86400 } = {}) {
    const now = Number(at || Math.floor(Date.now() / 1000));
    this.db.prepare(
      `INSERT INTO claims (serial, request_id, at, confirmed, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(serial) DO UPDATE SET request_id = excluded.request_id, at = excluded.at,
         confirmed = excluded.confirmed, expires_at = excluded.expires_at`
    ).run(String(serial), String(requestId || ''), now, confirmed ? 1 : 0, now + Number(ttl || 0));
  }

  claimDelete(serial) {
    this.db.prepare('DELETE FROM claims WHERE serial = ?').run(String(serial));
  }

  listClaimKeys(prefix = 'claiminfo:') {
    if (prefix.startsWith('claiminfo')) {
      return this.db.prepare('SELECT serial FROM claims').all().map((r) => 'claiminfo:' + r.serial);
    }
    return this.db.prepare('SELECT request_id FROM claim_reqs').all()
      .map((r) => 'claimbyreq:' + r.request_id);
  }

  /** 计数 +1，返回新值（原子） */
  bumpRate(bucket, minute, ttlSec = 120) {
    const row = this.db.prepare(
      `INSERT INTO rate (bucket, minute, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, minute) DO UPDATE SET count = count + 1
       RETURNING count`
    ).get(String(bucket), Number(minute));
    // 顺手清理过期分钟，避免表无限长
    this.db.prepare('DELETE FROM rate WHERE minute < ?')
      .run(Number(minute) - Math.ceil(Number(ttlSec) / 60) - 1);
    return Number(row && row.count || 0);
  }

  kvGet(key) {
    const row = this.db.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(String(key));
    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
    return String(row.value);
  }

  kvPut(key, value, ttlSec = 0) {
    const exp = Number(ttlSec) > 0 ? Math.floor(Date.now() / 1000) + Number(ttlSec) : 0;
    this.db.prepare(
      `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
    ).run(String(key), String(value == null ? '' : value), exp);
  }

  kvDelete(key) {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(String(key));
  }

  kvKeys(prefix = '') {
    const now = Math.floor(Date.now() / 1000);
    return this.db.prepare(
      `SELECT key FROM kv WHERE key LIKE ? AND (expires_at = 0 OR expires_at > ?)`
    ).all(String(prefix) + '%', now).map((r) => r.key);
  }

  /** 库里有没有数据（判断是否需要从老的 kv.json 自动导入） */
  isEmpty() {
    return this.count() === 0
      && Number(this.db.prepare('SELECT COUNT(*) AS c FROM categories').get().c || 0) === 0;
  }
}
