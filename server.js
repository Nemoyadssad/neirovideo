require('dotenv').config(); // локально подхватит .env; на Railway переменные придут из Variables и это просто ничего не сделает

const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const app = express();
app.set('trust proxy', 1); // Railway стоит за прокси, без этого secure-куки не работают

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!process.env.SESSION_SECRET) {
  console.warn('ВНИМАНИЕ: SESSION_SECRET не задан в переменных окружения — задайте его в Railway Variables!');
}

// Сессии через Postgres (переживают рестарт сервиса)
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 дней
  }
}));

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Создаём таблицу при старте
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      k TEXT NOT NULL,
      shared BOOLEAN NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (k, shared, owner)
    );
  `);
  console.log('DB ready');
}
initDb().catch(e => { console.error('DB init failed:', e); process.exit(1); });

// Middleware: browser id в httpOnly-куке для персональных (не shared) данных
app.use((req, res, next) => {
  let bid = req.cookies.bid;
  if (!bid) {
    bid = crypto.randomUUID();
    res.cookie('bid', bid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2 // 2 года
    });
  }
  req.bid = bid;
  next();
});

function ownerFor(req, shared) {
  return shared ? '' : req.bid;
}

// ---- health check (удобно проверять что сервис жив) ----
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- KV API ----

app.post('/api/kv/get', async (req, res) => {
  try {
    const { key, shared } = req.body || {};
    const owner = ownerFor(req, !!shared);
    const r = await pool.query(
      'SELECT value FROM kv_store WHERE k=$1 AND shared=$2 AND owner=$3',
      [key, !!shared, owner]
    );
    if (r.rows.length === 0) return res.json({ result: null });
    res.json({ result: { key, value: r.rows[0].value, shared: !!shared } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/kv/set', async (req, res) => {
  try {
    const { key, value, shared } = req.body || {};
    const owner = ownerFor(req, !!shared);
    await pool.query(
      `INSERT INTO kv_store (k, shared, owner, value, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (k, shared, owner)
       DO UPDATE SET value=$4, updated_at=now()`,
      [key, !!shared, owner, value]
    );
    res.json({ result: { key, value, shared: !!shared } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/kv/delete', async (req, res) => {
  try {
    const { key, shared } = req.body || {};
    const owner = ownerFor(req, !!shared);
    await pool.query(
      'DELETE FROM kv_store WHERE k=$1 AND shared=$2 AND owner=$3',
      [key, !!shared, owner]
    );
    res.json({ result: { key, deleted: true, shared: !!shared } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/kv/list', async (req, res) => {
  try {
    const { prefix, shared } = req.body || {};
    const owner = ownerFor(req, !!shared);
    const r = await pool.query(
      'SELECT k FROM kv_store WHERE shared=$1 AND owner=$2 AND k LIKE $3',
      [!!shared, owner, (prefix || '') + '%']
    );
    res.json({ result: { keys: r.rows.map(row => row.k), prefix: prefix || '', shared: !!shared } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

// ---- AI Video Mentor (ключ Anthropic хранится только на сервере) ----
app.post('/api/mentor', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'no_message' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'no_api_key_configured' });
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: 'Ты AI Video Mentor — помощник по созданию видео с ИИ. Помогаешь писать промпты для Veo, Kling, Runway. Отвечаешь кратко, на русском.',
        messages: [{ role: 'user', content: message }]
      })
    });
    const data = await r.json();
    res.json({ answer: data.content?.[0]?.text || 'Не удалось получить ответ.' });
  } catch (e) {
    console.error('mentor error:', e);
    res.status(500).json({ error: 'mentor_error' });
  }
});

// SPA fallback — любой GET, не подошедший под статику и API, отдаёт index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));