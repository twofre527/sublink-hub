import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../../builders/ClashConfigBuilder.js';
import { SingboxConfigBuilder } from '../../builders/SingboxConfigBuilder.js';
import { SurgeConfigBuilder } from '../../builders/SurgeConfigBuilder.js';
import { InvalidConfigError, InvalidPayloadError } from '../../services/errors.js';
import { encodeNodesToBase64Uri } from './toShareUri.js';

export const VALID_TARGETS = ['mihomo', 'base64', 'singbox', 'surge'];
const SUPPORTED_MIHOMO_TYPES = new Set(['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls']);
const SUPPORTED_SINGBOX_TYPES = SUPPORTED_MIHOMO_TYPES;
const RESERVED_NAMES = new Set(['proxy', 'direct', 'reject']);
const CONTROL_OR_NEWLINE = /[\r\n\x00-\x1f\x7f]/;
const SURGE_UNSAFE_TAG = /[\r\n,=]+/g;

const TARGET_ALIASES = new Map([
    ['clash', 'mihomo'], ['clash-meta', 'mihomo'],
    ['xray', 'base64'], ['v2ray', 'base64'], ['uri', 'base64'],
    ['sing-box', 'singbox']
]);

const CLIENT_TARGETS = [
    ['mihomo', /\b(?:clash[\w.-]*|flclash|mihomo|stash)\b/i],
    ['singbox', /\b(?:sing-box\b|sf[aimt]\/|hiddify)/i],
    ['surge', /\bsurge/i],
    ['base64', /\b(?:shadowrocket|v2rayng?|nekobox|nekoray|quantumult|loon|karing|xray|v2box|streisand)/i]
];

export function normalizeTarget(raw) {
    const target = String(raw ?? '').trim().toLowerCase();
    if (!target) return null;
    const normalized = TARGET_ALIASES.get(target) ?? target;
    if (!VALID_TARGETS.includes(normalized)) throw new InvalidPayloadError('Unsupported target format');
    return normalized;
}

export function detectClientTarget(userAgent) {
    return CLIENT_TARGETS.find(([, pattern]) => pattern.test(userAgent ?? ''))?.[0] ?? null;
}

export function resolveOutputTarget({ explicitTarget, userAgent, collectionDefault = 'mihomo', systemDefault = 'mihomo' }) {
    return normalizeTarget(explicitTarget) || detectClientTarget(userAgent) ||
        normalizeTarget(collectionDefault) || normalizeTarget(systemDefault) || 'mihomo';
}

function getSingboxVersion(userAgent) {
    const match = /sing-box[\/\s](\d+)\.(\d+)/i.exec(userAgent);
    if (!match) return '1.12';
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major > 1 || (major === 1 && minor >= 14)) return '1.14';
    if (major < 1 || minor < 12) return '1.11';
    return '1.12';
}

function convertNodes(nodes, target, convert) {
    const converted = [];
    const warnings = [];
    for (const [index, node] of nodes.entries()) {
        const proxy = convert(node);
        if (proxy) converted.push(proxy);
        else warnings.push('Node ' + (index + 1) + ': unsupported by ' + target);
    }
    return { converted, warnings };
}

function disambiguateReservedNames(nodes) {
    const used = new Set();
    return nodes.map((node, index) => {
        const rawBase = String(node?.tag ?? node?.name ?? '').trim() || `Node ${index + 1}`;
        const base = RESERVED_NAMES.has(rawBase.toLowerCase()) ? `${rawBase} (Node)` : rawBase;
        let tag = base;
        for (let suffix = 2; used.has(tag.toLowerCase()); suffix++) {
            tag = `${base} (${suffix})`;
        }
        used.add(tag.toLowerCase());
        return { ...node, tag };
    });
}

function parseMbps(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value === 'string') {
        const match = /^\s*(\d+(?:\.\d+)?)/.exec(value);
        if (match) return Math.round(Number(match[1]));
    }
    return undefined;
}

function convertSingboxNode(node, context) {
    if (!SUPPORTED_SINGBOX_TYPES.has(node?.type)) return null;
    const prepared = { ...node };
    if (prepared.type === 'hysteria2') {
        if (prepared.up !== undefined) {
            const up = parseMbps(prepared.up);
            if (up === undefined) delete prepared.up;
            else prepared.up = up;
        }
        if (prepared.down !== undefined) {
            const down = parseMbps(prepared.down);
            if (down === undefined) delete prepared.down;
            else prepared.down = down;
        }
    }
    const converted = SingboxConfigBuilder.prototype.convertProxy.call(context, prepared);
    if (!converted) return null;
    if (converted.type === 'tuic') {
        if (converted.zero_rtt !== undefined && converted.zero_rtt_handshake === undefined) {
            converted.zero_rtt_handshake = Boolean(converted.zero_rtt);
        }
        delete converted.zero_rtt;
        delete converted.reduce_rtt;
        delete converted.fast_open;
        delete converted.disable_sni;
        delete converted.flow;
    }
    return converted;
}

