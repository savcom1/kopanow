'use strict';

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

// ─── helpers ──────────────────────────────────────────────────────────────────

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function serializeVal(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') return JSON.stringify(val);
  return val;
}

// Translate PostgREST aggregate selector (e.g. 'amount.sum()') to SQL function call.
function translateSelectCols(cols, countExact, countHead) {
  if (countHead) return 'COUNT(*)';
  const parts = (cols || '*').split(',').map((c) => c.trim()).filter(Boolean).map((c) => {
    const m = c.match(/^(\w+)\.(\w+)\(\)$/);
    return m ? `${m[2].toUpperCase()}(${quoteIdent(m[1])})` : c;
  });
  if (countExact) parts.push('COUNT(*) OVER() AS __total_count');
  return parts.join(', ');
}

// Split OR string by commas but respect parentheses depth.
function splitOrParts(orStr) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of orStr) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Parse (id1,"id 2",...) → array of strings.
function parseInList(raw) {
  let s = String(raw).trim();
  if (s.startsWith('(')) s = s.slice(1);
  if (s.endsWith(')')) s = s.slice(0, -1);
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !inQuote) { inQuote = true; }
    else if (ch === '"' && inQuote) {
      if (s[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = false;
    } else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim() !== '') result.push(cur.trim());
  return result;
}

// ─── QueryBuilder ──────────────────────────────────────────────────────────────

class QueryBuilder {
  constructor(table) {
    this._table = table;
    this._op = 'select';
    this._selectCols = '*';
    this._countExact = false;
    this._countHead = false;
    this._filters = [];
    this._orderBy = [];
    this._limitVal = null;
    this._rangeFrom = null;
    this._rangeTo = null;
    this._writeRows = null;   // insert / upsert rows
    this._updateData = null;  // update SET data
    this._conflictCols = null;
    this._ignoreDups = false;
    this._returning = false;
    this._returningCols = '*';
    this._single = false;
    this._maybeSingle = false;
    this._throwOnError = false;
  }

  // ── Operations ───────────────────────────────────────────────────────────

  select(cols = '*', opts = {}) {
    if (this._op === 'select') {
      this._selectCols = cols || '*';
      this._countExact = !!(opts && opts.count === 'exact');
      this._countHead  = !!(opts && opts.count === 'exact' && opts.head);
    } else {
      // Called after insert/update/upsert → RETURNING
      this._returning = true;
      this._returningCols = cols || '*';
    }
    return this;
  }

  insert(data) {
    this._op = 'insert';
    this._writeRows = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data) {
    this._op = 'update';
    this._updateData = data;
    return this;
  }

  upsert(data, opts = {}) {
    this._op = 'upsert';
    this._writeRows = Array.isArray(data) ? data : [data];
    this._conflictCols = opts.onConflict || null;
    this._ignoreDups = !!(opts.ignoreDuplicates);
    return this;
  }

