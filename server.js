require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const SESSION_SECRET = (process.env.SESSION_SECRET || 'atoqcritics-dev-secret-change-me').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');

function getBaseUrl(req) {
  let raw = (process.env.BASE_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (raw) {
    if (!/^https?:\/\//i.test(raw)) {
      raw = (raw.includes('localhost') || raw.includes('127.0.0.1') ? 'http://' : 'https://') + raw;
    }
    return raw;
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// ==================== SIGNED COOKIE AUTH (ZERO SESSION-STORE BUGS) ====================
const COOKIE_NAME = 'atoq_steam_sid';

function signSteamId(steamId) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(String(steamId)).digest('hex');
  return `${steamId}.${sig}`;
}

function verifyCookieValue(val) {
  if (!val || typeof val !== 'string' || !val.includes('.')) return null;
  const idx = val.lastIndexOf('.');
  const steamId = val.slice(0, idx);
  const sig = val.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(steamId).digest('hex');
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return null;
    return crypto.timingSafeEqual(a, b) ? steamId : null;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  });
  return out;
}

function setAuthCookie(req, res, steamId) {
  const isHttps = req.secure || (req.headers['x-forwarded-proto'] || '').includes('https') || Boolean(process.env.RENDER);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(signSteamId(steamId))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000'
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ==================== CLOUD POSTGRESQL (Supabase / Neon) ====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function initDb() {
  if (!DATABASE_URL) {
    console.warn('ВНИМАНИЕ: DATABASE_URL не задан!');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      steam_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      profile_url TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      user_steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
      app_id INTEGER NOT NULL,
      game_title TEXT NOT NULL,
      game_img TEXT,
      gameplay INTEGER NOT NULL,
      visuals INTEGER NOT NULL,
      narrative INTEGER NOT NULL,
      audio INTEGER NOT NULL,
      emotions INTEGER NOT NULL,
      total INTEGER NOT NULL,
      hours_played REAL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS votes (
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      user_steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
      vote INTEGER NOT NULL,
      PRIMARY KEY (review_id, user_steam_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      user_steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  console.log('Облачная база PostgreSQL подключена и таблицы готовы.');
}

// ==================== EXPRESS APP ====================
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Attach current user from signed cookie
app.use(async (req, res, next) => {
  const cookies = parseCookies(req);
  const steamId = verifyCookieValue(cookies[COOKIE_NAME]);
  if (steamId) {
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE steam_id = $1', [steamId]);
      req.user = rows[0] || null;
    } catch (err) {
      console.error('DB user lookup error:', err.message);
      req.user = null;
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Требуется авторизация через Steam' });
  }
  next();
}

// ==================== DIRECT STEAM OPENID 2.0 ====================
app.get('/auth/steam', (req, res) => {
  if (!STEAM_API_KEY) {
    return res.redirect('/?auth_err=' + encodeURIComponent('На сервере не указан STEAM_API_KEY'));
  }
  const baseUrl = getBaseUrl(req);
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${baseUrl}/auth/steam/return`,
    'openid.realm': `${baseUrl}/`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });
  console.log('Steam OpenID redirect -> return_to:', `${baseUrl}/auth/steam/return`);
  res.redirect(`https://steamcommunity.com/openid/login?${params.toString()}`);
});

app.get('/auth/steam/return', async (req, res) => {
  try {
    const query = req.query || {};
    if (query['openid.mode'] !== 'id_res') {
      return res.redirect('/?auth_err=' + encodeURIComponent('Вход через Steam был отменён'));
    }

    const verifyParams = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      verifyParams.append(k, String(v));
    }
    verifyParams.set('openid.mode', 'check_authentication');

    const verifyRes = await fetch('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyParams.toString()
    });
    const verifyText = await verifyRes.text();

    if (!verifyText.includes('is_valid:true')) {
      console.error('Steam OpenID verification failed:', verifyText);
      return res.redirect('/?auth_err=' + encodeURIComponent('Steam не подтвердил авторизацию. Попробуйте ещё раз.'));
    }

    const claimedId = String(query['openid.claimed_id'] || '');
    const match = claimedId.match(/\/openid\/id\/(\d+)$/);
    if (!match) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Не удалось получить SteamID из ответа Steam'));
    }
    const steamId = match[1];

    let name = `Steam_${steamId.slice(-6)}`;
    let avatar = '';
    let profileUrl = `https://steamcommunity.com/profiles/${steamId}`;

    try {
      const sumRes = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&steamids=${encodeURIComponent(steamId)}`);
      const sumData = await sumRes.json();
      const player = sumData && sumData.response && sumData.response.players && sumData.response.players[0];
      if (player) {
        name = player.personaname || name;
        avatar = player.avatarfull || player.avatarmedium || player.avatar || '';
        profileUrl = player.profileurl || profileUrl;
      }
    } catch (e) {
      console.warn('Could not fetch Steam player summary:', e.message);
    }

    await pool.query(`
      INSERT INTO users (steam_id, name, avatar, profile_url, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (steam_id) DO UPDATE SET
        name = EXCLUDED.name,
        avatar = EXCLUDED.avatar,
        profile_url = EXCLUDED.profile_url
    `, [steamId, name, avatar, profileUrl, Date.now()]);

    setAuthCookie(req, res, steamId);
    res.redirect('/');
  } catch (err) {
    console.error('Steam auth return error:', err);
    res.redirect('/?auth_err=' + encodeURIComponent('Ошибка сервера при входе: ' + (err.message || 'DB error')));
  }
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT steam_id, name, avatar, profile_url, created_at FROM users ORDER BY created_at DESC');
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

// ==================== REAL STEAM LIBRARY & FULL CATALOG SEARCH ====================
app.get('/api/steam/library', requireAuth, async (req, res) => {
  if (!STEAM_API_KEY) {
    return res.status(500).json({ error: 'STEAM_API_KEY не настроен на сервере' });
  }
  try {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(req.user.steam_id)}&include_appinfo=1&include_played_free_games=1`;
    const r = await fetch(url);
    const data = await r.json();
    const rawGames = (data && data.response && data.response.games) || [];
    const games = rawGames
      .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
      .map(g => ({
        appId: g.appid,
        title: g.name,
        hoursPlayed: Math.round(((g.playtime_forever || 0) / 60) * 10) / 10,
        img: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${g.appid}/header.jpg`
      }));
    res.json({ games, isPrivate: rawGames.length === 0 });
  } catch (err) {
    res.status(502).json({ error: 'Не удалось загрузить библиотеку Steam' });
  }
});

app.get('/api/steam/search', requireAuth, async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json({ games: [] });
  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=russian&cc=KZ`;
    const r = await fetch(url);
    const data = await r.json();
    const items = (data && data.items) || [];
    const games = items.map(item => ({
      appId: item.id,
      title: item.name,
      img: item.tiny_image || `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${item.id}/header.jpg`
    }));
    res.json({ games });
  } catch (err) {
    res.status(502).json({ error: 'Ошибка поиска по каталогу Steam' });
  }
});

// ==================== REVIEWS, VOTES & COMMENTS ====================
async function hydrateReviews() {
  const [revRes, voteRes, commRes] = await Promise.all([
    pool.query(`
      SELECT r.*, u.name AS author_name, u.avatar AS author_avatar, u.profile_url AS author_url
      FROM reviews r
      JOIN users u ON u.steam_id = r.user_steam_id
      ORDER BY r.created_at DESC
    `),
    pool.query('SELECT * FROM votes'),
    pool.query(`
      SELECT c.*, u.name AS author_name, u.avatar AS author_avatar
      FROM comments c
      JOIN users u ON u.steam_id = c.user_steam_id
      ORDER BY c.created_at ASC
    `)
  ]);

  const likesMap = {};
  const dislikesMap = {};
  voteRes.rows.forEach(v => {
    if (v.vote === 1) (likesMap[v.review_id] ||= []).push(v.user_steam_id);
    if (v.vote === -1) (dislikesMap[v.review_id] ||= []).push(v.user_steam_id);
  });

  const commentsMap = {};
  commRes.rows.forEach(c => {
    (commentsMap[c.review_id] ||= []).push({
      id: c.id,
      userId: c.user_steam_id,
      authorName: c.author_name,
      authorAvatar: c.author_avatar,
      text: c.text,
      createdAt: Number(c.created_at)
    });
  });

  return revRes.rows.map(r => ({
    id: r.id,
    userId: r.user_steam_id,
    authorName: r.author_name,
    authorAvatar: r.author_avatar,
    appId: r.app_id,
    gameTitle: r.game_title,
    gameImg: r.game_img,
    scores: {
      gameplay: r.gameplay,
      visuals: r.visuals,
      narrative: r.narrative,
      audio: r.audio,
      emotions: r.emotions
    },
    total: r.total,
    hoursPlayed: r.hours_played,
    text: r.text,
    createdAt: Number(r.created_at),
    likes: likesMap[r.id] || [],
    dislikes: dislikesMap[r.id] || [],
    comments: commentsMap[r.id] || []
  }));
}

app.get('/api/reviews', requireAuth, async (req, res) => {
  try {
    res.json({ reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки ленты' });
  }
});

app.post('/api/reviews', requireAuth, async (req, res) => {
  try {
    const { appId, gameTitle, gameImg, scores, hoursPlayed, text } = req.body || {};
    if (!appId || !gameTitle || !text || !scores) {
      return res.status(400).json({ error: 'Заполните все обязательные поля обзора' });
    }
    const clamp = v => Math.min(20, Math.max(0, Math.round(Number(v) || 0)));
    const g = clamp(scores.gameplay);
    const v = clamp(scores.visuals);
    const n = clamp(scores.narrative);
    const a = clamp(scores.audio);
    const e = clamp(scores.emotions);
    const total = g + v + n + a + e;
    const id = 'rev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    await pool.query(`
      INSERT INTO reviews (id, user_steam_id, app_id, game_title, game_img, gameplay, visuals, narrative, audio, emotions, total, hours_played, text, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      id,
      req.user.steam_id,
      Number(appId),
      String(gameTitle).slice(0, 150),
      gameImg || `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${Number(appId)}/header.jpg`,
      g, v, n, a, e, total,
      hoursPlayed !== null && hoursPlayed !== '' && !Number.isNaN(Number(hoursPlayed)) ? Number(hoursPlayed) : null,
      String(text).trim().slice(0, 2000),
      Date.now()
    ]);

    res.status(201).json({ id, reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения обзора' });
  }
});

app.delete('/api/reviews/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_steam_id FROM reviews WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Обзор не найден' });
    if (rows[0].user_steam_id !== req.user.steam_id) return res.status(403).json({ error: 'Нет прав' });
    await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
    res.json({ ok: true, reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления обзора' });
  }
});

app.post('/api/reviews/:id/vote', requireAuth, async (req, res) => {
  try {
    const voteVal = Number(req.body && req.body.vote);
    if (voteVal !== 1 && voteVal !== -1) return res.status(400).json({ error: 'Invalid vote' });
    const { rows } = await pool.query('SELECT vote FROM votes WHERE review_id = $1 AND user_steam_id = $2', [req.params.id, req.user.steam_id]);
    if (rows[0] && rows[0].vote === voteVal) {
      await pool.query('DELETE FROM votes WHERE review_id = $1 AND user_steam_id = $2', [req.params.id, req.user.steam_id]);
    } else {
      await pool.query(`
        INSERT INTO votes (review_id, user_steam_id, vote)
        VALUES ($1, $2, $3)
        ON CONFLICT (review_id, user_steam_id) DO UPDATE SET vote = EXCLUDED.vote
      `, [req.params.id, req.user.steam_id, voteVal]);
    }
    res.json({ reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка голосования' });
  }
});

app.post('/api/reviews/:id/comments', requireAuth, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустой комментарий' });
    const id = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await pool.query(`
      INSERT INTO comments (id, review_id, user_steam_id, text, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, req.params.id, req.user.steam_id, text.slice(0, 500), Date.now()]);
    res.status(201).json({ reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления комментария' });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`AToQcritics server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Не удалось инициализировать базу данных:', err);
    process.exit(1);
  });
