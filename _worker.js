// MediaBatchSave - server kecil untuk Cloudflare Pages (mode "advanced", file _worker.js).
// Tugasnya: menyimpan kunci RapidAPI di server (tidak terlihat pengunjung), memanggil API
// downloader, merapikan hasilnya, dan meneruskan file agar tombol "Unduh" benar-benar
// mengunduh (browser tidak bisa mengunduh file lintas-domain secara langsung).
//
// Variabel lingkungan (Settings > Environment variables di Cloudflare Pages):
//   RAPIDAPI_KEY        wajib   kunci dari RapidAPI
//   RAPIDAPI_HOST       wajib   mis. "tiktok-download-without-watermark.p.rapidapi.com"
//   RAPIDAPI_PATH       opsional, default "/download"
//   RAPIDAPI_URL_PARAM  opsional, nama parameter link, default "url"

const PLATFORM_HOSTS = {
  TikTok: ['tiktok.com'],
  Instagram: ['instagram.com', 'instagr.am'],
  Facebook: ['facebook.com', 'fb.watch', 'fb.com'],
  YouTube: ['youtube.com', 'youtu.be'],
  Twitter: ['twitter.com', 'x.com'],
  Pinterest: ['pinterest.com', 'pin.it'],
  Threads: ['threads.net', 'threads.com'],
};

