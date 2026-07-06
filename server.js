const http = require('http');
const fs = require('fs');
const path = require('path');
let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (_) {
  Pool = null;
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const dashboardPath = path.join(__dirname, 'Dashboard_Vendas_MaioJunho.html');
const sheetsPath = path.join(__dirname, 'sheets.json');
const databaseUrl = process.env.DATABASE_URL || '';
const usePostgres = Boolean(databaseUrl && Pool);
const pool = usePostgres ? new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
}) : null;
let dbReady = false;

const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function monthNumber(name) {
  const key = normalizeKey(name);
  return {
    janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
    julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12
  }[key] || 0;
}

function monthShort(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 3).toUpperCase();
}

function isWeekend2026(month, day) {
  if (!month || !day) return false;
  const date = new Date(2026, month - 1, day);
  const weekDay = date.getDay();
  return weekDay === 0 || weekDay === 6;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function parseNumber(value) {
  const clean = String(value || '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const num = Number(clean);
  return Number.isFinite(num) ? num : 0;
}

function findHeaderIndex(header, patterns) {
  return header.findIndex(cell => {
    const key = normalizeKey(cell);
    return patterns.some(pattern => key === pattern || key.includes(pattern));
  });
}

function findDayColumns(header, preferredMonth) {
  const columns = [];
  header.forEach((cell, index) => {
    const match = String(cell || '').match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!match) return;
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day < 1 || day > 31) return;
    columns.push({ day, month, index });
  });

  columns.sort((a, b) => a.day - b.day);
  const monthCounts = columns.reduce((acc, col) => {
    acc[col.month] = (acc[col.month] || 0) + 1;
    return acc;
  }, {});
  const sheetMonth = Number(Object.entries(monthCounts).sort((a, b) => b[1] - a[1])[0]?.[0]) || preferredMonth || 0;
  const filtered = columns.filter(col => !sheetMonth || col.month === sheetMonth);
  return filtered.sort((a, b) => a.day - b.day);
}
function buildDayTypes(month, days) {
  return days.map(day => isWeekend2026(month, day) ? 'FDS' : 'Útil');
}

function splitUtilFds(daily, dt) {
  return daily.reduce((acc, value, index) => {
    if (dt[index] === 'FDS') acc.f += value;
    else acc.u += value;
    return acc;
  }, { u: 0, f: 0 });
}

