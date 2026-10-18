/**
 * Two-step login codes (TOTP, RFC 6238): 6 digits that change every 30 seconds, as shown by
 * Google Authenticator, Microsoft Authenticator and similar apps. Uses only node:crypto.
 * Also builds the setup link and its QR code (an SVG drawn with pdfmake's built-in QR encoder), and
 * encrypts the saved keys with TWO_STEP_KEY (AES-256-GCM) so database rows and backups do not hold them.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import qrModule from 'pdfmake/js/qrEnc.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

/** RFC 4648 base32, the format authenticator apps expect for the setup key. */
export function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let text = '';
  for (let index = 0; index < bits.length; index += 5)
    text += ALPHABET[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  return text;
}

function base32Decode(text) {
  let bits = '';
  for (const character of text.replace(/=+$/, '').toUpperCase()) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) throw new Error('Invalid base32 key.');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

/** A new random 160-bit key, base32 encoded. */
export const newTwoStepSecret = () => base32Encode(randomBytes(20));

/** The 6-digit code for one 30-second step (RFC 4226 dynamic truncation, HMAC-SHA1). */
export function twoStepCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Returns the step a code belongs to (one step of clock drift allowed either way), or null when
 * the code is wrong or its step is not later than `lastStep` (a code is accepted only once).
 */
export function verifyTwoStepCode(secret, code, nowMs, lastStep = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / STEP_MS);
  for (const step of [current - 1, current, current + 1])
    if (step > lastStep && twoStepCode(secret, step) === code) return step;
  return null;
}

/** otpauth:// link that authenticator apps open or scan. */
export function twoStepSetupUrl(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

// shortcut: uses pdfmake's internal QR module (no public API); the two-step unit test fails if an upgrade moves it.
const qr = qrModule.measure ? qrModule : qrModule.default;

/** QR code of `text` as a standalone SVG (black modules on white, 4-module quiet zone). */
export function qrSvg(text) {
  const node = qr.measure({ qr: text, eccLevel: 'M' });
  const [background, ...modules] = node._canvas;
  const quiet = (modules[0]?.w ?? 5) * 4;
  const size = background.w + quiet * 2;
  const path = modules
    .map((rect) => `M${rect.x + quiet} ${rect.y + quiet}h${rect.w}v${rect.h}h-${rect.w}z`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// Development and test databases only: production refuses to start without its own TWO_STEP_KEY.
const DEVELOPMENT_KEY = createHash('sha256').update('venturecore-development-two-step-key').digest();
const KEY_FORMAT = /^[0-9a-f]{64}$/i;

/** Returns { seal(secret), open(stored) }: AES-256-GCM with TWO_STEP_KEY (64 hex characters). */
export function createTwoStepVault(environment, production) {
  const configured = environment.TWO_STEP_KEY?.trim();
  if (configured ? !KEY_FORMAT.test(configured) : production)
    throw new Error('Set TWO_STEP_KEY to 64 hexadecimal characters (for example: openssl rand -hex 32).');
  const key = configured ? Buffer.from(configured, 'hex') : DEVELOPMENT_KEY;
  return {
    seal(secret) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), data]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join(':');
    },
    // null when the value cannot be decrypted, for example after TWO_STEP_KEY was changed.
    open(stored) {
      const [version, iv, tag, data] = String(stored ?? '').split(':');
      if (version !== 'v1' || !iv || !tag || !data) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString(
          'utf8',
        );
      } catch {
        return null;
      }
    },
  };
}
