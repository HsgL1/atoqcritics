require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const SESSION_SECRET = (process.env.SESSION_SECRET || 'atoqcritics-dev-secret-change-me').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
const OPENCRITIC_API_KEY = (process.env.OPENCRITIC_API_KEY || process.env.RAPIDAPI_KEY || '').trim().replace(/^["']|["']$/g, '');
const RAWG_API_KEY = (process.env.RAWG_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const ADMIN_STEAM_IDS = new Set(
  (process.env.ADMIN_STEAM_IDS || '76561198211793707')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
function isAdminUser(user) {
  return Boolean(user && ADMIN_STEAM_IDS.has(String(user.steam_id)));
}

function getBaseUrl(req) {
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  const proto = isLocal ? 'http' : 'https';
  return `${proto}://${host}`;
}

// ==================== STEAM API HELPERS WITH RETRY & XML FALLBACK ====================
async function fetchWithRetry(url, attempts = 2) {
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'AToQcritics/2.3 (+https://store.steampowered.com)' }
      });
      lastStatus = r.status;
      if (r.ok) return { ok: true, status: r.status, response: r };
      if (r.status === 403 || r.status === 401) return { ok: false, status: r.status, response: r };
    } catch (err) {
      lastStatus = 0;
    }
    if (i < attempts - 1) await new Promise(res => setTimeout(res, 700));
  }
  return { ok: false, status: lastStatus, response: null };
}

async function fetchSteamProfile(steamId) {
  // 1. Try official Steam Web API GetPlayerSummaries
  if (STEAM_API_KEY) {
    const apiUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&steamids=${encodeURIComponent(steamId)}`;
    const res = await fetchWithRetry(apiUrl, 2);
    if (res.ok) {
      try {
        const data = await res.response.json();
        const p = data && data.response && data.response.players && data.response.players[0];
        if (p && p.personaname) {
          return {
            found: true,
            name: p.personaname,
            avatar: p.avatarfull || p.avatarmedium || p.avatar || '',
            profileUrl: p.profileurl || `https://steamcommunity.com/profiles/${steamId}`
          };
        }
      } catch (e) {
        console.warn('Steam summary JSON parse error:', e.message);
      }
    } else {
      console.warn('Steam GetPlayerSummaries failed with status:', res.status);
    }
  }

  // 2. Fallback to public Steam Community XML profile (works even if api.steampowered.com rate-limits)
  const xmlRes = await fetchWithRetry(`https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}/?xml=1`, 1);
  if (xmlRes.ok) {
    try {
      const xml = await xmlRes.response.text();
      const nameMatch = xml.match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/i) || xml.match(/<steamID>([^<]+)<\/steamID>/i);
      const avatarMatch = xml.match(/<avatarFull><!\[CDATA\[([\s\S]*?)\]\]><\/avatarFull>/i) || xml.match(/<avatarFull>([^<]+)<\/avatarFull>/i);
      if (nameMatch && nameMatch[1].trim()) {
        return {
          found: true,
          name: nameMatch[1].trim(),
          avatar: avatarMatch ? avatarMatch[1].trim() : '',
          profileUrl: `https://steamcommunity.com/profiles/${steamId}`
        };
      }
    } catch (e) {
      console.warn('Steam XML fallback parse error:', e.message);
    }
  }

  return { found: false };
}

async function fetchSteamAchievements(steamId, appId) {
  if (!STEAM_API_KEY || !steamId || !appId) return null;
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appId)}`;
    const res = await fetchWithRetry(url, 2);
    if (!res.ok) return null;
    const data = await res.response.json();
    const stats = data && data.playerstats;
    if (!stats || !stats.success || !Array.isArray(stats.achievements) || stats.achievements.length === 0) {
      return null;
    }
    const total = stats.achievements.length;
    const unlocked = stats.achievements.filter(a => Number(a.achieved) === 1).length;
    return { unlocked, total };
  } catch {
    return null;
  }
}

async function fetchSteamGameMetadata(appId) {
  if (!appId || appId <= 0) return { genres: [], userTags: [] };
  const genres = [];
  const userTags = [];
  const seenG = new Set();
  const seenT = new Set();

  // 1. Official Steam Russian Genres from appdetails
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&l=russian`;
    const res = await fetchWithRetry(url, 2);
    if (res.ok) {
      const data = await res.response.json();
      const entry = data && data[String(appId)];
      if (entry && entry.success && entry.data && Array.isArray(entry.data.genres)) {
        entry.data.genres.forEach(g => {
          const clean = String(g.description || '').trim();
          if (clean && !seenG.has(clean.toLowerCase())) {
            seenG.add(clean.toLowerCase());
            genres.push(clean);
          }
        });
      }
    }
  } catch {}

  // 2. Real Steam Community User Tags ("Метки": Похожа на Dark Souls, Открытый мир, Глубокий сюжет, etc.)
  try {
    const storeRes = await fetch(`https://store.steampowered.com/app/${encodeURIComponent(appId)}/?l=russian`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Cookie': 'birthtime=568022401; lastagecheckage=1-January-1988; wants_mature_content=1'
      }
    });
    if (storeRes.ok) {
      const html = await storeRes.text();
      const modalMatch = html.match(/InitAppTagModal\(\s*\d+\s*,\s*(\[[\s\S]*?\])\s*,/);
      if (modalMatch && modalMatch[1]) {
        try {
          const parsed = JSON.parse(modalMatch[1]);
          parsed.forEach(item => {
            const clean = String(item && item.name || '').trim();
            if (clean && !seenT.has(clean.toLowerCase()) && !seenG.has(clean.toLowerCase())) {
              seenT.add(clean.toLowerCase());
              userTags.push(clean);
            }
          });
        } catch {}
      }
      if (!userTags.length) {
        const tagRegex = /class="app_tag"[^>]*>([^<]+)<\/a>/gi;
        let m;
        while ((m = tagRegex.exec(html)) !== null) {
          const clean = String(m[1] || '').trim();
          if (clean && clean !== '+' && !seenT.has(clean.toLowerCase()) && !seenG.has(clean.toLowerCase())) {
            seenT.add(clean.toLowerCase());
            userTags.push(clean);
          }
        }
      }
    }
  } catch {}

  return { genres: genres.slice(0, 6), userTags: userTags.slice(0, 10) };
}

// ==================== SIGNED COOKIE AUTH ====================
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