  delete() {
    this._op = 'delete';
    return this;
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  eq(col, val)     { this._filters.push({ t: 'eq',     col, val }); return this; }
  neq(col, val)    { this._filters.push({ t: 'neq',    col, val }); return this; }
  gt(col, val)     { this._filters.push({ t: 'gt',     col, val }); return this; }
  gte(col, val)    { this._filters.push({ t: 'gte',    col, val }); return this; }
  lt(col, val)     { this._filters.push({ t: 'lt',     col, val }); return this; }
  lte(col, val)    { this._filters.push({ t: 'lte',    col, val }); return this; }
  in(col, arr)     { this._filters.push({ t: 'in',     col, arr: arr || [] }); return this; }
  is(col, val)     { this._filters.push({ t: 'is',     col, val }); return this; }
  ilike(col, pat)  { this._filters.push({ t: 'ilike',  col, pat }); return this; }
  or(orStr)        { this._filters.push({ t: 'or',     orStr }); return this; }

  not(col, op, val) {
    this._filters.push({ t: 'not', col, op, val });
    return this;
  }

  filter(col, op, val) {
    this._filters.push({ t: 'filter', col, op, val });
    return this;
  }

  // ── Order / pagination ───────────────────────────────────────────────────

  order(col, opts = {}) {
    this._orderBy.push({ col, asc: opts.ascending !== false, nullsFirst: opts.nullsFirst });
    return this;
  }

  limit(n) { this._limitVal = n; return this; }

  range(from, to) { this._rangeFrom = from; this._rangeTo = to; return this; }

  // ── Modifiers ────────────────────────────────────────────────────────────

  single()       { this._single = true;      return this; }
  maybeSingle()  { this._maybeSingle = true; return this; }
  throwOnError() { this._throwOnError = true; return this; }

  // ── SQL construction ──────────────────────────────────────────────────────

  _clause(f, params) {
    const q = quoteIdent(f.col);
    switch (f.t) {
      case 'eq':    params.push(serializeVal(f.val)); return `${q} = $${params.length}`;
      case 'neq':   params.push(serializeVal(f.val)); return `${q} != $${params.length}`;
      case 'gt':    params.push(serializeVal(f.val)); return `${q} > $${params.length}`;
      case 'gte':   params.push(serializeVal(f.val)); return `${q} >= $${params.length}`;
      case 'lt':    params.push(serializeVal(f.val)); return `${q} < $${params.length}`;
      case 'lte':   params.push(serializeVal(f.val)); return `${q} <= $${params.length}`;
      case 'in': {
        if (!f.arr || !f.arr.length) return 'FALSE';
        const ph = f.arr.map((v) => { params.push(serializeVal(v)); return `$${params.length}`; });
        return `${q} IN (${ph.join(', ')})`;
      }
      case 'is':
        if (f.val === null || f.val === undefined) return `${q} IS NULL`;
        if (f.val === true)  return `${q} IS TRUE`;
        if (f.val === false) return `${q} IS FALSE`;
        return `${q} IS NULL`;
      case 'ilike':
        params.push(f.pat);
        return `${q} ILIKE $${params.length}`;
      case 'filter':
        if (f.op === 'cs') {
          params.push(serializeVal(f.val));
          return `${q} @> $${params.length}::jsonb`;
        }
        params.push(serializeVal(f.val));
        return `${q} = $${params.length}`;
      case 'not':
        if (f.op === 'is') {
          if (f.val === null || f.val === undefined) return `${q} IS NOT NULL`;
          if (f.val === true)  return `${q} IS NOT TRUE`;
          if (f.val === false) return `${q} IS NOT FALSE`;
          return `${q} IS NOT NULL`;
        }
        if (f.op === 'in') {
          const ids = parseInList(String(f.val));
          if (!ids.length) return 'TRUE';
          const ph = ids.map((v) => { params.push(v); return `$${params.length}`; });
          return `${q} NOT IN (${ph.join(', ')})`;
        }
        params.push(serializeVal(f.val));
        return `${q} != $${params.length}`;
      case 'or': {
        const parts = splitOrParts(f.orStr).map((part) => {
          const d1 = part.indexOf('.');
          if (d1 === -1) return 'FALSE';
          const col = part.slice(0, d1);
          const rest = part.slice(d1 + 1);
          const d2 = rest.indexOf('.');
          if (d2 === -1) return 'FALSE';
          const op  = rest.slice(0, d2);
          const val = rest.slice(d2 + 1);
          const qc  = quoteIdent(col);
          if (op === 'ilike') {
            params.push(val);
            return `${qc} ILIKE $${params.length}`;
          }
          if (op === 'in') {
            const ids = parseInList(val);
            if (!ids.length) return 'FALSE';
            const ph = ids.map((v) => { params.push(v); return `$${params.length}`; });
            return `${qc} IN (${ph.join(', ')})`;
          }
          if (op === 'eq') {
            params.push(val);
            return `${qc} = $${params.length}`;
          }
          if (op === 'is') {
            if (val === 'null') return `${qc} IS NULL`;
            return `${qc} IS NOT NULL`;
          }
          params.push(val);
          return `${qc} = $${params.length}`;
        });
        return '(' + parts.join(' OR ') + ')';
      }
      default: return 'TRUE';
    }
  }

  _whereSql(params) {
    if (!this._filters.length) return '';
    return 'WHERE ' + this._filters.map((f) => this._clause(f, params)).join(' AND ');
  }

  _orderSql() {
    if (!this._orderBy.length) return '';
    return 'ORDER BY ' + this._orderBy.map(({ col, asc, nullsFirst }) => {
      let s = quoteIdent(col) + (asc ? ' ASC' : ' DESC');
      if (nullsFirst === true)  s += ' NULLS FIRST';
      if (nullsFirst === false) s += ' NULLS LAST';
      return s;
    }).join(', ');
  }

  _paginationSql(params) {
    if (this._rangeFrom !== null && this._rangeTo !== null) {
      params.push(this._rangeTo - this._rangeFrom + 1);
      const limitPh = `$${params.length}`;
      params.push(this._rangeFrom);
      return ` LIMIT ${limitPh} OFFSET $${params.length}`;
    }
    if (this._limitVal !== null) {
      params.push(this._limitVal);
      return ` LIMIT $${params.length}`;
    }
    return '';
  }

  _returningClause() {
    if (!this._returning) return '';
    if (this._returningCols === '*' || !this._returningCols) return ' RETURNING *';
    return ' RETURNING ' + this._returningCols;
  }

  _buildSql() {
    const params = [];
    const t = quoteIdent(this._table);
    let sql;

    if (this._op === 'select') {
      const cols  = translateSelectCols(this._selectCols, this._countExact, this._countHead);
      const where = this._whereSql(params);
      const order = this._orderSql();
      const page  = this._paginationSql(params);
      sql = `SELECT ${cols} FROM ${t}${where ? ' ' + where : ''}${order ? ' ' + order : ''}${page}`;

    } else if (this._op === 'insert') {
      const rows = this._writeRows;
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const cols = keys.map(quoteIdent).join(', ');
      const vals = rows.map((row) => {
        const ph = keys.map((k) => { params.push(serializeVal(k in row ? row[k] : null)); return `$${params.length}`; });
        return `(${ph.join(', ')})`;
      }).join(', ');
      sql = `INSERT INTO ${t} (${cols}) VALUES ${vals}${this._returningClause()}`;

    } else if (this._op === 'update') {
      const data = this._updateData;
      const keys = Object.keys(data);
      const set  = keys.map((k) => { params.push(serializeVal(data[k])); return `${quoteIdent(k)} = $${params.length}`; }).join(', ');
      const where = this._whereSql(params); // WHERE params assigned AFTER SET params
      sql = `UPDATE ${t} SET ${set}${where ? ' ' + where : ''}${this._returningClause()}`;

    } else if (this._op === 'upsert') {
      const rows = this._writeRows;
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const cols = keys.map(quoteIdent).join(', ');
      const vals = rows.map((row) => {
        const ph = keys.map((k) => { params.push(serializeVal(k in row ? row[k] : null)); return `$${params.length}`; });
        return `(${ph.join(', ')})`;
      }).join(', ');

      let conflict = '';
      if (this._conflictCols) {
        const cc = this._conflictCols.split(',').map((c) => quoteIdent(c.trim())).join(', ');
        if (this._ignoreDups) {
          conflict = ` ON CONFLICT (${cc}) DO NOTHING`;
        } else {
          const conflictSet = new Set(this._conflictCols.split(',').map((c) => c.trim()));
          const updKeys = keys.filter((k) => !conflictSet.has(k));
          if (updKeys.length) {
            const upd = updKeys.map((k) => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`).join(', ');
            conflict = ` ON CONFLICT (${cc}) DO UPDATE SET ${upd}`;
          } else {
            conflict = ` ON CONFLICT (${cc}) DO NOTHING`;
          }
        }
      }
      sql = `INSERT INTO ${t} (${cols}) VALUES ${vals}${conflict}${this._returningClause()}`;

    } else if (this._op === 'delete') {
      const where = this._whereSql(params);
      sql = `DELETE FROM ${t}${where ? ' ' + where : ''}`;
    }

    return { sql, params };
  }

  // ── Execute ───────────────────────────────────────────────────────────────

  async _execute() {
    const { sql, params } = this._buildSql();

    try {
      const result = await pool.query(sql, params);

      // COUNT(*) head query
      if (this._op === 'select' && this._countHead) {
        return { data: null, error: null, count: Number(result.rows[0]?.count ?? 0) };
      }

      // Write ops without RETURNING
      if ((this._op === 'insert' || this._op === 'update' || this._op === 'upsert') && !this._returning) {
        return { data: null, error: null };
      }
      if (this._op === 'delete') {
        return { data: null, error: null };
      }

      let rows = result.rows;
      let count;

      // Strip window-function count
      if (this._op === 'select' && this._countExact) {
        count = rows.length > 0 ? Number(rows[0].__total_count ?? 0) : 0;
        rows = rows.map(({ __total_count, ...rest }) => rest);
      }

      // single / maybeSingle
      let data;
      if (this._single || this._maybeSingle) {
        data = rows[0] ?? null;
      } else {
        data = rows;
      }

      const ret = { data, error: null };
      if (count !== undefined) ret.count = count;
      return ret;

    } catch (err) {
      console.error(`[db] ${this._op} "${this._table}":`, err.message);
      if (this._throwOnError) throw err;
      return { data: null, error: err };
    }
  }

  // Thenable so `await query` works
  then(resolve, reject) { return this._execute().then(resolve, reject); }
  catch(reject)         { return this._execute().catch(reject); }
}

// ── Exported facade ──────────────────────────────────────────────────────────

module.exports = {
  from(table) { return new QueryBuilder(table); },
};