function parseSheetData(source, text) {
  const rows = String(text || '').split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const headerIndex = rows.findIndex(row => row.some(cell => String(cell).toLowerCase().includes('meta de artigos')));
  if (headerIndex < 0) throw new Error('Estrutura inválida: não encontrei a linha/cabeçalho META DE ARTIGOS. Confira se o link aponta para a aba correta da planilha.');

  const header = rows[headerIndex];
  const totalRowIndex = rows.findIndex((row, index) => index > headerIndex && normalizeKey(row[0]) === 'total_geral');
  if (totalRowIndex < 0) throw new Error('Estrutura inválida: não encontrei a linha Total Geral. Confira se a planilha segue o modelo esperado.');

  const fallbackMonth = monthNumber(source.name);
  const dayColumns = findDayColumns(header, fallbackMonth);
  const totalIndex = findHeaderIndex(header, ['total_geral', 'total']);
  const metaMonthIndex = findHeaderIndex(header, ['meta_mes']);
  const metaPartialIndex = findHeaderIndex(header, ['meta_parcial']);
  const diffMetaIndex = findHeaderIndex(header, ['dif_meta_x_real_n']);
  const month = dayColumns.find(col => col.month)?.month || fallbackMonth;
  const days = dayColumns.map(col => col.day);
  const dt = buildDayTypes(month, days);
  const totalRow = rows[totalRowIndex];
  const daily = dayColumns.map(col => col.index >= 0 ? parseNumber(totalRow[col.index]) : 0);
  const totals = splitUtilFds(daily, dt);
  const metaMonth = metaMonthIndex >= 0 ? parseNumber(totalRow[metaMonthIndex]) : 0;
  const metaPartial = metaPartialIndex >= 0 ? parseNumber(totalRow[metaPartialIndex]) : 0;
  const diffMeta = diffMetaIndex >= 0 ? parseNumber(totalRow[diffMetaIndex]) : daily.reduce((sum, value) => sum + value, 0) - metaPartial;

  const mags = [];
  for (let i = totalRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const name = String(row[0] || '').trim();
    if (!name || normalizeKey(name).includes('total')) continue;
    const rowDaily = dayColumns.map(col => col.index >= 0 ? parseNumber(row[col.index]) : 0);
    const total = totalIndex >= 0 ? parseNumber(row[totalIndex]) : rowDaily.reduce((sum, value) => sum + value, 0);
    const rowMetaMonth = metaMonthIndex >= 0 ? parseNumber(row[metaMonthIndex]) : 0;
    const rowMetaPartial = metaPartialIndex >= 0 ? parseNumber(row[metaPartialIndex]) : 0;
    const rowDiffMeta = diffMetaIndex >= 0 ? parseNumber(row[diffMetaIndex]) : total - rowMetaPartial;
    if (total <= 0 && rowMetaMonth <= 0 && rowMetaPartial <= 0) continue;
    const parts = splitUtilFds(rowDaily, dt);
    mags.push({
      n: name,
      total,
      util: parts.u,
      fds: parts.f,
      d1: rowDaily.length ? rowDaily[rowDaily.length - 1] : 0,
      daily: rowDaily,
      metaMonth: rowMetaMonth,
      metaPartial: rowMetaPartial,
      diffMeta: rowDiffMeta,
      attendPartial: rowMetaPartial > 0 ? total / rowMetaPartial : 0,
      attendMonth: rowMetaMonth > 0 ? total / rowMetaMonth : 0
    });
  }

  return {
    t: daily.reduce((sum, value) => sum + value, 0),
    u: totals.u,
    f: totals.f,
    metaMonth,
    metaPartial,
    diffMeta,
    attendPartial: metaPartial > 0 ? daily.reduce((sum, value) => sum + value, 0) / metaPartial : 0,
    attendMonth: metaMonth > 0 ? daily.reduce((sum, value) => sum + value, 0) / metaMonth : 0,
    d1: daily.length ? daily[daily.length - 1] : 0,
    daily,
    dt,
    label: source.name,
    short: monthShort(source.name),
    days,
    dates: days.map(day => month ? String(day) + '/' + String(month) : String(day)),
    mags
  };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureDefaultSources(data) {
  data.sources = Array.isArray(data.sources) ? data.sources : [];
  for (const name of MONTHS) {
    if (!data.sources.some(item => normalizeKey(item.name) === normalizeKey(name))) {
      data.sources.push({
        name,
        url: '',
        internal: ['Abril', 'Maio', 'Junho'].includes(name),
        createdAt: new Date().toISOString(),
        lastSync: '',
        lastError: '',
        note: ['Abril', 'Maio', 'Junho'].includes(name) ? 'Dados atuais ja embutidos no dashboard' : ''
      });
    }
  }
  data.sources.sort((a, b) => (monthNumber(a.name) || 99) - (monthNumber(b.name) || 99));
  return data;
}

async function initStorage() {
  if (!usePostgres || dbReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const existing = await pool.query('SELECT id FROM dashboard_state WHERE id = 1');
  if (!existing.rowCount) {
    const localData = ensureDefaultSources(readJsonFile(sheetsPath, { sources: [] }));
    await pool.query(
      'INSERT INTO dashboard_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW())',
      [JSON.stringify(localData)]
    );
  }
  dbReady = true;
}

async function loadSheets() {
  if (!usePostgres) return ensureDefaultSources(readJsonFile(sheetsPath, { sources: [] }));
  await initStorage();
  const result = await pool.query('SELECT data FROM dashboard_state WHERE id = 1');
  return ensureDefaultSources(result.rows[0]?.data || { sources: [] });
}

async function saveSheets(data) {
  const safeData = ensureDefaultSources(data || { sources: [] });
  if (!usePostgres) {
    writeJsonFile(sheetsPath, safeData);
    return safeData;
  }
  await initStorage();
  await pool.query(
    `INSERT INTO dashboard_state (id, data, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [JSON.stringify(safeData)]
  );
  return safeData;
}

function storageInfo() {
  return {
    mode: usePostgres ? 'postgres' : 'json',
    postgresConfigured: Boolean(databaseUrl),
    pgPackageAvailable: Boolean(Pool),
    jsonPath: usePostgres ? '' : sheetsPath
  };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function toCsvUrl(rawUrl) {
  const match = rawUrl.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) return rawUrl;
  const gid = rawUrl.match(/[?&]gid=([^&]+)/)?.[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
}

async function fetchSheetSource(source) {
  if (!source.url) {
    return {
      name: source.name,
      ok: true,
      skipped: true,
      bytes: 0,
      preview: '',
      parsed: null,
      fetchedAt: new Date().toISOString(),
      message: source.internal ? 'Dados atuais do dashboard' : 'Sem link cadastrado'
    };
  }

  const csvUrl = toCsvUrl(source.url);
  const response = await fetch(csvUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Não consegui acessar a planilha (HTTP ${response.status}). Verifique se o link está compartilhado/publicado e se a aba está correta.`);
  const text = await response.text();
  return {
    name: source.name,
    ok: true,
    bytes: Buffer.byteLength(text, 'utf8'),
    preview: text.slice(0, 500),
    parsed: parseSheetData(source, text),
    fetchedAt: new Date().toISOString()
  };
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo nao encontrado');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/storage' && req.method === 'GET') {
      sendJson(res, 200, storageInfo());
      return;
    }

    if (url.pathname === '/api/sheets' && req.method === 'GET') {
      sendJson(res, 200, await loadSheets());
      return;
    }

    if (url.pathname === '/api/sheets' && req.method === 'POST') {
      const body = await readBody(req);
      const originalName = String(body.originalName || '').trim();
      const name = String(body.name || '').trim();
      const sheetUrl = String(body.url || '').trim();

      if (!name) {
        sendJson(res, 400, { error: 'Informe nome do mes.' });
        return;
      }

      const data = await loadSheets();
      const lookupName = originalName || name;
      const existing = data.sources.find(src => src.name.toLowerCase() === lookupName.toLowerCase());
      if (existing) {
        existing.name = name;
        existing.url = sheetUrl;
        existing.updatedAt = new Date().toISOString();
      } else {
        data.sources.push({ name, url: sheetUrl, createdAt: new Date().toISOString() });
      }
      await saveSheets(data);
      sendJson(res, 200, data);
      return;
    }
    if (url.pathname === '/api/sheets' && req.method === 'DELETE') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();

      if (!name) {
        sendJson(res, 400, { error: 'Informe o nome do mes para remover.' });
        return;
      }

      const data = await loadSheets();
      data.sources = data.sources.filter(src => src.name.toLowerCase() !== name.toLowerCase());
      await saveSheets(data);
      sendJson(res, 200, data);
      return;
    }
    if (url.pathname === '/api/sheets/update' && req.method === 'POST') {
      const data = await loadSheets();
      const results = [];

      for (const source of data.sources) {
        try {
          const result = await fetchSheetSource(source);
          source.lastSync = result.fetchedAt;
          source.lastBytes = result.bytes;
          source.lastPreview = result.preview;
          if (result.parsed) source.parsed = result.parsed;
          source.lastError = '';
          results.push(result);
        } catch (err) {
          source.lastError = err.message;
          delete source.parsed;
          results.push({ name: source.name, ok: false, error: err.message });
        }
      }

      data.lastUpdate = new Date().toISOString();
      data.history = Array.isArray(data.history) ? data.history : [];
      results.forEach(result => data.history.push({ name: result.name, ok: result.ok, skipped: Boolean(result.skipped), total: result.parsed ? result.parsed.t : null, mags: result.parsed ? result.parsed.mags.length : null, error: result.error || '', at: result.fetchedAt || data.lastUpdate }));
      data.history = data.history.slice(-80);
      await saveSheets(data);
      sendJson(res, 200, { ...data, results });
      return;
    }

    if (url.pathname === '/' || url.pathname === '/login') {
      sendFile(res, dashboardPath);
      return;
    }

    const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const filePath = path.join(__dirname, safePath);

    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Acesso negado');
      return;
    }

    sendFile(res, filePath);
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Erro interno' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard rodando em http://localhost:${PORT}`);
  console.log(`Login/dashboard: http://localhost:${PORT}/login`);
});





