// ==================== CLOUD POSTGRESQL ====================
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

    CREATE TABLE IF NOT EXISTS cached_libraries (
      steam_id TEXT PRIMARY KEY REFERENCES users(steam_id) ON DELETE CASCADE,
      games_json TEXT NOT NULL,
      updated_at BIGINT NOT NULL
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

    CREATE TABLE IF NOT EXISTS reactions (
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      user_steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      PRIMARY KEY (review_id, user_steam_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      recipient_steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
      actor_steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      review_id TEXT REFERENCES reviews(id) ON DELETE CASCADE,
      game_title TEXT,
      payload TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_tags (
      app_id INTEGER PRIMARY KEY,
      tags_json TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_game_meta (
      game_key TEXT PRIMARY KEY,
      genres_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_game_lists (
      id TEXT PRIMARY KEY,
      user_steam_id TEXT NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
      list_type TEXT NOT NULL,
      app_id INTEGER NOT NULL DEFAULT 0,
      game_title TEXT NOT NULL,
      game_img TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_external_ratings (
      game_key TEXT PRIMARY KEY,
      app_id INTEGER NOT NULL DEFAULT 0,
      game_title TEXT NOT NULL,
      mc_score INTEGER,
      mc_url TEXT,
      oc_score INTEGER,
      oc_tier TEXT,
      oc_url TEXT,
      manual_override BOOLEAN DEFAULT FALSE,
      updated_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ach_unlocked INTEGER;
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ach_total INTEGER;
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS no_narrative BOOLEAN DEFAULT FALSE;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_to_id TEXT;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_to_author TEXT;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_to_text TEXT;
    ALTER TABLE game_tags ADD COLUMN IF NOT EXISTS genres_json TEXT;
    ALTER TABLE game_tags ADD COLUMN IF NOT EXISTS user_tags_json TEXT;
    ALTER TABLE user_game_lists ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE custom_game_meta ADD COLUMN IF NOT EXISTS labels_json TEXT;
    ALTER TABLE game_external_ratings ADD COLUMN IF NOT EXISTS mc_version INTEGER DEFAULT 1;
  `);
  console.log('Облачная база PostgreSQL подключена и таблицы готовы.');
  // Backfill achievements for existing reviews in background
  backfillAchievements().catch(() => {});
  backfillGameTags().catch(() => {});
  backfillExternalRatings().catch(() => {});
}

async function backfillAchievements() {
  if (!STEAM_API_KEY) return;
  const { rows } = await pool.query('SELECT id, user_steam_id, app_id FROM reviews WHERE ach_total IS NULL LIMIT 50');
  for (const r of rows) {
    const ach = await fetchSteamAchievements(r.user_steam_id, r.app_id);
    if (ach) {
      await pool.query('UPDATE reviews SET ach_unlocked = $1, ach_total = $2 WHERE id = $3', [ach.unlocked, ach.total, r.id]);
    }
  }
}

async function ensureGameTags(appId) {
  if (!appId || appId <= 0) return { genres: [], userTags: [] };
  try {
    const existing = await pool.query('SELECT genres_json, user_tags_json FROM game_tags WHERE app_id = $1', [appId]);
    if (existing.rows[0] && existing.rows[0].user_tags_json !== null && existing.rows[0].genres_json !== null) {
      return {
        genres: JSON.parse(existing.rows[0].genres_json || '[]'),
        userTags: JSON.parse(existing.rows[0].user_tags_json || '[]')
      };
    }
    const meta = await fetchSteamGameMetadata(appId);
    if (meta.genres.length > 0 || meta.userTags.length > 0) {
      await pool.query(`
        INSERT INTO game_tags (app_id, tags_json, genres_json, user_tags_json, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (app_id) DO UPDATE SET
          tags_json = EXCLUDED.tags_json,
          genres_json = EXCLUDED.genres_json,
          user_tags_json = EXCLUDED.user_tags_json,
          updated_at = EXCLUDED.updated_at
      `, [appId, JSON.stringify(meta.genres), JSON.stringify(meta.genres), JSON.stringify(meta.userTags), Date.now()]);
    }
    return meta;
  } catch {
    return { genres: [], userTags: [] };
  }
}

async function backfillGameTags() {
  const { rows } = await pool.query(`
    SELECT DISTINCT r.app_id
    FROM reviews r
    LEFT JOIN game_tags gt ON gt.app_id = r.app_id
    WHERE r.app_id > 0 AND (gt.app_id IS NULL OR gt.user_tags_json IS NULL)
    LIMIT 120
  `);
  for (const row of rows) {
    await ensureGameTags(row.app_id);
    await new Promise(res => setTimeout(res, 450));
  }
}

function normalizeTitleForMatch(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9а-яё]+/gi, ' ')
    .trim();
}

function slugifyGameTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[™®©']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchJsonWithTimeout(url, headers = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function fetchMetacriticFromSteam(appId) {
  if (!appId || appId <= 0) return null;
  try {
    const r = await fetchWithRetry(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic,metacritic`, 2);
    if (!r.ok) return null;
    const data = await r.response.json();
    const entry = data && data[String(appId)];
    const mc = entry && entry.success && entry.data && entry.data.metacritic;
    if (mc && Number.isFinite(Number(mc.score)) && Number(mc.score) > 0) {
      return {
        score: Math.min(100, Math.max(0, Math.round(Number(mc.score)))),
        url: mc.url || null
      };
    }
  } catch {}
  return null;
}

function isTargetMcPlatform(entry) {
  const p = entry && entry.platform;
  const text = `${p?.slug || ''} ${p?.name || ''} ${entry?.url || ''}`.toLowerCase();
  return text.includes('pc')
    || text.includes('playstation')
    || /ps[1-5]/.test(text)
    || text.includes('xbox');
}

async function fetchMetacriticFromRawg(gameTitle) {
  if (!RAWG_API_KEY) return null;
  const cleanQuery = String(gameTitle || '').replace(/[™®©]/g, '').trim();
  if (cleanQuery.length < 2) return null;
  const url = `https://api.rawg.io/api/games?key=${encodeURIComponent(RAWG_API_KEY)}&search=${encodeURIComponent(cleanQuery)}&page_size=5`;
  const data = await fetchJsonWithTimeout(url, { 'User-Agent': 'AToQcritics/1.0' }, 5500);
  const results = data && Array.isArray(data.results) ? data.results : [];
  if (!results.length) return null;
  const normTarget = normalizeTitleForMatch(cleanQuery);
  let best = results.find(x => normalizeTitleForMatch(x.name) === normTarget && Number(x.metacritic) > 0);
  if (!best) best = results.find(x => Number(x.metacritic) > 0 && (normalizeTitleForMatch(x.name).includes(normTarget) || normTarget.includes(normalizeTitleForMatch(x.name))));
  if (!best) best = results.find(x => normalizeTitleForMatch(x.name) === normTarget);
  if (!best || !best.id) return null;

  // Fetch full game details to get per-platform Metacritic scores (PC + PlayStation + Xbox)
  const detail = await fetchJsonWithTimeout(
    `https://api.rawg.io/api/games/${best.id}?key=${encodeURIComponent(RAWG_API_KEY)}`,
    { 'User-Agent': 'AToQcritics/1.0' },
    5500
  );

  const mcPlatforms = Array.isArray(detail && detail.metacritic_platforms) ? detail.metacritic_platforms : [];
  const filteredScores = mcPlatforms
    .filter(isTargetMcPlatform)
    .map(x => Number(x.metascore))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 100);

  let finalScore = null;
  if (filteredScores.length > 0) {
    finalScore = Math.round(filteredScores.reduce((a, b) => a + b, 0) / filteredScores.length);
  } else {
    const fallbackAll = mcPlatforms
      .map(x => Number(x.metascore))
      .filter(n => Number.isFinite(n) && n > 0 && n <= 100);
    if (fallbackAll.length > 0) {
      finalScore = Math.round(fallbackAll.reduce((a, b) => a + b, 0) / fallbackAll.length);
    } else {
      const overall = Number((detail && detail.metacritic) || best.metacritic);
      if (Number.isFinite(overall) && overall > 0 && overall <= 100) {
        finalScore = Math.round(overall);
      }
    }
  }

  if (finalScore === null) return null;
  const slug = slugifyGameTitle((detail && detail.name) || best.name || cleanQuery);
  const mcUrl = (detail && detail.metacritic_url) || (slug ? `https://www.metacritic.com/game/${slug}/` : null);
  return {
    score: Math.min(100, Math.max(0, finalScore)),
    url: mcUrl
  };
}

async function fetchMetacriticFromWebJsonLd(gameTitle) {
  const cleanQuery = String(gameTitle || '').replace(/[™®©]/g, '').trim();
  const slug = slugifyGameTitle(cleanQuery);
  if (!slug || slug.length < 2) return null;
  const url = `https://www.metacritic.com/game/${slug}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const ldMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of ldMatches) {
      const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
      try {
        const obj = JSON.parse(inner);
        const ar = obj && obj.aggregateRating;
        const val = ar && Number(ar.ratingValue);
        if (Number.isFinite(val) && val > 0 && val <= 100) {
          return { score: Math.round(val), url };
        }
      } catch {}
    }
  } catch {
    clearTimeout(timer);
  }
  return null;
}

async function fetchMetacriticBest(appId, gameTitle) {
  // Primary: RAWG multi-platform arithmetic mean (PC + PlayStation + Xbox)
  const fromRawg = await fetchMetacriticFromRawg(gameTitle);
  if (fromRawg) return fromRawg;
  // Fallback: Steam PC Metacritic, then Metacritic JSON-LD
  const fromSteam = await fetchMetacriticFromSteam(appId);
  if (fromSteam) return fromSteam;
  return await fetchMetacriticFromWebJsonLd(gameTitle);
}

let openCriticRateLimitedUntil = 0;

async function fetchOpenCriticByTitle(gameTitle) {
  const cleanQuery = String(gameTitle || '').replace(/[™®©]/g, '').trim();
  if (cleanQuery.length < 2) return null;
  if (Date.now() < openCriticRateLimitedUntil) return null;

  const hosts = [];
  if (OPENCRITIC_API_KEY) {
    hosts.push({
      name: 'rapidapi',
      base: 'https://opencritic-api.p.rapidapi.com',
      headers: {
        'x-rapidapi-key': OPENCRITIC_API_KEY,
        'x-rapidapi-host': 'opencritic-api.p.rapidapi.com',
        'Accept': 'application/json'
      }
    });
  }
  hosts.push({
    name: 'direct',
    base: 'https://api.opencritic.com/api',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://opencritic.com/'
    }
  });

  const normTarget = normalizeTitleForMatch(cleanQuery);
  for (const h of hosts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    let results = null;
    try {
      const res = await fetch(`${h.base}/game/search?criteria=${encodeURIComponent(cleanQuery)}`, {
        signal: controller.signal,
        headers: h.headers
      });
      clearTimeout(timer);
      if (res.status === 429 && h.name === 'rapidapi') {
        console.warn('[OpenCritic] RapidAPI daily quota reached (429), pausing auto OC searches for 6h.');
        openCriticRateLimitedUntil = Date.now() + 6 * 60 * 60 * 1000;
        continue;
      }
      if (!res.ok) {
        if (h.name === 'rapidapi') console.warn(`[OpenCritic] RapidAPI search status ${res.status} for "${cleanQuery}"`);
        continue;
      }
      results = await res.json();
    } catch {
      clearTimeout(timer);
      continue;
    }
    if (!Array.isArray(results) || !results.length) continue;

    let best = results.find(x => normalizeTitleForMatch(x.name) === normTarget);
    if (!best) best = results.find(x => {
      const n = normalizeTitleForMatch(x.name);
      return n.includes(normTarget) || normTarget.includes(n);
    });
    if (!best && results[0] && (results[0].dist === undefined || Number(results[0].dist) <= 0.18)) {
      best = results[0];
    }
    if (!best || !best.id) continue;

    const detail = await fetchJsonWithTimeout(`${h.base}/game/${best.id}`, h.headers, 5500);
    const rawScore = Number(detail && detail.topCriticScore);
    if (!Number.isFinite(rawScore) || rawScore < 0) continue;
    const slug = slugifyGameTitle(detail.name || best.name || 'game') || 'game';
    return {
      score: Math.min(100, Math.max(0, Math.round(rawScore))),
      tier: detail.tier || null,
      url: `https://opencritic.com/game/${best.id}/${slug}`
    };
  }
  return null;
}

async function ensureExternalRatings(appId, gameTitle, force = false, opts = {}) {
  const numAppId = Number(appId) || 0;
  const cleanTitle = String(gameTitle || '').trim();
  if (numAppId <= 0 && !cleanTitle) return null;
  const gKey = numAppId > 0 ? `steam_${numAppId}` : `custom_${cleanTitle.toLowerCase()}`;
  const allowOc = opts.allowOc !== false;

  try {
    const existing = await pool.query('SELECT * FROM game_external_ratings WHERE game_key = $1', [gKey]);
    const row = existing.rows[0];
    const isUpToDateMc = row && Number(row.mc_version || 1) >= 2;
    const hasBoth = row && row.mc_score !== null && row.oc_score !== null && isUpToDateMc;
    const FRESH_MS = hasBoth ? (14 * 24 * 60 * 60 * 1000) : (6 * 60 * 60 * 1000);
    if (row && !force) {
      if (row.manual_override) return row;
      if (isUpToDateMc && (Date.now() - Number(row.updated_at || 0)) < FRESH_MS) return row;
    }

    const needMc = force || !row || row.mc_score === null || !isUpToDateMc;
    const needOc = allowOc && (force || !row || row.oc_score === null);
    const [mc, oc] = await Promise.all([
      needMc ? fetchMetacriticBest(numAppId, cleanTitle) : Promise.resolve(null),
      needOc ? fetchOpenCriticByTitle(cleanTitle) : Promise.resolve(null)
    ]);

    const finalMcScore = mc ? mc.score : (row ? row.mc_score : null);
    const finalMcUrl = mc ? mc.url : (row ? row.mc_url : null);
    const finalOcScore = oc ? oc.score : (row ? row.oc_score : null);
    const finalOcTier = oc ? oc.tier : (row ? row.oc_tier : null);
    const finalOcUrl = oc ? oc.url : (row ? row.oc_url : null);

    await pool.query(`
      INSERT INTO game_external_ratings (game_key, app_id, game_title, mc_score, mc_url, oc_score, oc_tier, oc_url, manual_override, mc_version, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, 2, $9)
      ON CONFLICT (game_key) DO UPDATE SET
        game_title = EXCLUDED.game_title,
        mc_score = EXCLUDED.mc_score,
        mc_url = EXCLUDED.mc_url,
        oc_score = EXCLUDED.oc_score,
        oc_tier = EXCLUDED.oc_tier,
        oc_url = EXCLUDED.oc_url,
        manual_override = FALSE,
        mc_version = 2,
        updated_at = EXCLUDED.updated_at
    `, [gKey, numAppId, cleanTitle, finalMcScore, finalMcUrl, finalOcScore, finalOcTier, finalOcUrl, Date.now()]);

    return {
      mcScore: finalMcScore,
      mcUrl: finalMcUrl,
      ocScore: finalOcScore,
      ocTier: finalOcTier,
      ocUrl: finalOcUrl
    };
  } catch (err) {
    console.error('[ExternalRatings] ensureExternalRatings error:', err.message);
    return null;
  }
}

async function backfillExternalRatings() {
  try {
    console.log(`[ExternalRatings] Backfill start (RAWG: ${RAWG_API_KEY ? 'ON' : 'OFF'}, OpenCritic: ${OPENCRITIC_API_KEY ? 'ON' : 'OFF'})`);
    const { rows } = await pool.query(`
      SELECT app_id, game_title, gkey, has_mc, has_oc
      FROM (
        SELECT DISTINCT ON (sub.gkey)
          sub.app_id,
          sub.game_title,
          sub.gkey,
          sub.latest_at,
          (er.mc_score IS NOT NULL AND COALESCE(er.mc_version, 1) >= 2) AS has_mc,
          (er.oc_score IS NOT NULL) AS has_oc
        FROM (
          SELECT r.app_id, r.game_title, r.created_at AS latest_at,
            CASE WHEN r.app_id > 0 THEN 'steam_' || r.app_id::text ELSE 'custom_' || LOWER(TRIM(r.game_title)) END AS gkey
          FROM reviews r
        ) sub
        LEFT JOIN game_external_ratings er ON er.game_key = sub.gkey
        WHERE er.game_key IS NULL OR (er.manual_override IS NOT TRUE AND (er.mc_score IS NULL OR COALESCE(er.mc_version, 1) < 2 OR er.oc_score IS NULL))
        ORDER BY sub.gkey, sub.latest_at DESC
      ) t
      ORDER BY latest_at DESC
      LIMIT 160
    `);
    console.log(`[ExternalRatings] Found ${rows.length} games needing MC/OC lookup.`);
    let ocCalls = 0;
    const MAX_OC_AUTO_CALLS = OPENCRITIC_API_KEY ? 22 : 12;
    for (const row of rows) {
      const wantOc = !row.has_oc && ocCalls < MAX_OC_AUTO_CALLS && Date.now() >= openCriticRateLimitedUntil;
      if (wantOc) ocCalls++;
      if (row.has_mc && !wantOc) continue;
      await ensureExternalRatings(row.app_id, row.game_title, false, { allowOc: wantOc });
      await new Promise(res => setTimeout(res, 550));
    }
    console.log(`[ExternalRatings] Backfill finished (OC lookups: ${ocCalls}).`);
  } catch (err) {
    console.error('[ExternalRatings] Backfill SQL/run error:', err.message);
  }
}

// ==================== EXPRESS APP ====================
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
      return res.redirect('/?auth_err=' + encodeURIComponent('Steam не подтвердил авторизацию. Попробуйте ещё раз.'));
    }

    const claimedId = String(query['openid.claimed_id'] || '');
    const match = claimedId.match(/\/openid\/id\/(\d+)$/);
    if (!match) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Не удалось получить SteamID из ответа Steam'));
    }
    const steamId = match[1];

    const prof = await fetchSteamProfile(steamId);
    const fallbackName = `Steam_${steamId.slice(-6)}`;
    const profileUrl = prof.found ? prof.profileUrl : `https://steamcommunity.com/profiles/${steamId}`;

    // Never overwrite an existing real Steam nickname/avatar with fallback Steam_xxxxxx!
    await pool.query(`
      INSERT INTO users (steam_id, name, avatar, profile_url, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (steam_id) DO UPDATE SET
        name = CASE WHEN $6 THEN EXCLUDED.name ELSE users.name END,
        avatar = CASE WHEN $6 AND EXCLUDED.avatar <> '' THEN EXCLUDED.avatar ELSE users.avatar END,
        profile_url = CASE WHEN $6 THEN EXCLUDED.profile_url ELSE users.profile_url END
    `, [
      steamId,
      prof.found ? prof.name : fallbackName,
      prof.found ? prof.avatar : '',
      profileUrl,
      Date.now(),
      prof.found
    ]);

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

