import yaml from 'js-yaml';
import { ProxyParser } from '../../parsers/ProxyParser.js';
import { convertSurgeProxyToObject } from '../../parsers/convertSurgeProxyToObject.js';
import { convertYamlProxyToObject } from '../../parsers/convertYamlProxyToObject.js';
import { parseSingboxJson } from '../../parsers/subscription/subscriptionContentParser.js';
import { InvalidPayloadError } from '../../services/errors.js';
import { decodeBase64 } from '../../utils.js';

const BLOCKED_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 9200, 2375, 2379]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const URI_SCHEMES = new Set(['ss', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'anytls']);
const SURGE_TYPES = new Set(['ss', 'shadowsocks', 'vmess', 'trojan', 'tuic', 'hysteria2', 'hy2']);
const SURGE_BUILTIN_TYPES = new Set(['direct', 'reject', 'reject-tinygif', 'http', 'https']);
const SINGBOX_NON_PROXY_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);
const INPUT_FORMATS = new Set(['auto', 'yaml', 'base64', 'uri', 'json', 'surge']);
const URI_SCHEME = /^([a-z][a-z\d+.-]*):\/\//i;
const MAX_DIAGNOSTICS = 50;

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
        const address = hostname.slice(1, -1).toLowerCase();
        // Block ::/96 (unspecified, loopback, IPv4-compatible), ::ffff:/96, 100::/64 (discard),
        // 64:ff9b::/96 & 64:ff9b:1::/48 (NAT64), fc00::/7 (ULA), fe80::/10, fec0::/10, ff00::/8.
        blocked = /^(?:::[\da-f:.]*$|::ffff:|100::|64:ff9b:(?::|1:)|f[cd][\da-f]{2}:|fe[89a-f][\da-f]:|ff[\da-f]{2}:)/.test(address);
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
        void response.body?.cancel().catch(() => {});
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

function firstContentLine(text) {
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line && !/^(?:[#;]|\/\/)/.test(line)) return line;
    }
    return '';
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
    if (URI_SCHEME.test(firstContentLine(text))) return 'uri';
    if ((text.startsWith('{') && /(?:^|[\n{,])[ \t]*['"]?(?:proxies|proxy-providers|proxy-groups|dns|rules)['"]?[ \t]*:/m.test(text)) ||
        /(?:^|\n)[ \t]*['"]?(?:proxies|proxy-providers|proxy-groups|dns|rules)['"]?[ \t]*:/m.test(text)) {
        return 'yaml';
    }
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

function assertBoundedGraph(root, { maxVisits = 200000, maxDepth = 16 } = {}) {
    let visits = 0;
    const ancestors = new Set();
    function visit(value, depth) {
        if (++visits > maxVisits) throw new InvalidPayloadError('YAML alias expansion limit exceeded');
        if (value === null || typeof value !== 'object') return;
        if (depth > maxDepth || ancestors.has(value)) throw new InvalidPayloadError('YAML alias expansion limit exceeded');
        ancestors.add(value);
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) visit(value[i], depth + 1);
        } else {
            for (const key of Object.keys(value)) visit(value[key], depth + 1);
        }
        ancestors.delete(value);
    }
    visit(root, 0);
}

function parseDurationSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return undefined;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
    if (!match) return undefined;
    const num = Number(match[1]);
    const unit = (match[2] || 's').toLowerCase();
    if (unit === 'h') return Math.round(num * 3600);
    if (unit === 'm') return Math.round(num * 60);
    if (unit === 'ms') return Math.round(num / 1000);
    return Math.round(num);
}

function parseMbpsNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return undefined;
    const match = /^\s*(\d+(?:\.\d+)?)/.exec(value);
    return match ? Number(match[1]) : undefined;
}

function normalizeSingboxProxy(proxy) {
    if (!proxy || typeof proxy !== 'object') return proxy;
    const next = { ...proxy };
    if (!next.alpn && Array.isArray(next.tls?.alpn)) next.alpn = next.tls.alpn;
    if (next.type === 'hysteria2') {
        if (!next.ports && Array.isArray(next.server_ports) && next.server_ports.length > 0) {
            next.ports = next.server_ports.map(entry => String(entry).replace(/:/g, '-')).join(',');
            delete next.server_ports;
        }
        if (next.up === undefined && next.up_mbps !== undefined) {
            const up = parseMbpsNumber(next.up_mbps);
            if (up !== undefined) next.up = up;
            delete next.up_mbps;
        }
        if (next.down === undefined && next.down_mbps !== undefined) {
            const down = parseMbpsNumber(next.down_mbps);
            if (down !== undefined) next.down = down;
            delete next.down_mbps;
        }
        if (typeof next.hop_interval === 'string') {
            const secs = parseDurationSeconds(next.hop_interval);
            if (secs !== undefined) next.hop_interval = secs;
        }
    }
    if (next.type === 'anytls') {
        for (const key of ['idle_session_check_interval', 'idle_session_timeout']) {
            if (typeof next[key] === 'string') {
                const secs = parseDurationSeconds(next[key]);
                if (secs !== undefined) next[key] = secs;
            }
        }
    }
    if (next.type === 'tuic' && next.zero_rtt === undefined && next.zero_rtt_handshake !== undefined) {
        next.zero_rtt = Boolean(next.zero_rtt_handshake);
        delete next.zero_rtt_handshake;
    }
    return next;
}

function parseYaml(text, add, drop, diagnostics) {
    // Only check alias token count when YAML anchors exist so normal node names like "*2x" are never rejected.
    if (/(?:^|[\s[\]{},:])&[^\s[\]{},]+/m.test(text)) {
        const aliases = text.match(/(?:^|[\s[\]{},:])\*[^\s[\]{},]+/g);
        if (aliases?.length > 50) throw new InvalidPayloadError('YAML alias expansion limit exceeded');
    }
    if (/(?:^|[\s[\]{},:])(?:!<|!!js\/)/m.test(text)) {
        throw new InvalidPayloadError('Custom YAML tags are unsupported');
    }

    let parsed;
    try {
        parsed = yaml.load(text);
    } catch {
        throw new InvalidPayloadError('Invalid Clash YAML');
    }
    assertBoundedGraph(parsed);
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
        // Clash/Mihomo defaults Trojan to TLS enabled unless explicitly set to false.
        const yamlProxy = String(proxy?.type || '').toLowerCase() === 'trojan' && proxy.tls === undefined
            ? { ...proxy, tls: true }
            : proxy;
        const node = convertYamlProxyToObject(yamlProxy);
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
        if (outbound?.type && outbound?.server) add(normalizeSingboxProxy(proxies[proxyIndex++]), label);
        else drop(label, 'invalid connection fields');
    }
}

function parseSurge(text, add, drop) {
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
        const eqIndex = line.indexOf('=');
        if (eqIndex <= 0) {
            drop(label, 'unsupported or malformed proxy');
            continue;
        }
        const parts = line.slice(eqIndex + 1).split(',').map(part => part.trim());
        const type = (parts[0] || '').toLowerCase();
        if (SURGE_BUILTIN_TYPES.has(type)) continue;
        if (!SURGE_TYPES.has(type)) {
            drop(label, 'unsupported or malformed proxy');
            continue;
        }
        if (parts.length < 3 || !parts[1] || !validPort(parts[2])) {
            drop(label, 'invalid connection fields');
            continue;
        }
        add(convertSurgeProxyToObject(line), label);
    }
}

