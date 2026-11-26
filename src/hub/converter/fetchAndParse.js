import yaml from 'js-yaml';
import { ProxyParser } from '../../parsers/ProxyParser.js';
import { convertYamlProxyToObject } from '../../parsers/convertYamlProxyToObject.js';
import { parseSingboxJson, parseSurgeIni } from '../../parsers/subscription/subscriptionContentParser.js';
import { InvalidPayloadError } from '../../services/errors.js';
import { decodeBase64 } from '../../utils.js';

const BLOCKED_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 9200, 2375, 2379]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const URI_SCHEMES = new Set(['ss', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'anytls']);
const SURGE_TYPES = new Set(['ss', 'shadowsocks', 'vmess', 'trojan', 'tuic', 'hysteria2', 'hy2']);
const SINGBOX_NON_PROXY_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);
const INPUT_FORMATS = new Set(['auto', 'yaml', 'base64', 'uri', 'json', 'surge']);
const URI_SCHEME = /^([a-z][a-z\d+.-]*):\/\//i;

function validateUrl(rawUrl, base) {
    let url;
    try {
        url = new URL(rawUrl, base);
    } catch {
        throw new InvalidPayloadError('Invalid upstream URL');
    }
    if (url.protocol !== 'https:') throw new InvalidPayloadError('Upstream URL must use HTTPS');
    if (url.username || url.password) throw new InvalidPayloadError('Upstream URL must omit userinfo');

    const port = Number(url.port || 443);
    if ((port < 1024 && port !== 443) || BLOCKED_PORTS.has(port)) {
        throw new InvalidPayloadError('Upstream URL uses a restricted port');
    }

    const hostname = url.hostname.replace(/\.$/, '');
    const ipv6 = hostname.startsWith('[');
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    let blocked;
    if (ipv6) {
        const address = hostname.slice(1, -1);
        blocked = /^(?:::1?$|::ffff:|f[cd][\da-f]{2}:|fe[89ab][\da-f]:|ff[\da-f]{2}:)/.test(address);
    } else if (ipv4) {
        const [first, second] = hostname.split('.').map(Number);
        blocked = first === 0 || first === 10 || first === 127 || first >= 224 ||
            (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) ||
            (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127);

        // URL canonicalizes alternate IPv4 spellings, so check the original authority too.
        const relative = String(rawUrl).trim().replace(/[\t\n\r]/g, '').replace(/\\/g, '/')
            .replace(/^[a-z][a-z\d+.-]*:/i, '');
        if (!base || relative.startsWith('//')) {
            const authority = relative.replace(/^\/+/, '').split(/[/?#]/, 1)[0];
            blocked ||= authority.split('@').pop().split(':', 1)[0] !== hostname;
        }
    } else {
        blocked = !hostname.includes('.') || /\.(?:localhost|local|internal|arpa)$/.test(hostname);
    }
    if (blocked) throw new InvalidPayloadError('Upstream URL uses a restricted host');
    return url;
}

export function validateUpstreamUrl(rawUrl) {
    return validateUrl(rawUrl);
}

async function readResponseText(response, { maxBytes, controller, hostname }) {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > maxBytes) {
        controller.abort();
        throw new InvalidPayloadError('Upstream subscription exceeds the byte limit');
    }
    if (!response.body) return '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let received = 0;
    try {
        while (true) {
            let chunk;
            try {
                chunk = await reader.read();
            } catch {
                throw new Error('Failed to read upstream subscription from ' + hostname);
            }
            if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > maxBytes) {
                controller.abort();
                void reader.cancel().catch(() => {});
                throw new InvalidPayloadError('Upstream subscription exceeds the byte limit');
            }
            chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        return chunks.join('');
    } finally {
        reader.releaseLock();
    }
}

export async function safeFetchSubscription(url, {
    userAgent = 'clash.meta',
    timeoutMs = 15000,
    maxBytes = 4 * 1024 * 1024,
    maxRedirects = 5,
    fetchImpl = fetch
} = {}) {
    let currentUrl = validateUpstreamUrl(url);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error('Upstream subscription timed out for ' + currentUrl.hostname));
            controller.abort();
        }, timeoutMs);
    });

    const request = async () => {
        for (let redirects = 0; ; redirects++) {
            let response;
            try {
                response = await fetchImpl(currentUrl.href, {
                    headers: { 'User-Agent': userAgent },
                    redirect: 'manual',
                    signal: controller.signal
                });
            } catch {
                throw new Error('Failed to fetch upstream subscription from ' + currentUrl.hostname);
            }
            if (REDIRECT_STATUSES.has(response.status)) {
                void response.body?.cancel().catch(() => {});
                if (redirects >= maxRedirects) throw new InvalidPayloadError('Upstream redirect limit exceeded');
                const location = response.headers.get('location');
                if (!location) throw new InvalidPayloadError('Upstream redirect is missing a location');
                currentUrl = validateUrl(location, currentUrl);
                continue;
            }
            if (response.status < 200 || response.status >= 300) {
                void response.body?.cancel().catch(() => {});
                throw new Error('Upstream ' + currentUrl.hostname + ' returned HTTP ' + response.status);
            }
            const text = await readResponseText(response, { maxBytes, controller, hostname: currentUrl.hostname });
            return { text, status: response.status, finalUrl: currentUrl.href };
        }
    };

    try {
        return await Promise.race([request(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function decodeUrlEncoding(text) {
    if (!/%[\da-f]{2}/i.test(text)) return text;
    try {
        return decodeURIComponent(text).trim();
    } catch {
        return text;
    }
}

function normalizeBase64(text) {
    const compact = text.replace(/\s+/g, '');
    if (!/^[a-z\d+/_-]+={0,2}$/i.test(compact)) return null;
    const unpadded = compact.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const remainder = unpadded.length % 4;
    return remainder === 1 ? null : unpadded + '='.repeat((4 - remainder) % 4);
}

function detectFormat(text) {
    if (/^[ \t]*\[proxy\][ \t]*\r?$/im.test(text) ||
        (/^[ \t]*\[general\][ \t]*\r?$/im.test(text) && /^[ \t]*\[rule\][ \t]*\r?$/im.test(text))) {
        return 'surge';
    }
    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed?.proxies) || Object.hasOwn(parsed ?? {}, 'proxy-providers') ? 'yaml' : 'json';
        } catch {
            // Flow-style YAML shares JSON's opening delimiters.
        }
    }
    if (/(?:^|[\n{,])[ \t]*['"]?(?:proxies|proxy-providers|proxy-groups|dns|rules)['"]?[ \t]*:/m.test(text)) {
        return 'yaml';
    }
    if (/^[ \t]*[a-z][a-z\d+.-]*:\/\//im.test(text)) return 'uri';
    return null;
}

function unwrapPayload(text, maxDecodeDepth) {
    let decodedBase64 = false;
    let detectedFormat = detectFormat(text);
    let depth = 0;
    for (; !detectedFormat && depth < maxDecodeDepth; depth++) {
        const decoded = decodeUrlEncoding(text);
        if (decoded !== text) {
            text = decoded;
        } else {
            const normalized = normalizeBase64(text);
            if (!normalized) break;
            const decoded = decodeBase64(normalized).trim();
            if (!decoded || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(decoded)) break;
            text = decoded;
            decodedBase64 = true;
        }
        detectedFormat = detectFormat(text);
    }
    return { text, detectedFormat, decodedBase64, remainingDepth: maxDecodeDepth - depth };
}

function validPort(value) {
    return (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) &&
        Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535;
}

function parseYaml(text, add, drop, diagnostics) {
    const aliases = text.match(/(?:^|[\s[\]{},:])\*[^\s[\]{},]+/g);
    if (aliases?.length > 50) throw new InvalidPayloadError('YAML alias expansion limit exceeded');
    if (/(?:^|[\s[\]{},:])(?:!<|!!js\/)/m.test(text)) {
        throw new InvalidPayloadError('Custom YAML tags are unsupported');
    }

    let parsed;
    try {
        parsed = yaml.load(text);
    } catch {
        throw new InvalidPayloadError('Invalid Clash YAML');
    }
    const proxies = Array.isArray(parsed?.proxies) ? parsed.proxies : [];
    if (Object.hasOwn(parsed ?? {}, 'proxy-providers') && proxies.length === 0) {
        diagnostics.push('proxy-providers is not supported yet; no inline proxies found');
    }
    for (const [index, proxy] of proxies.entries()) {
        const label = 'YAML proxy ' + (index + 1);
        if (!validPort(proxy?.port)) {
            drop(label, 'invalid port');
            continue;
        }
        const node = convertYamlProxyToObject(proxy);
        if (node?.type === 'vmess' && node.tls?.enabled && proxy['client-fingerprint'] != null) {
            node.tls.utls = { enabled: true, fingerprint: String(proxy['client-fingerprint']) };
        }
        if (node?.type === 'trojan' && proxy.udp !== undefined) node.udp = Boolean(proxy.udp);
        add(node, label);
    }
}

function parseJson(text, add, drop) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new InvalidPayloadError('Invalid Sing-Box JSON');
    }
    const outbounds = Array.isArray(parsed?.outbounds) ? parsed.outbounds : [];
    const proxies = parseSingboxJson(text)?.proxies ?? [];
    let proxyIndex = 0;
    for (const [index, outbound] of outbounds.entries()) {
        if (SINGBOX_NON_PROXY_TYPES.has(outbound?.type)) continue;
        const label = 'JSON outbound ' + (index + 1);
        if (outbound?.type && outbound?.server) add(proxies[proxyIndex++], label);
        else drop(label, 'invalid connection fields');
    }
}

function parseSurge(text, add, drop) {
    const entries = [];
    let inProxySection = false;
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line || /^[#;]/.test(line)) continue;
        if (/^\[.+\]$/.test(line)) {
            inProxySection = line.toLowerCase() === '[proxy]';
            continue;
        }
        if (!inProxySection) continue;
        const label = 'Surge line ' + (index + 1);
        const entry = /^[^=]+=\s*([^,]+),([^,]+),([^,]+)/.exec(line);
        if (!entry || !SURGE_TYPES.has(entry[1].trim().toLowerCase())) drop(label, 'unsupported or malformed proxy');
        else if (!entry[2].trim() || !validPort(entry[3])) drop(label, 'invalid connection fields');
        else entries.push({ line, label });
    }

    // Project the proxy section so upstream settings stay outside the Hub output.
    const proxies = parseSurgeIni('[Proxy]\n' + entries.map(entry => entry.line).join('\n'))?.proxies ?? [];
    for (const [index, { label }] of entries.entries()) add(proxies[index], label);
}

function prepareUri(line, scheme) {
    const body = line.slice(scheme.length + 3);
    if (scheme === 'vmess') {
        const separator = body.indexOf('#');
        const payload = normalizeBase64(separator < 0 ? body : body.slice(0, separator));
        if (!payload) return null;
        // The upstream parser logs JSON parse errors, which can quote decoded credentials.
        JSON.parse(decodeBase64(payload));
        const fragment = separator < 0 ? '' : body.slice(separator);
        decodeURIComponent(fragment);
        return 'vmess://' + payload + fragment;
    }
    if (scheme === 'anytls') {
        new URL(line);
    } else if (scheme !== 'ss' && body.includes('#') && !body.split('#', 1)[0].includes('?')) {
        // The shared parser expects a query delimiter before the display name.
        return scheme + '://' + body.replace('#', '?#');
    }
    return scheme + '://' + body;
}

async function parseUris(text, remainingDepth, add, drop) {
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
        let line = rawLine.trim();
        if (!line || /^(?:[#;]|\/\/)/.test(line)) continue;
        for (let depth = 0; depth < remainingDepth && !URI_SCHEME.test(line); depth++) {
            const decoded = decodeUrlEncoding(line);
            if (decoded === line) break;
            line = decoded;
        }
        const scheme = URI_SCHEME.exec(line)?.[1].toLowerCase();
        const label = 'URI line ' + (index + 1);
        // The shared parser also fetches HTTP subscriptions; this pass consumes node links only.
        if (!URI_SCHEMES.has(scheme)) {
            drop(label, 'unsupported or malformed entry');
            continue;
        }
        let uri;
        try {
            uri = prepareUri(line, scheme);
        } catch {
            uri = null;
        }
        add(uri ? await ProxyParser.parse(uri, 'clash.meta') : null, label + ' (' + scheme + ')');
    }
}

export async function parseSubscriptionPayload(rawText, { inputFormat = 'auto', maxNodes = 5000, maxDecodeDepth = 2 } = {}) {
    if (!INPUT_FORMATS.has(inputFormat)) throw new InvalidPayloadError('Unsupported input format');
    const payload = unwrapPayload((rawText ?? '').trim(), maxDecodeDepth);
    const format = inputFormat === 'auto' || inputFormat === 'base64'
        ? payload.detectedFormat ?? 'uri'
        : inputFormat;
    const detectedFormat = format === 'uri' && (payload.decodedBase64 || inputFormat === 'base64') ? 'base64' : format;
    const nodes = [];
    const diagnostics = [];
    let droppedCount = 0;

    const drop = (label, reason) => {
        droppedCount++;
        diagnostics.push(label + ': ' + reason);
    };
    const add = (node, label) => {
        if (typeof node?.type !== 'string' || !node.type.trim() ||
            typeof node.server !== 'string' || !node.server.trim() || !validPort(node.server_port)) {
            drop(label, 'unsupported or invalid connection fields');
            return;
        }
        if (nodes.length >= maxNodes) throw new InvalidPayloadError('Upstream subscription exceeds the node limit');
        nodes.push({ ...node, server_port: Number(node.server_port) });
    };

    if (format === 'yaml') parseYaml(payload.text, add, drop, diagnostics);
    else if (format === 'json') parseJson(payload.text, add, drop);
    else if (format === 'surge') parseSurge(payload.text, add, drop);
    else await parseUris(payload.text, payload.remainingDepth, add, drop);

    return { detectedFormat, nodes, droppedCount, diagnostics };
}