app.get('/api/me', async (req, res) => {
  // Auto-heal fallback Steam_xxxxxx nickname or missing avatar automatically
  if (req.user && (/^Steam_\d+$/.test(req.user.name) || !req.user.avatar)) {
    try {
      const prof = await fetchSteamProfile(req.user.steam_id);
      if (prof.found) {
        const { rows } = await pool.query(
          `UPDATE users SET name = $1, avatar = CASE WHEN $2 <> '' THEN $2 ELSE avatar END, profile_url = $3 WHERE steam_id = $4 RETURNING *`,
          [prof.name, prof.avatar, prof.profileUrl, req.user.steam_id]
        );
        if (rows[0]) req.user = rows[0];
      }
    } catch (e) {
      console.warn('Auto-heal profile failed:', e.message);
    }
  }
  res.json({ user: req.user ? { ...req.user, isAdmin: isAdminUser(req.user) } : null });
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT steam_id, name, avatar, profile_url, created_at FROM users ORDER BY created_at DESC');
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

// ==================== REAL STEAM LIBRARY (WITH DB CACHE + RETRY) ====================
app.get('/api/steam/library', requireAuth, async (req, res) => {
  if (!STEAM_API_KEY) {
    return res.status(500).json({ error: 'STEAM_API_KEY не настроен на сервере' });
  }

  let cachedGames = [];
  try {
    const c = await pool.query('SELECT games_json FROM cached_libraries WHERE steam_id = $1', [req.user.steam_id]);
    if (c.rows[0]) cachedGames = JSON.parse(c.rows[0].games_json || '[]');
  } catch {}

  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(req.user.steam_id)}&include_appinfo=1&include_played_free_games=1`;
  const apiRes = await fetchWithRetry(url, 2);

  if (!apiRes.ok) {
    console.warn('GetOwnedGames failed with status:', apiRes.status);
    if (cachedGames.length > 0) {
      return res.json({ games: cachedGames, isPrivate: false, fromCache: true });
    }
    const reason = apiRes.status === 403
      ? 'Steam отклонил STEAM_API_KEY (ошибка 403). Проверьте ключ в настройках Render.'
      : apiRes.status === 429
        ? 'Steam временно ограничил запросы с IP хостинга (429). Нажмите «Обновить» через минуту.'
        : `Steam API временно недоступен (код ${apiRes.status || 'сети'}). Попробуйте обновить чуть позже.`;
    return res.json({ games: [], isPrivate: false, apiError: reason });
  }

  try {
    const data = await apiRes.response.json();
    const rawGames = (data && data.response && data.response.games) || [];
    const games = rawGames
      .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
      .map(g => ({
        appId: g.appid,
        title: g.name,
        hoursPlayed: Math.round(((g.playtime_forever || 0) / 60) * 10) / 10,
        img: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${g.appid}/header.jpg`
      }));

    if (games.length > 0) {
      await pool.query(`
        INSERT INTO cached_libraries (steam_id, games_json, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (steam_id) DO UPDATE SET games_json = EXCLUDED.games_json, updated_at = EXCLUDED.updated_at
      `, [req.user.steam_id, JSON.stringify(games), Date.now()]).catch(() => {});
      return res.json({ games, isPrivate: false });
    }

    if (cachedGames.length > 0) {
      return res.json({ games: cachedGames, isPrivate: false, fromCache: true });
    }

    return res.json({ games: [], isPrivate: true });
  } catch (err) {
    if (cachedGames.length > 0) {
      return res.json({ games: cachedGames, isPrivate: false, fromCache: true });
    }
    return res.json({ games: [], isPrivate: false, apiError: 'Ошибка чтения ответа Steam API.' });
  }
});