function decodeFragmentSafely(fragment) {
    try {
        return { fragment, decoded: decodeURIComponent(fragment) };
    } catch {
        const escaped = '#' + fragment.slice(1).replace(/%(?![0-9a-fA-F]{2})/g, '%25');
        try {
            decodeURIComponent(escaped);
            return { fragment: escaped, decoded: null };
        } catch {
            return { fragment: '#' + encodeURIComponent(fragment.slice(1)), decoded: null };
        }
    }
}

function prepareUri(line, scheme) {
    const body = line.slice(scheme.length + 3);
    if (scheme === 'vmess') {
        const separator = body.indexOf('#');
        const payload = normalizeBase64(separator < 0 ? body : body.slice(0, separator));
        if (!payload) return null;
        // The upstream parser logs JSON parse errors, which can quote decoded credentials.
        JSON.parse(decodeBase64(payload));
        const fragment = separator < 0 ? '' : decodeFragmentSafely(body.slice(separator)).fragment;
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

const nonEmptyString = value => typeof value === 'string' && value.length > 0;

function hasProtocolCredentials(node) {
    switch (node.type) {
        case 'shadowsocks': return nonEmptyString(node.method) && nonEmptyString(node.password);
        case 'vmess':
        case 'vless': return nonEmptyString(node.uuid);
        case 'trojan':
        case 'hysteria2':
        case 'anytls': return nonEmptyString(node.password);
        case 'tuic': return nonEmptyString(node.uuid) && nonEmptyString(node.password);
        default: return true;
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
        if (diagnostics.length < MAX_DIAGNOSTICS) {
            diagnostics.push(label + ': ' + reason);
        } else if (diagnostics.length === MAX_DIAGNOSTICS) {
            diagnostics.push('Additional diagnostics omitted');
        }
    };
    const add = (node, label) => {
        if (typeof node?.type !== 'string' || !node.type.trim() ||
            typeof node.server !== 'string' || !node.server.trim() || !validPort(node.server_port) ||
            !hasProtocolCredentials(node)) {
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
