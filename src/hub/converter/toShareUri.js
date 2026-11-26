import { encodeBase64 } from '../../utils.js';

const OBFS_OPTION_NAMES = { mode: 'obfs', host: 'obfs-host', path: 'obfs-uri' };
const boolParam = value => value == null ? undefined : value ? '1' : '0';
const listParam = value => Array.isArray(value) ? value.join(',') : value;
const transportHost = transport => transport?.headers?.host ?? transport?.headers?.Host ?? transport?.host;

function queryString(fields) {
    return new URLSearchParams(Object.entries(fields).filter(([, value]) => value != null)).toString();
}

function shadowsocksPlugin(plugin, options) {
    if (!plugin) return undefined;
    const parts = [plugin === 'obfs' ? 'obfs-local' : plugin];
    for (const [key, value] of Object.entries(options ?? {})) {
        const name = plugin === 'obfs' ? (OBFS_OPTION_NAMES[key] ?? key) : key;
        if (value === true) parts.push(name);
        else if (value != null && value !== false) parts.push(`${name}=${value}`);
    }
    return parts.join(';');
}

function vmessUri(node, server, port, tag) {
    const { transport, tls } = node;
    const network = transport?.type || node.network || 'tcp';
    return `vmess://${encodeBase64(JSON.stringify({
        v: '2',
        ps: tag,
        add: server,
        port: String(port),
        id: node.uuid,
        aid: String(node.alter_id ?? 0),
        scy: node.security || 'auto',
        net: network === 'http' ? 'tcp' : network,
        type: network === 'http' ? 'http' : 'none',
        host: transportHost(transport),
        path: network === 'grpc' ? transport?.service_name : transport?.path,
        ...(network === 'http' ? { method: transport?.method, headers: transport?.headers } : {}),
        tls: tls?.enabled ? 'tls' : '',
        sni: tls?.server_name || '',
        fp: tls?.utls?.fingerprint || '',
        'skip-cert-verify': tls?.insecure ? true : undefined
    }))}`;
}

function vlessTrojanParams(node, defaultTls) {
    const { tls, transport } = node;
    return {
        security: tls?.reality?.enabled ? 'reality' : (tls?.enabled ?? defaultTls) ? 'tls' : 'none',
        sni: tls?.server_name,
        fp: tls?.utls?.fingerprint,
        pbk: tls?.reality?.public_key,
        sid: tls?.reality?.short_id,
        'support-x25519mlkem768': boolParam(tls?.reality?.support_x25519mlkem768),
        flow: node.flow,
        type: transport?.type || 'tcp',
        host: listParam(transportHost(transport)),
        path: transport?.path,
        serviceName: transport?.service_name,
        mode: transport?.mode,
        alpn: listParam(tls?.alpn ?? node.alpn),
        allowInsecure: tls?.insecure ? '1' : undefined
    };
}

export function nodeToShareUri(node) {
    const warning = () => ({ uri: null, warning: 'Unsupported or invalid node type: ' + String(node?.type || 'unknown') });
    const rawPort = node?.server_port;
    const port = typeof rawPort === 'number' || typeof rawPort === 'string' ? Number(rawPort) : NaN;
    const server = typeof node?.server === 'string' ? node.server.trim() : '';
    if (!server || !Number.isInteger(port) || port < 1 || port > 65535) return warning();

    const { tls } = node;
    const tag = node.tag ?? node.name ?? '';
    const host = server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;
    const endpoint = `${host}:${port}`;
    const fragment = encodeURIComponent(tag);
    const uriWithParams = (scheme, userinfo, params) => ({
        uri: `${scheme}://${userinfo}@${endpoint}?${queryString(params)}#${fragment}`
    });
    const password = () => encodeURIComponent(node.password ?? '');

    switch (node.type) {
        case 'shadowsocks': {
            const userinfo = encodeBase64(`${node.method}:${node.password}`);
            const query = queryString({ plugin: shadowsocksPlugin(node.plugin, node.plugin_opts) });
            return { uri: `ss://${userinfo}@${endpoint}${query ? `?${query}` : ''}#${fragment}` };
        }
        case 'vmess':
            return { uri: vmessUri(node, server, port, tag) };
        case 'vless':
            return uriWithParams('vless', encodeURIComponent(node.uuid ?? ''), {
                encryption: node.encryption || 'none',
                ...vlessTrojanParams(node, false),
                packetEncoding: node.packet_encoding,
                udp: boolParam(node.udp)
            });
        case 'trojan':
            return uriWithParams('trojan', password(), vlessTrojanParams(node, true));
        case 'hysteria2':
            return uriWithParams('hysteria2', password(), {
                sni: tls?.server_name,
                insecure: boolParam(tls?.insecure ?? false),
                obfs: node.obfs?.type,
                'obfs-password': node.obfs?.password,
                mport: listParam(node.ports),
                'hop-interval': node.hop_interval,
                up: node.up,
                down: node.down,
                alpn: listParam(node.alpn ?? tls?.alpn),
                'fast-open': boolParam(node.fast_open),
                auth: node.auth,
                recv_window_conn: node.recv_window_conn
            });
        case 'tuic':
            return uriWithParams('tuic', `${encodeURIComponent(node.uuid ?? '')}:${password()}`, {
                sni: tls?.server_name,
                alpn: listParam(tls?.alpn ?? node.alpn),
                congestion_control: node.congestion_control,
                'udp-relay-mode': node.udp_relay_mode,
                'disable-sni': boolParam(node.disable_sni),
                allow_insecure: boolParam(tls?.insecure),
                'zero-rtt': boolParam(node.zero_rtt),
                'reduce-rtt': boolParam(node.reduce_rtt),
                'fast-open': boolParam(node.fast_open),
                flow: node.flow
            });
        case 'anytls':
            return uriWithParams('anytls', password(), {
                sni: tls?.server_name,
                insecure: boolParam(tls?.insecure),
                alpn: listParam(tls?.alpn ?? node.alpn),
                fp: tls?.utls?.fingerprint,
                udp: boolParam(node.udp),
                'idle-session-check-interval': node['idle-session-check-interval'] ?? node.idle_session_check_interval,
                'idle-session-timeout': node['idle-session-timeout'] ?? node.idle_session_timeout,
                'min-idle-session': node['min-idle-session'] ?? node.min_idle_session
            });
        default:
            return warning();
    }
}

export function encodeNodesToBase64Uri(nodes) {
    const rawLines = [];
    const warnings = [];
    for (const node of nodes) {
        const { uri, warning } = nodeToShareUri(node);
        if (uri) rawLines.push(uri);
        if (warning) warnings.push(warning);
    }
    return {
        content: rawLines.length ? encodeBase64(rawLines.join('\n')) : '',
        rawLines,
        convertedCount: rawLines.length,
        skippedCount: nodes.length - rawLines.length,
        warnings
    };
}
