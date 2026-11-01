// Saturn public profile rules (pure functions — no I/O). Storage and ownership live in lib/app.js + lib/deps.js.
// Public fields only: wallet, username, displayName, bio, avatar. Followers/following/P&L are NOT stored: they are not real server data.
import { ADDR_RE, b58dec } from './app.js';
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/, NAME_MAX = 24, BIO_MAX = 120, AVATAR_MAX = 32000, SEARCH_MIN = 2, SEARCH_MAX_Q = 64, SEARCH_LIMIT = 8;
const RESERVED = new Set(['saturn', 'admin', 'administrator', 'support', 'official', 'staff', 'team', 'root', 'system', 'moderator', 'mod', 'help', 'security', 'wallet', 'solana', 'null', 'undefined', 'api', 'www']);
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g; // control, zero-width, bidi override/isolate, BOM
export const isWallet = w => typeof w === 'string' && ADDR_RE.test(w) && b58dec(w)?.length === 32;
// ONE normalization for every username that is written or looked up: NFKC, trim, one leading "@", lowercase.
export const normalizeUsername = raw => typeof raw === 'string' ? raw.normalize('NFKC').trim().replace(/^@/, '').toLowerCase() : '';
export function usernameError(n) { if (!USERNAME_RE.test(n)) return 'Username must be 3–20 letters, numbers or underscores'; if (RESERVED.has(n)) return 'That username isn’t available'; return null; }
function text(raw, max) { if (raw == null) return { value: '' }; if (typeof raw !== 'string') return { error: 'must be text' };
  const v = raw.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim(); return [...v].length > max ? { error: 'too long (max ' + max + ')' } : { value: v }; }
// Avatar: a small JPEG data URL only (what the app's canvas produces). No URLs, SVG or PNG — nothing that can script, track, or point at an attacker's server.
function avatar(raw) { if (raw == null || raw === '') return { value: '' }; if (typeof raw !== 'string' || raw.length > AVATAR_MAX) return { error: 'photo is too large' };
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw), h = m && Buffer.from(m[1].slice(0, 8), 'base64'); return h && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff ? { value: raw } : { error: 'photo must be a JPEG' }; }
// -> { ok:true, value:{wallet,username,displayName,bio,avatar} } | { ok:false, error, field? }
export function validateProfileInput(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'Invalid request.' };
  if (!isWallet(b.wallet)) return { ok: false, error: 'Invalid wallet.', field: 'wallet' };
  let username = ''; if (b.username != null && b.username !== '') { if (typeof b.username !== 'string') return { ok: false, error: 'Invalid username.', field: 'username' };
    username = normalizeUsername(b.username); const e = usernameError(username); if (e) return { ok: false, error: e, field: 'username' }; }
  const n = text(b.displayName, NAME_MAX); if (n.error) return { ok: false, error: 'Display name ' + n.error, field: 'displayName' };
  const bio = text(b.bio, BIO_MAX); if (bio.error) return { ok: false, error: 'Bio ' + bio.error, field: 'bio' };
  const av = avatar(b.avatar); if (av.error) return { ok: false, error: 'Photo: ' + av.error, field: 'avatar' };
  return { ok: true, value: { wallet: b.wallet, username, displayName: n.value, bio: bio.value, avatar: av.value } };
}
export const publicProfile = p => p ? { wallet: p.wallet, username: p.username || '', displayName: p.displayName || '', avatar: p.avatar || '', bio: p.bio || '' } : null; // never uid / timestamps / search keys
// -> '' when the query is too short/long to search, else the normalized lowercase prefix
export function searchPrefix(raw) { const q = typeof raw === 'string' ? raw.trim() : ''; if (!q || q.length > SEARCH_MAX_Q) return ''; const n = q.normalize('NFKC').replace(/^@/, '').toLowerCase(); return [...n].length < SEARCH_MIN ? '' : n; }
// exact username first, then username prefix, then display-name prefix; stable and de-duplicated
export function rankProfiles(found, q, limit) { const seen = new Set(), rank = p => p.username === q ? 0 : (p.username || '').startsWith(q) ? 1 : 2;
  return found.filter(p => p && isWallet(p.wallet) && !seen.has(p.wallet) && seen.add(p.wallet)).sort((a, b) => rank(a) - rank(b) || (a.username || '~').localeCompare(b.username || '~') || a.wallet.localeCompare(b.wallet)).slice(0, limit).map(publicProfile); }
