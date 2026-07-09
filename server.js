require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const app = express();
app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!process.env.SESSION_SECRET) {
  console.warn('ВНИМАНИЕ: SESSION_SECRET не задан!');
}

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
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

// ВАЖНО: webhook роут должен получать RAW body — регистрируем ДО express.json()
app.post('/api/payment/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const body = req.body.toString();
    let data;
    try { data = JSON.parse(body); } catch { return res.sendStatus(400); }

    // Проверяем подпись от LavaPay
    const expectedSign = crypto
      .createHmac('sha256', process.env.LAVA_API_KEY || '')
      .update(body)
      .digest('hex');

    const receivedSign = req.headers['x-signature'] || req.headers['signature'] || '';

    if (expectedSign !== receivedSign) {
      console.warn('LavaPay webhook: неверная подпись!', { expectedSign, receivedSign });
      // В тестовом режиме можно закомментировать строку ниже:
      return res.sendStatus(403);
    }

    console.log('LavaPay webhook получен:', JSON.stringify(data));

    // Обрабатываем только успешные оплаты
    if (data.status !== 'success') {
      console.log('Статус не success, пропускаем:', data.status);
      return res.sendStatus(200);
    }

    // orderId формат: "email_plan_timestamp", например "user@mail.com_premium_1717000000000"
    const orderId = data.orderId || data.order_id || '';
    const parts = orderId.split('_');
    if (parts.length < 3) {
      console.error('Неверный формат orderId:', orderId);
      return res.sendStatus(200);
    }

    const plan = parts[parts.length - 2];       // "basic" или "premium"
    const email = parts.slice(0, parts.length - 2).join('_'); // всё до плана

    if (!['basic', 'premium'].includes(plan)) {
      console.error('Неизвестный план:', plan);
      return res.sendStatus(200);
    }

    // Достаём пользователя из KV (Postgres)
    const kvGet = await pool.query(
      'SELECT value FROM kv_store WHERE k=$1 AND shared=$2 AND owner=$3',
      [`user:${email.toLowerCase()}`, true, '']
    );

    if (kvGet.rows.length === 0) {
      console.error('Пользователь не найден в KV:', email);
      return res.sendStatus(200);
    }

    const user = JSON.parse(kvGet.rows[0].value);
    user.plan = plan;
    user.paidAt = Date.now();
    user.paymentId = data.id || data.invoice_id || null;

    // Реферальная комиссия: если юзер пришёл по рефке — начисляем 30% рефереру
    if (user.referredBy && !user.refCommissionPaid) {
      const prices = { basic: 990, premium: 1990 };
      const commission = Math.round((prices[plan] || 0) * 0.3);
      const refGet = await pool.query(
        `SELECT value FROM kv_store WHERE k LIKE 'user:%' AND shared=true AND owner='' AND value LIKE $1`,
        [`%"refCode":"${user.referredBy}"%`]
      );
      if (refGet.rows.length > 0) {
        const referrer = JSON.parse(refGet.rows[0].value);
        const refEmail = referrer.email;
        referrer.balance = (referrer.balance || 0) + commission;
        await pool.query(
          `INSERT INTO kv_store (k, shared, owner, value, updated_at) VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (k, shared, owner) DO UPDATE SET value=$4, updated_at=now()`,
          [`user:${refEmail.toLowerCase()}`, true, '', JSON.stringify(referrer)]
        );
        console.log(`Реферальная комиссия ${commission}₽ начислена рефереру ${refEmail}`);
      }
      user.refCommissionPaid = true;
    }

    // Сохраняем обновлённого пользователя
    await pool.query(
      `INSERT INTO kv_store (k, shared, owner, value, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (k, shared, owner) DO UPDATE SET value=$4, updated_at=now()`,
      [`user:${email.toLowerCase()}`, true, '', JSON.stringify(user)]
    );

    console.log(`✅ Доступ "${plan}" выдан пользователю ${email}`);
    res.sendStatus(200);

  } catch (e) {
    console.error('Ошибка обработки webhook:', e);
    res.sendStatus(500);
  }
});

// Теперь подключаем json-парсер для всех остальных роутов
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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

app.use((req, res, next) => {
  let bid = req.cookies.bid;
  if (!bid) {
    bid = crypto.randomUUID();
    res.cookie('bid', bid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2
    });
  }
  req.bid = bid;
  next();
});

function ownerFor(req, shared) {
  return shared ? '' : req.bid;
}

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

// ---- Создание счёта LavaPay ----
app.post('/api/payment/create', async (req, res) => {
  try {
    const { email, plan } = req.body || {};
    const prices = { basic: 990, premium: 1990 };
    const amount = prices[plan];

    if (!amount || !email) {
      return res.status(400).json({ error: 'Укажите email и план' });
    }
    if (!process.env.LAVA_API_KEY || !process.env.LAVA_SHOP_ID) {
      return res.status(500).json({ error: 'Платёжная система не настроена' });
    }

    // orderId: "email_plan_timestamp" — по нему в webhook достанем кому выдать доступ
    const orderId = `${email}_${plan}_${Date.now()}`;
    const host = process.env.SITE_URL || `https://${req.headers.host}`;

    const body = {
      sum: amount,
      shopId: process.env.LAVA_SHOP_ID,
      orderId: orderId,
      hookUrl: `${host}/api/payment/webhook`,
      successUrl: `${host}/api/payment/success?order=${encodeURIComponent(orderId)}`,
      failUrl: host,
      comment: `Нейровидео — тариф «${plan === 'premium' ? 'С поддержкой' : 'Самостоятельно'}»`,
      currency: 'RUB',
    };

    const response = await fetch('https://api.lava.ru/business/invoice/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.LAVA_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    console.log('LavaPay create response:', JSON.stringify(data));

    if (data.data?.url) {
      res.json({ url: data.data.url });
    } else {
      res.status(500).json({ error: data.error || 'Не удалось создать счёт', raw: data });
    }
  } catch (e) {
    console.error('payment create error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Редирект после успешной оплаты ----
app.get('/api/payment/success', (req, res) => {
  // Редирект на фронт с флагом — JS покажет toast и обновит данные юзера
  res.redirect('/?paid=1');
});

// ---- AI Video Mentor ----
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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));