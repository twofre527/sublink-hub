import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../../builders/ClashConfigBuilder.js';
import { SingboxConfigBuilder } from '../../builders/SingboxConfigBuilder.js';
import { SurgeConfigBuilder } from '../../builders/SurgeConfigBuilder.js';
import { InvalidConfigError, InvalidPayloadError } from '../../services/errors.js';
import { encodeNodesToBase64Uri } from './toShareUri.js';

export const VALID_TARGETS = ['mihomo', 'base64', 'singbox', 'surge'];
const SUPPORTED_MIHOMO_TYPES = new Set(['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls']);

const TARGET_ALIASES = new Map([
    ['clash', 'mihomo'], ['clash-meta', 'mihomo'],
    ['xray', 'base64'], ['v2ray', 'base64'], ['uri', 'base64'],
    ['sing-box', 'singbox']
]);

const CLIENT_TARGETS = [
    ['mihomo', /\b(?:clash[\s._/-]?verge|clash\.meta|clashx|clashfor\w+|mihomo|stash|clash)\b/i],
    ['singbox', /\b(?:sing-box\b|sf[aimt]\/|hiddify)/i],
    ['surge', /\bsurge\b/i],
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

    let body, contentType, result;
    if (target === 'mihomo') {
        result = convertNodes(nodes, target, node =>
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
        result = convertNodes(nodes, target, node => SingboxConfigBuilder.prototype.convertProxy.call(context, node));
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
        result = convertNodes(nodes, target, node => {
            const line = SurgeConfigBuilder.prototype.convertProxy(node);
            return line && !line.startsWith('#') ? { line, name: node.tag } : null;
        });
        const lines = result.converted.map(proxy => proxy.line).join('\n');
        const names = result.converted.map(proxy => proxy.name).join(', ');
        body = '[Proxy]\n' + lines + '\n\n[Proxy Group]\nPROXY = select, ' + names + '\n\n[Rule]\nFINAL,PROXY\n';
        contentType = 'text/plain; charset=utf-8';
    }

    const convertedCount = result.converted.length;
    if (!convertedCount) throw new InvalidConfigError('No compatible proxy nodes for target ' + target);
    return { body, contentType, convertedCount, skippedCount: nodes.length - convertedCount, warnings: result.warnings, target };
}