const coverUrlCache = new Map();

app.get('/api/steam/cover/:appId', async (req, res) => {
  const appId = Number(req.params.appId);
  if (!appId || appId <= 0) return res.status(404).end();
  if (coverUrlCache.has(appId)) {
    const cached = coverUrlCache.get(appId);
    return cached ? res.redirect(302, cached) : res.status(404).end();
  }
  try {
    const r = await fetchWithRetry(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`, 2);
    if (r.ok) {
      const data = await r.response.json();
      const entry = data && data[String(appId)];
      const headerImg = entry && entry.success && entry.data && (entry.data.header_image || entry.data.capsule_image);
      if (headerImg) {
        coverUrlCache.set(appId, headerImg);
        // Also heal saved reviews in DB so future loads are instant
        pool.query('UPDATE reviews SET game_img = $1 WHERE app_id = $2', [headerImg, appId]).catch(() => {});
        return res.redirect(302, headerImg);
      }
    }
  } catch {}
  coverUrlCache.set(appId, null);
  return res.status(404).end();
});

const posterUrlCache = new Map();

app.get('/api/steam/poster/:appId', async (req, res) => {
  const appId = Number(req.params.appId);
  if (!appId || appId <= 0) return res.status(404).end();
  if (posterUrlCache.has(appId)) {
    const cached = posterUrlCache.get(appId);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, cached);
    }
    return res.status(404).end();
  }
  try {
    const payload = {
      ids: [{ appid: appId }],
      context: { language: 'english', country_code: 'US', steam_realm: 1 },
      data_request: { include_assets: true, include_assets_without_overrides: true }
    };
    const apiUrl = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(payload))}`;
    const r = await fetchWithRetry(apiUrl, 2);
    if (r.ok) {
      const data = await r.response.json();
      const item = data && data.response && data.response.store_items && data.response.store_items[0];
      const assets = item && item.assets;
      if (assets) {
        const fmt = assets.asset_url_format || `steam/apps/${appId}/\${FILENAME}`;
        const fn = assets.library_capsule_2x || assets.library_capsule || assets.hero_capsule_2x || assets.hero_capsule;
        if (fn) {
          const posterUrl = 'https://shared.fastly.steamstatic.com/store_item_assets/' + fmt.replace('${FILENAME}', fn);
          posterUrlCache.set(appId, posterUrl);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.redirect(302, posterUrl);
        }
      }
      posterUrlCache.set(appId, null);
    }
  } catch {}
  return res.status(404).end();
});

const steamBrowseCache = new Map();

app.get('/api/steam/browse', requireAuth, async (req, res) => {
  const page = Math.max(1, Math.min(50, Number(req.query.page) || 1));
  const limit = Math.max(8, Math.min(25, Number(req.query.limit) || 16));
  const cacheKey = `v2:${page}:${limit}`;
  const cached = steamBrowseCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 5 * 60 * 1000) {
    return res.json(cached.data);
  }
  try {
    const start = (page - 1) * limit;
    let games = [];
    let totalPages = 50;

    // Primary: official Steam IStoreQueryService/Query/v1 (exact start/count pagination, zero bucketing)
    try {
      const qPayload = {
        query: {
          start,
          count: limit,
          sort: 10,
          filters: { type_filters: { include_games: true } }
        },
        context: { language: 'russian', country_code: 'KZ', steam_realm: 1 },
        data_request: { include_basic_info: true }
      };
      const apiUrl = `https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json=${encodeURIComponent(JSON.stringify(qPayload))}`;
      const r1 = await fetchWithRetry(apiUrl, 2);
      if (r1.ok) {
        const d1 = await r1.response.json();
        const storeItems = (d1 && d1.response && d1.response.store_items) || [];
        const seen = new Set();
        for (const it of storeItems) {
          const appId = Number(it.appid) || 0;
          if (!appId || seen.has(appId)) continue;
          seen.add(appId);
          games.push({
            appId,
            title: it.name || `Steam #${appId}`,
            img: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`
          });
        }
        const totalCnt = Number(d1?.response?.metadata?.total_matching_records) || 0;
        if (totalCnt > 0) totalPages = Math.min(50, Math.max(1, Math.ceil(totalCnt / limit)));
      }
    } catch {}

    // Fallback: Steam search/results using native page= parameter (strictly distinct 25-item pages)
    if (!games.length) {
      const fbUrl = `https://store.steampowered.com/search/results/?query&page=${page}&dynamic_data=&sort_by=_ASC&category1=998&l=russian&cc=KZ&json=1`;
      const r2 = await fetchWithRetry(fbUrl, 2);
      if (!r2.ok) return res.status(502).json({ error: 'Ошибка загрузки каталога Steam' });
      const d2 = await r2.response.json();
      const items = (d2 && d2.items) || [];
      const seen = new Set();
      for (const item of items) {
        const m = String(item.logo || '').match(/\/apps\/(\d+)\//);
        const appId = m ? Number(m[1]) : 0;
        if (!appId || seen.has(appId)) continue;
        seen.add(appId);
        games.push({
          appId,
          title: item.name || `Steam #${appId}`,
          img: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`
        });
      }
    }

    const payload = { games, page, totalPages };
    steamBrowseCache.set(cacheKey, { ts: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка соединения со Steam' });
  }
});

app.get('/api/steam/search', requireAuth, async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json({ games: [] });
  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=russian&cc=KZ`;
    const r = await fetchWithRetry(url, 2);
    if (!r.ok) return res.status(502).json({ error: 'Ошибка поиска по каталогу Steam' });
    const data = await r.response.json();
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
  const [revRes, voteRes, commRes, reactRes, customMetaRes, extRatingsRes] = await Promise.all([
    pool.query(`
      SELECT r.*, u.name AS author_name, u.avatar AS author_avatar, u.profile_url AS author_url, gt.tags_json AS game_tags_json, gt.genres_json AS game_genres_json, gt.user_tags_json AS game_user_tags_json
      FROM reviews r
      JOIN users u ON u.steam_id = r.user_steam_id
      LEFT JOIN game_tags gt ON gt.app_id = r.app_id
      ORDER BY r.created_at DESC
    `),
    pool.query('SELECT * FROM votes'),
    pool.query(`
      SELECT c.*, u.name AS author_name, u.avatar AS author_avatar
      FROM comments c
      JOIN users u ON u.steam_id = c.user_steam_id
      ORDER BY c.created_at ASC
    `),
    pool.query('SELECT * FROM reactions'),
    pool.query('SELECT * FROM custom_game_meta'),
    pool.query('SELECT * FROM game_external_ratings')
  ]);

  const extRatingsMap = {};
  extRatingsRes.rows.forEach(er => {
    extRatingsMap[er.game_key] = {
      mcScore: er.mc_score !== null && er.mc_score !== undefined ? Number(er.mc_score) : null,
      mcUrl: er.mc_url || null,
      ocScore: er.oc_score !== null && er.oc_score !== undefined ? Number(er.oc_score) : null,
      ocTier: er.oc_tier || null,
      ocUrl: er.oc_url || null
    };
  });

  const customMetaMap = {};
  customMetaRes.rows.forEach(cm => {
    try {
      customMetaMap[cm.game_key] = {
        genres: JSON.parse(cm.genres_json || '[]'),
        labels: JSON.parse(cm.labels_json || '[]'),
        tags: JSON.parse(cm.tags_json || '[]')
      };
    } catch {}
  });

  const mergeUnique = (a, b) => {
    const out = [];
    const seen = new Set();
    [...(a || []), ...(b || [])].forEach(item => {
      const clean = String(item || '').trim();
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        out.push(clean);
      }
    });
    return out;
  };

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
      replyToId: c.reply_to_id || null,
      replyToAuthor: c.reply_to_author || null,
      replyToText: c.reply_to_text || null,
      createdAt: Number(c.created_at)
    });
  });

  const reactionsMap = {};
  reactRes.rows.forEach(rx => {
    const bucket = (reactionsMap[rx.review_id] ||= {});
    (bucket[rx.emoji] ||= []).push(rx.user_steam_id);
  });

  return revRes.rows.map(r => {
    const gKey = r.app_id > 0 ? `steam_${r.app_id}` : `custom_${String(r.game_title || '').trim().toLowerCase()}`;
    const cMeta = customMetaMap[gKey] || { genres: [], tags: [] };
    const baseGenres = r.app_id > 0
      ? (r.game_genres_json ? JSON.parse(r.game_genres_json) : (r.game_tags_json ? JSON.parse(r.game_tags_json) : []))
      : ['Сторонняя игра'];
    const baseTags = r.app_id > 0
      ? (r.game_user_tags_json ? JSON.parse(r.game_user_tags_json) : [])
      : [];
    return {
    id: r.id,
    userId: r.user_steam_id,
    authorName: r.author_name,
    authorAvatar: r.author_avatar,
    appId: r.app_id,
    gameTitle: r.game_title,
    gameImg: r.game_img,
    gameGenres: mergeUnique(baseGenres, cMeta.genres),
    gameLabels: mergeUnique(baseTags, cMeta.labels),
    gameTags: mergeUnique([], cMeta.tags),
    customGenres: cMeta.genres,
    customLabels: cMeta.labels || [],
    customTags: cMeta.tags,
    externalRatings: extRatingsMap[gKey] || null,
    scores: {
      gameplay: r.gameplay,
      visuals: r.visuals,
      narrative: r.narrative,
      audio: r.audio,
      emotions: r.emotions
    },
    total: r.total,
    noNarrative: Boolean(r.no_narrative),
    hoursPlayed: r.hours_played,
    achUnlocked: r.ach_unlocked !== null && r.ach_unlocked !== undefined ? Number(r.ach_unlocked) : null,
    achTotal: r.ach_total !== null && r.ach_total !== undefined ? Number(r.ach_total) : null,
    text: r.text,
    createdAt: Number(r.created_at),
    likes: likesMap[r.id] || [],
    dislikes: dislikesMap[r.id] || [],
    comments: commentsMap[r.id] || [],
    reactions: reactionsMap[r.id] || {}
    };
  });
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
    const { appId, gameTitle, gameImg, scores, noNarrative, hoursPlayed, text } = req.body || {};
    if ((appId === undefined || appId === null || appId === '') || !gameTitle || !scores) {
      return res.status(400).json({ error: 'Заполните все обязательные поля обзора' });
    }
    const numAppId = Number(appId) || 0;
    const dupRes = numAppId > 0
      ? await pool.query('SELECT id FROM reviews WHERE user_steam_id = $1 AND app_id = $2 LIMIT 1', [req.user.steam_id, numAppId])
      : await pool.query('SELECT id FROM reviews WHERE user_steam_id = $1 AND app_id = 0 AND LOWER(TRIM(game_title)) = LOWER(TRIM($2)) LIMIT 1', [req.user.steam_id, String(gameTitle)]);
    if (dupRes.rows[0]) {
      return res.status(409).json({ error: 'Вы уже оценили эту игру. Отредактируйте существующий обзор.' });
    }

    const skipNar = Boolean(noNarrative);
    const maxScore = skipNar ? 25 : 20;
    const clamp = v => Math.min(maxScore, Math.max(0, Math.round(Number(v) || 0)));
    const g = clamp(scores.gameplay);
    const v = clamp(scores.visuals);
    const n = skipNar ? 0 : clamp(scores.narrative);
    const a = clamp(scores.audio);
    const e = clamp(scores.emotions);
    const total = g + v + n + a + e;
    const id = 'rev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    await pool.query(`
      INSERT INTO reviews (id, user_steam_id, app_id, game_title, game_img, gameplay, visuals, narrative, audio, emotions, total, no_narrative, hours_played, ach_unlocked, ach_total, text, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, NULL, $14, $15)
    `, [
      id,
      req.user.steam_id,
      numAppId,
      String(gameTitle).slice(0, 150),
      gameImg || (numAppId > 0 ? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${numAppId}/header.jpg` : ''),
      g, v, n, a, e, total,
      skipNar,
      hoursPlayed !== null && hoursPlayed !== '' && !Number.isNaN(Number(hoursPlayed)) ? Number(hoursPlayed) : null,
      String(text || '').trim().slice(0, 2000),
      Date.now()
    ]);

    // If the game was in user's 'want' or 'playing' list, remove it automatically once reviewed
    if (numAppId > 0) {
      await pool.query('DELETE FROM user_game_lists WHERE user_steam_id = $1 AND app_id = $2', [req.user.steam_id, numAppId]).catch(() => {});
    } else {
      await pool.query('DELETE FROM user_game_lists WHERE user_steam_id = $1 AND app_id = 0 AND LOWER(TRIM(game_title)) = LOWER(TRIM($2))', [req.user.steam_id, String(gameTitle)]).catch(() => {});
    }

    res.status(201).json({ id, reviews: await hydrateReviews() });

    // Fetch Steam achievements & Steam tags in background so review modal closes immediately!
    if (numAppId > 0) {
      const uid = req.user.steam_id;
      Promise.all([
        fetchSteamAchievements(uid, numAppId).then(ach => {
          if (ach) return pool.query('UPDATE reviews SET ach_unlocked = $1, ach_total = $2 WHERE id = $3', [ach.unlocked, ach.total, id]);
        }).catch(() => {}),
        ensureGameTags(numAppId).catch(() => {})
      ]).catch(() => {});
    }
    ensureExternalRatings(numAppId, String(gameTitle), false).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения обзора' });
  }
});

app.put('/api/reviews/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_steam_id, app_id FROM reviews WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Обзор не найден' });
    if (rows[0].user_steam_id !== req.user.steam_id) return res.status(403).json({ error: 'Нет прав' });

    const { scores, noNarrative, hoursPlayed, text } = req.body || {};
    if (!scores) {
      return res.status(400).json({ error: 'Заполните текст и оценки' });
    }
    const skipNar = Boolean(noNarrative);
    const maxScore = skipNar ? 25 : 20;
    const clamp = v => Math.min(maxScore, Math.max(0, Math.round(Number(v) || 0)));
    const g = clamp(scores.gameplay);
    const v = clamp(scores.visuals);
    const n = skipNar ? 0 : clamp(scores.narrative);
    const a = clamp(scores.audio);
    const e = clamp(scores.emotions);
    const total = g + v + n + a + e;
    const hrs = hoursPlayed !== null && hoursPlayed !== '' && !Number.isNaN(Number(hoursPlayed)) ? Number(hoursPlayed) : null;

    const ach = rows[0].app_id > 0 ? await fetchSteamAchievements(req.user.steam_id, rows[0].app_id) : null;

    await pool.query(`
      UPDATE reviews
      SET gameplay = $1, visuals = $2, narrative = $3, audio = $4, emotions = $5, total = $6, no_narrative = $7, hours_played = $8, text = $9,
          ach_unlocked = COALESCE($10, ach_unlocked), ach_total = COALESCE($11, ach_total)
      WHERE id = $12
    `, [g, v, n, a, e, total, skipNar, hrs, String(text || '').trim().slice(0, 2000), ach ? ach.unlocked : null, ach ? ach.total : null, req.params.id]);

    res.json({ ok: true, reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления обзора' });
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
    const revOwner = await pool.query('SELECT user_steam_id, game_title FROM reviews WHERE id = $1', [req.params.id]);
    if (!revOwner.rows[0]) return res.status(404).json({ error: 'Обзор не найден' });
    if (revOwner.rows[0].user_steam_id === req.user.steam_id) {
      return res.status(403).json({ error: 'Нельзя оценивать собственный обзор' });
    }
    const { rows } = await pool.query('SELECT vote FROM votes WHERE review_id = $1 AND user_steam_id = $2', [req.params.id, req.user.steam_id]);
    if (rows[0] && rows[0].vote === voteVal) {
      await pool.query('DELETE FROM votes WHERE review_id = $1 AND user_steam_id = $2', [req.params.id, req.user.steam_id]);
    } else {
      await pool.query(`
        INSERT INTO votes (review_id, user_steam_id, vote)
        VALUES ($1, $2, $3)
        ON CONFLICT (review_id, user_steam_id) DO UPDATE SET vote = EXCLUDED.vote
      `, [req.params.id, req.user.steam_id, voteVal]);
      await createNotification({
        recipientSteamId: revOwner.rows[0].user_steam_id,
        actorSteamId: req.user.steam_id,
        type: 'vote',
        reviewId: req.params.id,
        gameTitle: revOwner.rows[0].game_title,
        payload: voteVal === 1 ? '👍' : '👎'
      });
    }
    res.json({ reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка голосования' });
  }
});

const notifClients = new Map();

function pushRealtimeNotification(recipientSteamId, notifObj) {
  const set = notifClients.get(recipientSteamId);
  if (!set || set.size === 0) return;
  const msg = `data: ${JSON.stringify(notifObj)}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch {}
  }
}

async function createNotification({ recipientSteamId, actorSteamId, type, reviewId, gameTitle, payload }) {
  if (!recipientSteamId || !actorSteamId || recipientSteamId === actorSteamId) return;
  const id = 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const createdAt = Date.now();
  const cleanTitle = String(gameTitle || '').slice(0, 150);
  const cleanPayload = String(payload || '').slice(0, 180);
  try {
    await pool.query(`
      INSERT INTO notifications (id, recipient_steam_id, actor_steam_id, type, review_id, game_title, payload, is_read, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8)
    `, [id, recipientSteamId, actorSteamId, type, reviewId || null, cleanTitle, cleanPayload, createdAt]);

    const actorRes = await pool.query('SELECT name, avatar FROM users WHERE steam_id = $1', [actorSteamId]);
    const actor = actorRes.rows[0] || {};
    pushRealtimeNotification(recipientSteamId, {
      id,
      type,
      reviewId: reviewId || null,
      gameTitle: cleanTitle,
      payload: cleanPayload,
      isRead: false,
      createdAt,
      actorId: actorSteamId,
      actorName: actor.name || 'Пользователь',
      actorAvatar: actor.avatar || ''
    });
  } catch (err) {
    console.warn('Notification insert error:', err.message);
  }
}

const ALLOWED_EMOJIS = ['🔥', '❤️', '😂', '🤯', '💯', '👑', '🐐', '🗿', '💀', '🤡', '🤮', '💩', '😢', '⚡', '🎯', '🫡'];

app.post('/api/reviews/:id/react', requireAuth, async (req, res) => {
  try {
    const emoji = String((req.body && req.body.emoji) || '').trim();
    if (!ALLOWED_EMOJIS.includes(emoji)) {
      return res.status(400).json({ error: 'Неподдерживаемый эмодзи' });
    }
    const revOwner = await pool.query('SELECT user_steam_id, game_title FROM reviews WHERE id = $1', [req.params.id]);
    if (!revOwner.rows[0]) return res.status(404).json({ error: 'Обзор не найден' });
    if (revOwner.rows[0].user_steam_id === req.user.steam_id) {
      return res.status(403).json({ error: 'Нельзя ставить реакции на собственный обзор' });
    }
    const { rows } = await pool.query(
      'SELECT 1 FROM reactions WHERE review_id = $1 AND user_steam_id = $2 AND emoji = $3',
      [req.params.id, req.user.steam_id, emoji]
    );
    if (rows[0]) {
      await pool.query(
        'DELETE FROM reactions WHERE review_id = $1 AND user_steam_id = $2 AND emoji = $3',
        [req.params.id, req.user.steam_id, emoji]
      );
    } else {
      await pool.query(
        'INSERT INTO reactions (review_id, user_steam_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [req.params.id, req.user.steam_id, emoji]
      );
      await createNotification({
        recipientSteamId: revOwner.rows[0].user_steam_id,
        actorSteamId: req.user.steam_id,
        type: 'reaction',
        reviewId: req.params.id,
        gameTitle: revOwner.rows[0].game_title,
        payload: emoji
      });
    }
    res.json({ reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка реакции' });
  }
});

app.post('/api/reviews/:id/comments', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустой комментарий' });
    const id = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const replyToId = body.replyToId ? String(body.replyToId).slice(0, 80) : null;
    const replyToAuthor = body.replyToAuthor ? String(body.replyToAuthor).slice(0, 80) : null;
    const replyToText = body.replyToText ? String(body.replyToText).slice(0, 140) : null;

    await pool.query(`
      INSERT INTO comments (id, review_id, user_steam_id, text, reply_to_id, reply_to_author, reply_to_text, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, req.params.id, req.user.steam_id, text.slice(0, 800), replyToId, replyToAuthor, replyToText, Date.now()]);

    // Trigger real-time notifications for reply & review comment
    const revInfo = await pool.query('SELECT user_steam_id, game_title FROM reviews WHERE id = $1', [req.params.id]);
    const revRow = revInfo.rows[0];
    let parentAuthorId = null;

    if (replyToId || replyToAuthor) {
      if (replyToId) {
        const parentRes = await pool.query('SELECT user_steam_id FROM comments WHERE id = $1', [replyToId]);
        parentAuthorId = parentRes.rows[0] ? parentRes.rows[0].user_steam_id : null;
      }
      if (!parentAuthorId && replyToAuthor) {
        const byName = await pool.query('SELECT steam_id FROM users WHERE name = $1 LIMIT 1', [replyToAuthor]);
        parentAuthorId = byName.rows[0] ? byName.rows[0].steam_id : null;
      }
      if (parentAuthorId && parentAuthorId !== req.user.steam_id) {
        await createNotification({
          recipientSteamId: parentAuthorId,
          actorSteamId: req.user.steam_id,
          type: 'reply',
          reviewId: req.params.id,
          gameTitle: revRow ? revRow.game_title : '',
          payload: text.slice(0, 140)
        });
      }
    }

    if (revRow && revRow.user_steam_id !== req.user.steam_id && revRow.user_steam_id !== parentAuthorId) {
      await createNotification({
        recipientSteamId: revRow.user_steam_id,
        actorSteamId: req.user.steam_id,
        type: 'comment',
        reviewId: req.params.id,
        gameTitle: revRow.game_title,
        payload: text.slice(0, 140)
      });
    }

    res.status(201).json({ id, reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления комментария' });
  }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_steam_id FROM comments WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Комментарий не найден' });
    if (rows[0].user_steam_id !== req.user.steam_id) return res.status(403).json({ error: 'Нет прав на удаление' });
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ ok: true, reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления комментария' });
  }
});