function hasControlOrNewline(value) {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some(hasControlOrNewline);
    if (typeof value === 'object') return Object.values(value).some(hasControlOrNewline);
    return CONTROL_OR_NEWLINE.test(String(value));
}

function convertSurgeNode(node, usedSurgeNames) {
    const checkFields = [
        node.server, node.password, node.uuid, node.method,
        node.tls?.server_name, node.tls?.alpn, node.alpn,
        node.transport?.path, node.transport?.service_name, node.transport?.headers,
        node.congestion_control, node.udp_relay_mode
    ];
    if (checkFields.some(hasControlOrNewline)) return null;

    const rawTag = String(node.tag ?? '').replace(SURGE_UNSAFE_TAG, ' ').trim() || 'Node';
    const baseTag = RESERVED_NAMES.has(rawTag.toLowerCase()) ? `${rawTag} (Node)` : rawTag;
    let safeTag = baseTag;
    for (let suffix = 2; usedSurgeNames.has(safeTag.toLowerCase()); suffix++) {
        safeTag = `${baseTag} (${suffix})`;
    }
    usedSurgeNames.add(safeTag.toLowerCase());

    const prepared = { ...node, tag: safeTag };
    if (prepared.transport?.type === 'ws') {
        const rawHost = prepared.transport.headers?.host ?? prepared.transport.headers?.Host ?? prepared.transport.host;
        const wsHost = Array.isArray(rawHost) ? rawHost[0] : rawHost;
        prepared.transport = {
            ...prepared.transport,
            path: prepared.transport.path || '/',
            headers: wsHost ? { host: String(wsHost) } : undefined
        };
    }
    const alpnList = prepared.tls?.alpn ?? prepared.alpn;
    if (prepared.tls?.enabled && Array.isArray(alpnList) && alpnList.length > 0) {
        // Surge uses commas as option delimiters, so keep only the first ALPN value.
        prepared.tls = { ...prepared.tls, alpn: [String(alpnList[0]).replace(/,/g, '')] };
    }
    const line = SurgeConfigBuilder.prototype.convertProxy(prepared);
    return line && !line.startsWith('#') && !CONTROL_OR_NEWLINE.test(line)
        ? { line, name: safeTag }
        : null;
}

export function formatSubscriptionOutput(nodes, { target = 'mihomo', mode = '', userAgent = '' } = {}) {
    target = normalizeTarget(target) ?? 'mihomo';
    if (mode && mode !== 'provider') throw new InvalidPayloadError('Unsupported mode');
    if (mode === 'provider' && target !== 'mihomo') {
        throw new InvalidPayloadError('provider mode is only supported for mihomo target');
    }

    if (target === 'base64') {
        const { content: body, convertedCount, skippedCount, warnings } = encodeNodesToBase64Uri(nodes);
        if (!convertedCount) throw new InvalidConfigError('No compatible proxy nodes for target ' + target);
        return { body, contentType: 'text/plain; charset=utf-8', convertedCount, skippedCount, warnings, target };
    }

    const safeNodes = disambiguateReservedNames(nodes);
    let body, contentType, result;
    if (target === 'mihomo') {
        result = convertNodes(safeNodes, target, node =>
            SUPPORTED_MIHOMO_TYPES.has(node?.type) ? ClashConfigBuilder.prototype.convertProxy(node) : null
        );
        const config = { proxies: result.converted };
        if (mode !== 'provider') {
            config['proxy-groups'] = [{ name: 'PROXY', type: 'select', 'include-all': true }];
            config.rules = ['MATCH,PROXY'];
        }
        body = yaml.dump(config);
        contentType = 'text/yaml; charset=utf-8';
    } else if (target === 'singbox') {
        const context = { singboxVersion: getSingboxVersion(userAgent) };
        result = convertNodes(safeNodes, target, node => convertSingboxNode(node, context));
        const { converted } = result;
        body = JSON.stringify({
            outbounds: [
                { type: 'selector', tag: 'PROXY', outbounds: converted.map(proxy => proxy.tag) },
                ...converted,
                { type: 'direct', tag: 'direct' }
            ],
            route: { final: 'PROXY' }
        }, null, 2);
        contentType = 'application/json; charset=utf-8';
    } else {
        const usedSurgeNames = new Set();
        result = convertNodes(safeNodes, target, node => convertSurgeNode(node, usedSurgeNames));
        const lines = result.converted.map(proxy => proxy.line).join('\n');
        const names = result.converted.map(proxy => proxy.name).join(', ');
        body = '[Proxy]\n' + lines + '\n\n[Proxy Group]\nPROXY = select, ' + names + '\n\n[Rule]\nFINAL,PROXY\n';
        contentType = 'text/plain; charset=utf-8';
    }

    const convertedCount = result.converted.length;
    if (!convertedCount) throw new InvalidConfigError('No compatible proxy nodes for target ' + target);
    return { body, contentType, convertedCount, skippedCount: nodes.length - convertedCount, warnings: result.warnings, target };
}
