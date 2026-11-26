import { timingSafeEqual } from 'node:crypto';

const utf8 = new TextEncoder();
const maxIterations = 100000;

function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64(text) {
    return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

function decodeBase64Url(text) {
    const bytes = decodeBase64(text);
    if (base64Url(bytes) !== text) throw new Error('Invalid base64url encoding');
    return bytes;
}

export function randomBase64Url(bytes = 32) {
    return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', utf8.encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a, b) {
    const left = typeof a === 'string' ? utf8.encode(a) : a;
    const right = typeof b === 'string' ? utf8.encode(b) : b;
    const length = Math.max(left.length, right.length);
    // The terminator distinguishes trailing zero bytes while keeping comparison widths equal.
    const padded = bytes => {
        const result = new Uint8Array(length + 1);
        result.set(bytes);
        result[bytes.length] = 1;
        return result;
    };
    return timingSafeEqual(padded(left), padded(right));
}

function validIterations(iterations) {
    return Number.isInteger(iterations) && iterations >= 1 && iterations <= maxIterations;
}

async function derivePassword(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
    return new Uint8Array(bits);
}

export async function hashPassword(password, { iterations = maxIterations } = {}) {
    if (typeof password !== 'string' || !password.length) throw new Error('Password must be a non-empty string');
    if (!validIterations(iterations)) throw new Error('Iterations must be an integer from 1 to 100000');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derived = await derivePassword(password, salt, iterations);
    return ['pbkdf2_sha256', iterations, base64Url(salt), base64Url(derived)].join('$');
}

export async function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || !password.length || typeof storedHash !== 'string') return false;
    const match = /^pbkdf2_sha256\$([1-9]\d{0,5})\$([\w-]{22})\$([\w-]{43})$/.exec(storedHash);
    if (!match || !validIterations(Number(match[1]))) return false;
    try {
        const salt = decodeBase64Url(match[2]);
        const expected = decodeBase64Url(match[3]);
        return constantTimeEqual(await derivePassword(password, salt, Number(match[1])), expected);
    } catch {
        return false;
    }
}

export function createFieldCipher(rawKey) {
    if (!rawKey) {
        const identity = async value => value;
        return { enabled: false, encrypt: identity, decrypt: identity };
    }

    let bytes;
    try {
        bytes = /^[\da-f]{64}$/i.test(rawKey)
            ? Uint8Array.from(rawKey.match(/../g), pair => parseInt(pair, 16))
            : decodeBase64(rawKey);
    } catch {
        throw new Error('Encryption key must encode 32 bytes as hex, base64 or base64url');
    }
    if (bytes.length !== 32) throw new Error('Encryption key must contain 32 bytes');
    const key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const params = (iv, aad) => ({ name: 'AES-GCM', iv, ...(aad && { additionalData: utf8.encode(aad) }) });
    return {
        enabled: true,
        async encrypt(plaintext, aad = '') {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const sealed = await crypto.subtle.encrypt(params(iv, aad), await key, utf8.encode(plaintext));
            return ['enc', 'v1', base64Url(iv), base64Url(new Uint8Array(sealed))].join(':');
        },
        async decrypt(value, aad = '') {
            if (!value.startsWith('enc:v1:')) return value;
            const parts = value.split(':');
            if (parts.length !== 4) throw new Error('Invalid encrypted field');
            const opened = await crypto.subtle.decrypt(params(decodeBase64Url(parts[2]), aad), await key, decodeBase64Url(parts[3]));
            return new TextDecoder().decode(opened);
        }
    };
}