app.get('/api/notifications/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  const sid = req.user.steam_id;
  let set = notifClients.get(sid);
  if (!set) {
    set = new Set();
    notifClients.set(sid, set);
  }
  set.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    set.delete(res);
    if (set.size === 0) notifClients.delete(sid);
  });
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT n.*, u.name AS actor_name, u.avatar AS actor_avatar
      FROM notifications n
      JOIN users u ON u.steam_id = n.actor_steam_id
      WHERE n.recipient_steam_id = $1
      ORDER BY n.created_at DESC
      LIMIT 40
    `, [req.user.steam_id]);
    const notifications = rows.map(n => ({
      id: n.id,
      type: n.type,
      reviewId: n.review_id,
      gameTitle: n.game_title,
      payload: n.payload,
      isRead: Boolean(n.is_read),
      createdAt: Number(n.created_at),
      actorId: n.actor_steam_id,
      actorName: n.actor_name,
      actorAvatar: n.actor_avatar
    }));
    const unreadCount = notifications.filter(n => !n.isRead).length;
    res.json({ notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки уведомлений' });
  }
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  try {
    const id = req.body && req.body.id ? String(req.body.id) : null;
    if (id) {
      await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND recipient_steam_id = $2', [id, req.user.steam_id]);
    } else {
      await pool.query('UPDATE notifications SET is_read = TRUE WHERE recipient_steam_id = $1 AND is_read = FALSE', [req.user.steam_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления уведомлений' });
  }
});

app.delete('/api/notifications', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications WHERE recipient_steam_id = $1', [req.user.steam_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка очистки уведомлений' });
  }
});

app.post('/api/games/meta', requireAuth, async (req, res) => {
  try {
    const { appId, gameTitle, genres, labels, tags, mcScore, ocScore, updateRatings } = req.body || {};
    const numAppId = Number(appId) || 0;
    const cleanTitle = String(gameTitle || '').trim();
    if (numAppId <= 0 && !cleanTitle) {
      return res.status(400).json({ error: 'Не указана игра' });
    }
    const gKey = numAppId > 0 ? `steam_${numAppId}` : `custom_${cleanTitle.toLowerCase()}`;
    const cleanList = (arr, limit) => {
      const out = [];
      const seen = new Set();
      (Array.isArray(arr) ? arr : []).forEach(v => {
        const t = String(v || '').trim().slice(0, 40);
        if (t && !seen.has(t.toLowerCase()) && out.length < limit) {
          seen.add(t.toLowerCase());
          out.push(t);
        }
      });
      return out;
    };
    const finalGenres = cleanList(genres, 8);
    const finalLabels = cleanList(labels, 15);
    const finalTags = cleanList(tags, 15);
    await pool.query(`
      INSERT INTO custom_game_meta (game_key, genres_json, labels_json, tags_json, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (game_key) DO UPDATE SET
        genres_json = EXCLUDED.genres_json,
        labels_json = EXCLUDED.labels_json,
        tags_json = EXCLUDED.tags_json,
        updated_at = EXCLUDED.updated_at
    `, [gKey, JSON.stringify(finalGenres), JSON.stringify(finalLabels), JSON.stringify(finalTags), Date.now()]);

    if (updateRatings && isAdminUser(req.user)) {
      const parseOptScore = v => {
        if (v === '' || v === null || v === undefined) return null;
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
      };
      const cleanMc = parseOptScore(mcScore);
      const cleanOc = parseOptScore(ocScore);
      await pool.query(`
        INSERT INTO game_external_ratings (game_key, app_id, game_title, mc_score, oc_score, manual_override, updated_at)
        VALUES ($1, $2, $3, $4, $5, TRUE, $6)
        ON CONFLICT (game_key) DO UPDATE SET
          mc_score = EXCLUDED.mc_score,
          oc_score = EXCLUDED.oc_score,
          manual_override = TRUE,
          updated_at = EXCLUDED.updated_at
      `, [gKey, numAppId, cleanTitle || gKey, cleanMc, cleanOc, Date.now()]);
    }

    res.json({ ok: true, reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения жанров и меток' });
  }
});

app.post('/api/games/ratings/refresh', requireAuth, async (req, res) => {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Доступно только администратору' });
  try {
    const { appId, gameTitle } = req.body || {};
    const numAppId = Number(appId) || 0;
    const cleanTitle = String(gameTitle || '').trim();
    if (numAppId <= 0 && !cleanTitle) return res.status(400).json({ error: 'Не указана игра' });
    const ratings = await ensureExternalRatings(numAppId, cleanTitle, true);
    res.json({ ok: true, ratings, reviews: await hydrateReviews() });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось обновить оценки критиков' });
  }
});

async function fetchAllLists() {
  const { rows } = await pool.query('SELECT * FROM user_game_lists ORDER BY sort_order ASC, created_at DESC');
  return rows.map(r => ({
    id: r.id,
    userId: r.user_steam_id,
    listType: r.list_type,
    appId: Number(r.app_id) || 0,
    gameTitle: r.game_title,
    gameImg: r.game_img || '',
    sortOrder: Number(r.sort_order) || 0,
    createdAt: Number(r.created_at)
  }));
}

app.get('/api/lists', requireAuth, async (req, res) => {
  try {
    res.json({ lists: await fetchAllLists() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки списков игр' });
  }
});

app.post('/api/lists', requireAuth, async (req, res) => {
  try {
    const { listType, appId, gameTitle, gameImg } = req.body || {};
    if (!['want', 'playing'].includes(listType) || !gameTitle) {
      return res.status(400).json({ error: 'Укажите игру и список' });
    }
    const numAppId = Number(appId) || 0;
    const cleanTitle = String(gameTitle).trim().slice(0, 150);
    const cleanImg = gameImg ? String(gameImg) : (numAppId > 0 ? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${numAppId}/header.jpg` : '');

    // Check if this game is already in user's lists — if so, move/update it cleanly instead of duplicating
    const existing = numAppId > 0
      ? await pool.query('SELECT id FROM user_game_lists WHERE user_steam_id = $1 AND app_id = $2 LIMIT 1', [req.user.steam_id, numAppId])
      : await pool.query('SELECT id FROM user_game_lists WHERE user_steam_id = $1 AND app_id = 0 AND LOWER(TRIM(game_title)) = LOWER(TRIM($2)) LIMIT 1', [req.user.steam_id, cleanTitle]);

    const minRes = await pool.query('SELECT COALESCE(MIN(sort_order), 1) AS min_ord FROM user_game_lists WHERE user_steam_id = $1 AND list_type = $2', [req.user.steam_id, listType]);
    const nextSortOrder = (Number(minRes.rows[0]?.min_ord) || 1) - 1;

    if (existing.rows[0]) {
      await pool.query('UPDATE user_game_lists SET list_type = $1, game_img = COALESCE(NULLIF($2, \'\'), game_img), sort_order = $3, created_at = $4 WHERE id = $5', [listType, cleanImg, nextSortOrder, Date.now(), existing.rows[0].id]);
      return res.json({ id: existing.rows[0].id, lists: await fetchAllLists() });
    }

    const id = 'lst_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    await pool.query(`
      INSERT INTO user_game_lists (id, user_steam_id, list_type, app_id, game_title, game_img, sort_order, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, req.user.steam_id, listType, numAppId, cleanTitle, cleanImg, nextSortOrder, Date.now()]);

    res.status(201).json({ id, lists: await fetchAllLists() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления игры в список' });
  }
});