const IMG_EXT = /\.(jpe?g|png|webp|gif|heic|avif)(\?|#|$)/i;
const VID_EXT = /\.(mp4|mov|webm|m4v|mkv)(\?|#|$)/i;
const AUD_EXT = /\.(mp3|m4a|aac|wav|ogg)(\?|#|$)/i;

const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return health(env);
      if (url.pathname === '/api/download') return await handleDownload(url, env);
      if (url.pathname === '/api/file') return await handleFile(url, env);
    } catch (err) {
      return json({ error: 'server_error', message: 'Terjadi kesalahan di server. Coba lagi sebentar.' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function health(env) {
  return json({ ok: true, configured: Boolean(env.RAPIDAPI_KEY && env.RAPIDAPI_HOST) });
}

function detectPlatform(hostname) {
  const h = hostname.toLowerCase();
  for (const [name, hosts] of Object.entries(PLATFORM_HOSTS)) {
    if (hosts.some((d) => h === d || h.endsWith('.' + d))) return name;
  }
  return null;
}

// Link profil/akun (bukan satu postingan). API unduh biasa hanya menerima link postingan.
function isProfileLink(platform, u) {
  const segs = u.pathname.split('/').filter(Boolean);
  const first = segs[0] || '';
  switch (platform) {
    case 'TikTok':
      return first.startsWith('@') && !segs.includes('video') && !segs.includes('photo');
    case 'Instagram':
      return segs.length === 0 || (segs.length === 1 && !['p', 'reel', 'reels', 'tv', 'stories'].includes(first));
    case 'Threads':
      return first.startsWith('@') && !segs.includes('post');
    case 'YouTube':
      return first.startsWith('@') || ['channel', 'c', 'user'].includes(first);
    case 'Twitter':
      return segs.length === 1 && !['i', 'home', 'explore'].includes(first);
    default:
      return false;
  }
}

async function handleDownload(url, env) {
  if (!env.RAPIDAPI_KEY || !env.RAPIDAPI_HOST) {
    return json({
      error: 'not_configured',
      message: 'Server belum dihubungkan ke API. Pemilik situs perlu mengisi RAPIDAPI_KEY dan RAPIDAPI_HOST.',
    }, 503);
  }
  const target = (url.searchParams.get('url') || '').trim();
  let parsed;
  try {
    parsed = new URL(target);
    if (!/^https?:$/.test(parsed.protocol) || target.length > 2000) throw new Error('bad');
  } catch {
    return json({ error: 'bad_url', message: 'Link tidak valid. Tempel link lengkap yang diawali https://' }, 400);
  }
  const platform = detectPlatform(parsed.hostname);
  if (!platform) {
    return json({ error: 'unsupported', message: 'Platform belum didukung. Gunakan TikTok, Instagram, Facebook, YouTube Shorts, Twitter/X, Pinterest, atau Threads.' }, 400);
  }
  if (isProfileLink(platform, parsed)) {
    return json({
      error: 'profile_not_supported',
      message: 'Ini link profil. Tempel link satu postingan (video atau foto) langsung.',
    }, 422);
  }

  const api = new URL(`https://${env.RAPIDAPI_HOST}${env.RAPIDAPI_PATH || '/download'}`);
  api.searchParams.set(env.RAPIDAPI_URL_PARAM || 'url', parsed.href);

  let res;
  try {
    res = await fetch(api, {
      headers: {
        'x-rapidapi-key': env.RAPIDAPI_KEY,
        'x-rapidapi-host': env.RAPIDAPI_HOST,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    return json({ error: 'upstream_timeout', message: 'API tidak merespons. Coba lagi beberapa saat.' }, 504);
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* bukan JSON */ }

  if (!res.ok) {
    let message = (data && (data.message || data.error || data.msg)) || `API menolak permintaan (kode ${res.status}).`;
    if (res.status === 401 || res.status === 403) message = 'Kunci API ditolak. Periksa RAPIDAPI_KEY dan langganan API di RapidAPI.';
    if (res.status === 429) message = 'Kuota API habis atau terlalu banyak permintaan. Coba lagi nanti.';
    return json({ error: 'upstream_error', message: String(message).slice(0, 300) }, 502);
  }
  if (!data || typeof data !== 'object') {
    return json({ error: 'bad_response', message: 'Balasan API tidak bisa dibaca.' }, 502);
  }
  if (typeof data.code === 'number' && data.code !== 0 && data.code !== 200) {
    return json({ error: 'upstream_error', message: String(data.msg || data.message || 'Gagal memproses link. Pastikan postingan bersifat publik.').slice(0, 300) }, 422);
  }

  const result = normalize(data);
  if (!result.items.length) {
    return json({ error: 'no_media', message: 'Tidak ada video atau foto yang ditemukan. Pastikan postingan bersifat publik.' }, 422);
  }

  const secret = env.RAPIDAPI_KEY;
  const expires = Date.now() + 60 * 60 * 1000;
  const items = [];
  let n = 0;
  for (const it of result.items) {
    n += 1;
    const ext = guessExt(it);
    const name = `${platform}_${slug(result.title) || 'media'}_${n}.${ext}`;
    const sig = await hmac(secret, `${it.url}\n${name}\n${expires}`);
    const file = `/api/file?u=${encodeURIComponent(it.url)}&n=${encodeURIComponent(name)}&e=${expires}&s=${sig}`;
    items.push({
      type: it.type,
      quality: it.quality,
      watermark: it.watermark,
      ext,
      name,
      thumb: it.type === 'image' ? it.url : result.thumb,
      file,
    });
  }
  return json({ platform, title: result.title, author: result.author, items });
}

async function handleFile(url, env) {
  if (!env.RAPIDAPI_KEY) return json({ error: 'not_configured' }, 503);
  const target = url.searchParams.get('u') || '';
  const name = (url.searchParams.get('n') || 'media').replace(/[^\w.\-]+/g, '_').slice(0, 120);
  const expires = Number(url.searchParams.get('e') || 0);
  const sig = url.searchParams.get('s') || '';

  const expected = await hmac(env.RAPIDAPI_KEY, `${target}\n${url.searchParams.get('n')}\n${expires}`);
  if (!safeEqual(sig, expected)) return json({ error: 'forbidden', message: 'Tautan unduhan tidak valid.' }, 403);
  if (!expires || Date.now() > expires) return json({ error: 'expired', message: 'Tautan unduhan kedaluwarsa. Proses link sekali lagi.' }, 410);

  let src;
  try {
    src = new URL(target);
    if (src.protocol !== 'https:' && src.protocol !== 'http:') throw new Error('bad');
  } catch {
    return json({ error: 'bad_url' }, 400);
  }
  if (isPrivateHost(src.hostname)) return json({ error: 'forbidden' }, 403);

  let up;
  try {
    up = await fetch(src.href, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      redirect: 'follow',
    });
  } catch {
    return json({ error: 'upstream_error', message: 'Gagal mengambil file.' }, 502);
  }
  if (!up.ok || !up.body) return json({ error: 'upstream_error', message: `File tidak bisa diambil (kode ${up.status}).` }, 502);

  const headers = new Headers();
  headers.set('content-type', up.headers.get('content-type') || 'application/octet-stream');
  const len = up.headers.get('content-length');
  if (len) headers.set('content-length', len);
  headers.set('content-disposition', `attachment; filename="${name}"`);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(up.body, { status: 200, headers });
}

// ---------- merapikan balasan API ----------

function normalize(data) {
  const roots = [data, data.data, data.result, data.response, data.results].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  const pick = (keys) => {
    for (const r of roots) for (const k of keys) if (typeof r[k] === 'string' && r[k].trim()) return r[k].trim();
    return '';
  };
  const title = pick(['title', 'desc', 'caption', 'description', 'text', 'name']).slice(0, 200);

  let author = '';
  for (const r of roots) {
    const a = r.author || r.user || r.owner;
    if (typeof a === 'string') { author = a; break; }
    if (a && typeof a === 'object') {
      author = a.nickname || a.name || a.unique_id || a.username || '';
      if (author) break;
    }
  }

  let thumb = pick(['cover', 'thumbnail', 'thumb', 'origin_cover', 'poster', 'preview']);
  if (!/^https?:/i.test(thumb)) thumb = '';

  const items = [];
  const seen = new Set();

  const addUrl = (u, path, sib) => {
    const p = path.join('.').toLowerCase();
    const k = (path[path.length - 1] || '').toLowerCase();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    const hasMediaExt = IMG_EXT.test(u) || VID_EXT.test(u);
    if (/(cover|thumb|poster|preview|avatar|profile|icon|dynamic)/.test(k)) {
      if (!thumb && /(cover|thumb|poster|preview)/.test(k)) thumb = u;
      return;
    }
    if (/(music|audio|sound|avatar|author|user)/.test(p)) return;
    if (!hasMediaExt && /(share|web_?url|webpage|permalink|embed|original_url|source_url|page_url)/.test(k)) return;
    if (!hasMediaExt && !/(url|download|play|video|image|img|photo|pic|link|src|nowm|hd|sd|wm|media|file)/.test(k)) return;

    const sibType = String(sib.type || sib.media_type || sib.mediaType || '').toLowerCase();
    const ext = String(sib.extension || sib.ext || '').toLowerCase();
    if (sibType.includes('audio') || AUD_EXT.test(u) || ['mp3', 'm4a', 'aac'].includes(ext)) return;

    let type;
    if (VID_EXT.test(u) || sibType.includes('video') || ['mp4', 'mov', 'webm'].includes(ext)) type = 'video';
    else if (IMG_EXT.test(u) || sibType.includes('image') || sibType.includes('photo') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext) || /(image|img|photo|pic)/.test(p)) type = 'image';
    else type = 'video';

    const isWm = (/(^|[^a-z])(wm|watermark)|wmplay|with_?watermark/.test(k) && !/(no_?wm|nowm|without|no_?watermark)/.test(k)) ||
      sib.watermark === true ||
      (/watermark/i.test(String(sib.quality || sib.label || '')) && !/(no|without)/i.test(String(sib.quality || sib.label || '')));

    let quality = String(sib.quality || sib.resolution || sib.label || '').slice(0, 20);
    quality = quality.replace(/[_\- ]?(no[_\- ]?|without[_\- ]?)?water[_\- ]?mark/ig, '').replace(/[_\-]+/g, ' ').trim();
    if (/^hd$/i.test(quality)) quality = 'HD';
    if (!quality && /hd/.test(k)) quality = 'HD';

    seen.add(u);
    items.push({ type, url: u, quality, watermark: Boolean(isWm) });
  };

  const walk = (node, path, depth) => {
    if (depth > 6 || items.length >= 50) return;
    if (Array.isArray(node)) {
      node.forEach((el) => {
        if (typeof el === 'string') addUrl(el, path, {});
        else walk(el, path, depth + 1);
      });
      return;
    }
    if (!node || typeof node !== 'object') return;
    const direct = node.url || node.download_url || node.downloadUrl || node.link || node.src || node.video_url || node.image_url;
    if (typeof direct === 'string' && /^https?:\/\//i.test(direct)) {
      const key = node.url ? 'url' : node.download_url ? 'download_url' : node.downloadUrl ? 'downloadUrl' : node.link ? 'link' : node.src ? 'src' : node.video_url ? 'video_url' : 'image_url';
      addUrl(direct, path.concat(key), node);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') addUrl(v, path.concat(k), {});
      else if (v && typeof v === 'object') walk(v, path.concat(k), depth + 1);
    }
  };
  walk(data, [], 0);

  items.sort((a, b) => Number(a.watermark) - Number(b.watermark) || Number(/hd|1080|720/i.test(b.quality)) - Number(/hd|1080|720/i.test(a.quality)));
  return { title, author: String(author).slice(0, 80), thumb, items };
}

function guessExt(it) {
  const m = it.url.match(/\.(jpe?g|png|webp|gif|mp4|mov|webm|m4v)(\?|#|$)/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  return it.type === 'image' ? 'jpg' : 'mp4';
}

function slug(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// ---------- keamanan ----------

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function isPrivateHost(h) {
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (h.includes(':')) return true;
  return false;
}