app.put('/api/lists/reorder', requireAuth, async (req, res) => {
  try {
    const { listType, orderedIds } = req.body || {};
    if (!['want', 'playing'].includes(listType) || !Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'Неверные данные сортировки' });
    }
    const cleanIds = orderedIds.map(x => String(x || '').trim()).filter(Boolean).slice(0, 500);
    if (!cleanIds.length) return res.json({ ok: true });
    await pool.query(`
      UPDATE user_game_lists AS u
      SET sort_order = v.ord
      FROM (
        SELECT unnest($1::text[]) AS id, generate_series(0, array_length($1::text[], 1) - 1) AS ord
      ) AS v
      WHERE u.id = v.id AND u.user_steam_id = $2 AND u.list_type = $3
    `, [cleanIds, req.user.steam_id, listType]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Reorder lists error:', err);
    res.status(500).json({ error: 'Ошибка сохранения порядка игр' });
  }
});

app.patch('/api/lists/:id', requireAuth, async (req, res) => {
  try {
    const listType = req.body && req.body.listType;
    if (!['want', 'playing'].includes(listType)) return res.status(400).json({ error: 'Invalid listType' });
    const { rows } = await pool.query('SELECT user_steam_id FROM user_game_lists WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Запись не найдена' });
    if (rows[0].user_steam_id !== req.user.steam_id) return res.status(403).json({ error: 'Нет прав' });
    const minRes = await pool.query('SELECT COALESCE(MIN(sort_order), 1) AS min_ord FROM user_game_lists WHERE user_steam_id = $1 AND list_type = $2', [req.user.steam_id, listType]);
    const nextSortOrder = (Number(minRes.rows[0]?.min_ord) || 1) - 1;
    await pool.query('UPDATE user_game_lists SET list_type = $1, sort_order = $2, created_at = $3 WHERE id = $4', [listType, nextSortOrder, Date.now(), req.params.id]);
    res.json({ ok: true, lists: await fetchAllLists() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка перемещения игры' });
  }
});

app.delete('/api/lists/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_steam_id FROM user_game_lists WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Запись не найдена' });
    if (rows[0].user_steam_id !== req.user.steam_id) return res.status(403).json({ error: 'Нет прав' });
    await pool.query('DELETE FROM user_game_lists WHERE id = $1', [req.params.id]);
    res.json({ ok: true, lists: await fetchAllLists() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления игры из списка' });
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
