import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { validateUpstreamUrl, safeFetchSubscription, parseSubscriptionPayload } from '../../src/hub/converter/fetchAndParse.js';
import { computeNodeFingerprint, mergeSourceNodes } from '../../src/hub/converter/mergeNodes.js';
import { nodeToShareUri, encodeNodesToBase64Uri } from '../../src/hub/converter/toShareUri.js';
import { detectClientTarget, formatSubscriptionOutput, normalizeTarget, resolveOutputTarget } from '../../src/hub/converter/formatOutput.js';
import { ProxyParser } from '../../src/parsers/ProxyParser.js';
import { InvalidConfigError, InvalidPayloadError } from '../../src/services/errors.js';
import { decodeBase64, encodeBase64 } from '../../src/utils.js';

const server = 'proxy.example.com';
const endpoint = server + ':443';
const uuid = '12345678-1234-1234-1234-123456789012';
const ss = {
    tag: 'Node', type: 'shadowsocks', server, server_port: 443,
    method: 'aes-128-gcm', password: 'sample:password', tcp_fast_open: false
};
const ssUri = 'ss://' + encodeBase64(ss.method + ':' + ss.password) + '@' + endpoint + '#Node';

describe('upstream URLs', () => {
    it.each(['https://example.com/sub', 'https://example.com:8443/sub', 'https://8.8.8.8/', 'https://[2606:4700::1111]/'])(
        'permits %s', url => expect(validateUpstreamUrl(url).href).toBe(url)
    );
    it.each([
        'bad url', 'http://example.com', 'https://user:token@example.com', 'https://localhost',
        'https://sub.localhost', 'https://node.local.', 'https://node.internal', 'https://node.arpa',
        'https://intranet', 'https://example.com:21', 'https://example.com:3306', 'https://example.com:5432',
        'https://example.com:6379', 'https://example.com:27017', 'https://example.com:11211',
        'https://example.com:9200', 'https://example.com:2375', 'https://example.com:2379',
        'https://127.1.2.3', 'https://10.1.2.3', 'https://172.16.0.1', 'https://172.31.0.1',
        'https://192.168.1.1', 'https://169.254.42.1', 'https://100.64.0.1', 'https://100.127.0.1',
        'https://0.0.0.0', 'https://224.0.0.1', 'https://255.255.255.255',
        'https://[::]', 'https://[::1]', 'https://[fc00::1]', 'https://[fd00::1]',
        'https://[fe80::1]', 'https://[febf::1]', 'https://[ff02::1]', 'https://[::ffff:127.0.0.1]',
        'https://[::ffff:8.8.8.8]', 'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1',
        'https://134744072'
    ])('rejects %s', url => expect(() => validateUpstreamUrl(url)).toThrow(InvalidPayloadError));
});

describe('subscription fetch', () => {
    const upstream = 'https://example.com/subscription?token=secret-token';
    const redirect = location => new Response(null, { status: 302, headers: { location } });

    it('follows relative redirects manually and decodes split UTF-8 chunks', async () => {
        const bytes = new TextEncoder().encode('节点');
        const cancel = vi.fn();
        const hop = new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: '/next' } });
        const fetchImpl = vi.fn().mockResolvedValueOnce(hop)
            .mockResolvedValueOnce(new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(bytes.slice(0, 2));
                    controller.enqueue(bytes.slice(2));
                    controller.close();
                }
            })));

        await expect(safeFetchSubscription(upstream, { fetchImpl, maxBytes: bytes.length })).resolves.toEqual({
            text: '节点', status: 200, finalUrl: 'https://example.com/next'
        });
        expect(fetchImpl).toHaveBeenNthCalledWith(1, upstream, expect.objectContaining({
            redirect: 'manual', headers: { 'User-Agent': 'clash.meta' }, signal: expect.any(AbortSignal)
        }));
        expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://example.com/next', expect.any(Object));
        expect(cancel).toHaveBeenCalledOnce();
    });

    it.each(['http://example.com/next', '//localhost/admin', 'https://login:secret@example.com', '//134744072/next'])(
        'rejects a redirect to %s before fetching it', async location => {
            const fetchImpl = vi.fn().mockResolvedValue(redirect(location));
            await expect(safeFetchSubscription(upstream, { fetchImpl })).rejects.toBeInstanceOf(InvalidPayloadError);
            expect(fetchImpl).toHaveBeenCalledOnce();
        }
    );

    it('enforces the redirect limit', async () => {
        const fetchImpl = vi.fn().mockImplementation(async () => redirect('/again'));
        await expect(safeFetchSubscription(upstream, { fetchImpl, maxRedirects: 1 })).rejects.toThrow('redirect limit');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it.each([true, false])('enforces the byte limit with a declared length: %s', async declaredLength => {
        const response = new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: declaredLength ? { 'Content-Length': '4' } : {}
        });
        const fetchImpl = vi.fn().mockResolvedValue(response);
        await expect(safeFetchSubscription(upstream, { fetchImpl, maxBytes: 3 })).rejects.toThrow('byte limit');
        expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('aborts a request when its timeout elapses', async () => {
        const aborted = vi.fn();
        const fetchImpl = vi.fn((_, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                aborted();
                reject(new Error('Aborted'));
            }, { once: true });
        }));
        await expect(safeFetchSubscription(upstream, { fetchImpl, timeoutMs: 10 })).rejects.toThrow('timed out');
        expect(aborted).toHaveBeenCalledOnce();
    });

    it('reports only the host and status on HTTP errors', async () => {
        const fetchImpl = async () => new Response('private body', { status: 403 });
        await expect(safeFetchSubscription(upstream, { fetchImpl })).rejects.toThrow(/^Upstream example\.com returned HTTP 403$/);
    });

    it('masks transport errors which include the upstream URL', async () => {
        const fetchImpl = async () => { throw new Error('Could not reach ' + upstream); };
        await expect(safeFetchSubscription(upstream, { fetchImpl })).rejects.toThrow(/^Failed to fetch upstream subscription from example\.com$/);
    });
});

describe('subscription payloads', () => {
    const clash = [
        'proxies:',
        '  - {name: 节点, type: vmess, server: vmess.example.com, port: 443, uuid: fixture-uuid, tls: true, client-fingerprint: chrome}',
        '  - {name: Second, type: trojan, server: trojan.example.com, port: 8443, password: fixture-secret, udp: false}',
        '  - {name: Bad, type: trojan, server: private.example.com, port: 123abc, password: sensitive-password}',
        'dns: {enable: true}',
        'rules: [MATCH,DIRECT]',
        'proxy-groups: [{name: ignored, type: select}]'
    ].join('\n');

    it('extracts only valid inline YAML proxies and preserves special fields', async () => {
        const parsed = await parseSubscriptionPayload(clash);
        expect(parsed).toEqual({
            detectedFormat: 'yaml',
            nodes: [
                expect.objectContaining({ tag: '节点', tls: expect.objectContaining({ utls: { enabled: true, fingerprint: 'chrome' } }) }),
                expect.objectContaining({ tag: 'Second', udp: false })
            ],
            droppedCount: 1,
            diagnostics: ['YAML proxy 3: invalid port']
        });
        expect(await parseSubscriptionPayload(encodeURIComponent(clash))).toEqual(parsed);
    });

    it.each(['', 'proxies: []\n', 'proxies: wrong\n'])('reports provider-only YAML with inline field %s', async inline => {
        await expect(parseSubscriptionPayload(inline + 'proxy-providers:\n  provider: {type: http, url: https://example.com/?token=private}'))
            .resolves.toEqual({
                detectedFormat: 'yaml', nodes: [], droppedCount: 0,
                diagnostics: ['proxy-providers is not supported yet; no inline proxies found']
            });
    });

    it('limits YAML aliases before parsing and rejects explicit custom tags', async () => {
        const aliases = 'anchor: &entry 1\nproxies: [' + Array(51).fill('*entry').join(', ') + ']';
        await expect(parseSubscriptionPayload(aliases)).rejects.toThrow('YAML alias expansion limit exceeded');
        await expect(parseSubscriptionPayload('proxies: !<tag:example.com,2026:test> []')).rejects.toThrow('Custom YAML tags');
        await expect(parseSubscriptionPayload('proxies: !!js/function "private"')).rejects.toThrow('Custom YAML tags');
    });

    it('decodes Base64, unpadded Base64URL and nested URL encoding without changing raw URI fragments', async () => {
        const text = ssUri.replace('#Node', '#节点🌍') + '>\n' + ssUri.replace('#Node', '#encoded%2520name');
        const base64 = encodeBase64(text);
        const base64url = base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        expect(base64url).toMatch(/[-_]/);
        for (const input of [base64, base64url, encodeURIComponent(base64), encodeBase64(encodeBase64(text))]) {
            const result = await parseSubscriptionPayload(input);
            expect(result.detectedFormat).toBe('base64');
            expect(result.nodes.map(node => node.tag)).toEqual(['节点🌍>', 'encoded%20name']);
        }
        await expect(parseSubscriptionPayload(encodeURIComponent(text))).resolves.toMatchObject({
            detectedFormat: 'uri', nodes: [expect.objectContaining({ tag: '节点🌍>' }), expect.objectContaining({ tag: 'encoded%20name' })]
        });
        const result = await parseSubscriptionPayload(encodeBase64(encodeBase64(text)), { maxDecodeDepth: 1 });
        expect(result.nodes).toEqual([]);
        const encoded = encodeURIComponent(encodeURIComponent(ssUri));
        await expect(parseSubscriptionPayload(encoded, { maxDecodeDepth: 1 })).resolves.toMatchObject({ nodes: [] });
        await expect(parseSubscriptionPayload(encoded)).resolves.toMatchObject({ nodes: [ss] });
    });

    it('counts failed URI entries with sanitized diagnostics', async () => {
        const text = [
            '# comment', ssUri, encodeURIComponent('trojan://p%40ss@' + endpoint + '#Encoded'),
            'vless://sensitive-uuid@private.example.com:0?#Bad',
            'https://example.com/?token=private-token',
            'vmess://' + encodeBase64('sensitive-decoded-text'), 'sensitive-plain-text'
        ].join('\n');
        const result = await parseSubscriptionPayload(text, { inputFormat: 'uri' });
        expect(result.nodes.map(node => node.tag)).toEqual(['Node', 'Encoded']);
        expect(result.nodes[1].password).toBe('p@ss');
        expect(result.droppedCount).toBe(4);
        expect(result.diagnostics).toEqual([
            'URI line 4 (vless): unsupported or invalid connection fields',
            'URI line 5: unsupported or malformed entry',
            'URI line 6 (vmess): unsupported or invalid connection fields',
            'URI line 7: unsupported or malformed entry'
        ]);
    });

    it('extracts and validates Sing-Box outbounds while ignoring settings and groups', async () => {
        const payload = JSON.stringify({
            outbounds: [{ type: 'selector', tag: 'proxy' }, ss, { type: 'direct' },
                { ...ss, server_port: 65536, password: 'private-password' }, { type: 'vless', uuid }],
            dns: {}, inbounds: [], route: { final: 'proxy' }
        });
        await expect(parseSubscriptionPayload(payload)).resolves.toEqual({
            detectedFormat: 'json', nodes: [ss], droppedCount: 2, diagnostics: [
                'JSON outbound 4: unsupported or invalid connection fields',
                'JSON outbound 5: invalid connection fields'
            ]
        });
    });

    it('extracts Surge proxy entries and counts malformed and unsupported lines', async () => {
        const payload = [
            '[General]', 'loglevel = notice', '[Proxy]', '; comment',
            'Test = ss, proxy.example.com, 443, encrypt-method=aes-128-gcm, password=fixture-secret',
            'Direct = direct', 'Other = unsupported, host.example.com, 443, password=private-token',
            'Invalid = ss, private.example.com, 123abc, password=private-token',
            '[Proxy Group]', 'PROXY = select, Test', '[Rule]', 'FINAL,PROXY'
        ].join('\r\n');
        await expect(parseSubscriptionPayload(payload)).resolves.toEqual({
            detectedFormat: 'surge',
            nodes: [expect.objectContaining({ tag: 'Test', type: 'shadowsocks', password: 'fixture-secret' })],
            droppedCount: 3, diagnostics: [
                'Surge line 6: unsupported or malformed proxy',
                'Surge line 7: unsupported or malformed proxy',
                'Surge line 8: invalid connection fields'
            ]
        });
    });

    it('applies the node limit to accepted nodes only', async () => {
        await expect(parseSubscriptionPayload(ssUri + '\ninvalid', { maxNodes: 1 })).resolves.toMatchObject({ droppedCount: 1 });
        await expect(parseSubscriptionPayload(ssUri + '\n' + ssUri, { maxNodes: 1 })).rejects.toThrow('node limit');
    });
});

describe('merged nodes', () => {
    const first = { ...ss, server: '  PROXY.EXAMPLE.COM ', server_port: '443', _source: 'one' };
    const different = { ...ss, server: 'different.example.com' };
    const duplicate = { ...ss, tag: undefined, name: 'Different display name', _source: 'two' };
    const sources = [
        { sourceId: 'one', alias: 'Source', nodes: [first, different, duplicate] },
        { sourceId: 'two', alias: 'Next', nodes: [{ ...different, name: 'Last', tag: undefined, server_port: 8443 }] }
    ];

    it('normalizes fields and ordering recursively while retaining array order', () => {
        const a = { ...first, transport: { path: ['/a', '/b'], _source: 'one', headers: { host: 'example.com', optional: undefined } } };
        const b = { transport: { headers: { host: 'example.com' }, path: ['/a', '/b'], _source: 'two' }, ...duplicate };
        expect(computeNodeFingerprint(a)).toBe(computeNodeFingerprint(b));
        expect(computeNodeFingerprint(a)).not.toBe(computeNodeFingerprint({ ...b, transport: { ...b.transport, path: ['/b', '/a'] } }));
    });

    it('preserves source order, deduplicates by connection and disambiguates names', () => {
        const result = mergeSourceNodes(sources);
        expect(result).toMatchObject({ totalBeforeDedup: 4, dedupedCount: 1 });
        expect(result.nodes.map(node => [node.tag, node.server])).toEqual([
            ['Source | Node', first.server], ['Source | Node (2)', different.server], ['Next | Last', different.server]
        ]);
        expect(result.nodes[2]).not.toHaveProperty('name');
        expect(first.tag).toBe('Node');
    });

    it('honors prefix and dedup options and skips already used suffixes', () => {
        const result = mergeSourceNodes([
            { alias: 'Source', nodes: [{ ...ss, tag: 'Node (2)' }, first, different, duplicate] }
        ], { prefixEnabled: false, deduplicate: false });
        expect(result.dedupedCount).toBe(0);
        expect(result.nodes.map(node => node.tag)).toEqual(['Node (2)', 'Node', 'Node (3)', 'Different display name']);
    });
});

describe('share URI output', () => {
    const reality = 'security=reality&sni=secure.example.com&fp=firefox&pbk=sample-key&sid=ab&support-x25519mlkem768=1';
    const vmess = data => 'vmess://' + encodeBase64(JSON.stringify({
        v: '2', ps: '节点', add: server, port: '443', id: uuid, aid: '0', scy: 'auto',
        tls: 'tls', sni: 'tls.example.com', fp: 'chrome', 'skip-cert-verify': true, ...data
    }));
    const cases = [
        ['Shadowsocks obfs', ssUri.replace('#Node', '?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dcover.example.com%3Bobfs-uri%3D%2Ftest#Node')],
        ['Shadowsocks v2ray-plugin', ssUri.replace('#Node', '?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Bhost%3Dcover.example.com%3Bpath%3D%2Ftest%3Btls#Node')],
        ['VMess WS', vmess({ net: 'ws', host: 'ws.example.com', path: '/ws' })],
        ['VMess HTTP', vmess({ net: 'tcp', type: 'http', host: ['http.example.com'], path: ['/a', '/b'], method: 'POST', headers: { accept: ['text/plain'] } })],
        ['VMess gRPC', vmess({ net: 'grpc', serviceName: 'service' })],
        ['VMess H2', vmess({ net: 'h2', host: ['h2.example.com', 'alt.example.com'], path: '/h2' })],
        ['VLESS IPv6 Reality xhttp', 'vless://' + uuid + '@[2606:4700::1111]:8443?' + reality + '&flow=xtls-rprx-vision&type=xhttp&host=cover.example.com&path=%2Fa&mode=stream-one&allowInsecure=1&encryption=example-encryption&udp=0#Asia'],
        ['Trojan Reality gRPC', 'trojan://p%40ss%3Fword@' + endpoint + '?' + reality + '&type=grpc&serviceName=test%2Fa&flow=sample&allowInsecure=1#Trojan'],
        ['Hysteria2', 'hysteria2://pass%23word@' + endpoint + '?sni=secure.example.com&insecure=1&obfs=salamander&obfs-password=mask%3Bvalue&mport=4000-4002%2C4443&hop-interval=30&up=13&down=42&alpn=h3%2Ch2&fast-open=1#Hy2'],
        ['TUIC', 'tuic://' + uuid + ':p%40ss%3Fword@' + endpoint + '?sni=secure.example.com&alpn=h3%2Ch2&congestion_control=bbr&udp-relay-mode=quic&disable-sni=0&allow_insecure=1&zero-rtt=1&reduce-rtt=0&fast-open=1#TUIC'],
        ['AnyTLS', 'anytls://pass%3Aword@' + endpoint + '?sni=secure.example.com&insecure=1&alpn=h2%2Chttp%2F1.1&fp=safari&udp=0&idle-session-check-interval=30&idle-session-timeout=90&min-idle-session=2#AnyTLS']
    ];

    it.each(cases)('round-trips %s', async (_, input) => {
        const node = await ProxyParser.parse(input, 'clash.meta');
        expect(node).toEqual(expect.objectContaining({ server_port: expect.any(Number) }));
        const { uri, warning } = nodeToShareUri(node);
        expect(uri).toEqual(expect.any(String));
        expect(warning).toBeUndefined();
        await expect(ProxyParser.parse(uri, 'clash.meta')).resolves.toEqual(node);
    });

    it('keeps VLESS packet encoding and ALPN in the URI query', () => {
        const { uri } = nodeToShareUri({
            type: 'vless', tag: 'Node', server: '[2606:4700::1111]', server_port: 443,
            uuid, packet_encoding: 'xudp', alpn: ['h2', 'http/1.1']
        });
        expect(uri).toContain('@[2606:4700::1111]:443');
        const params = new URL(uri).searchParams;
        expect(params.get('packetEncoding')).toBe('xudp');
        expect(params.get('alpn')).toBe('h2,http/1.1');
        expect(params.get('encryption')).toBe('none');
    });

    it('skips invalid and unsupported nodes with credential-free warnings', () => {
        const result = encodeNodesToBase64Uri([ss, { ...ss, type: 'other' }, { ...ss, server_port: 0 }]);
        expect(result).toEqual({
            content: encodeBase64(ssUri), rawLines: [ssUri], convertedCount: 1, skippedCount: 2,
            warnings: ['Unsupported or invalid node type: other', 'Unsupported or invalid node type: shadowsocks']
        });
        expect(encodeNodesToBase64Uri([]).content).toBe('');
    });
});

describe('output formats', () => {
    const anytls = { tag: 'AnyTLS', type: 'anytls', server, server_port: 443, password: 'example-password' };
    it.each([
        ['Clash Verge', 'mihomo'], ['Clash-Verge/2.1.0', 'mihomo'], ['Clash.Meta/1.2', 'mihomo'],
        ['Mihomo/1.1', 'mihomo'], ['Stash/1.1', 'mihomo'], ['Shadowrocket/2.0', 'base64'], ['v2rayN/7.0', 'base64'],
        ['Sing-Box/1.14', 'singbox'], ['SFI/1.0', 'singbox'], ['SFA/1.0', 'singbox'],
        ['SFM/1.0', 'singbox'], ['SFT/1.0', 'singbox'], ['Hiddify/1.0', 'singbox'],
        ['Surge/5.0', 'surge'], ['Mozilla/5.0 Firefox/100.0', null]
    ])('detects the UA %s', (ua, target) => {
        expect(detectClientTarget(ua)).toBe(target);
        expect(resolveOutputTarget({ userAgent: ua })).toBe(target ?? 'mihomo');
    });

    it('normalizes aliases and applies target precedence', () => {
        expect(normalizeTarget(' CLAsh-MetA ')).toBe('mihomo');
        expect(normalizeTarget('V2Ray')).toBe('base64');
        expect(normalizeTarget('Sing-Box')).toBe('singbox');
        expect(normalizeTarget('')).toBeNull();
        expect(resolveOutputTarget({ explicitTarget: 'xray', userAgent: 'Surge/5.0' })).toBe('base64');
        expect(resolveOutputTarget({ userAgent: 'Surge/5.0', collectionDefault: 'clash' })).toBe('surge');
        expect(resolveOutputTarget({ collectionDefault: 'sing-box', systemDefault: 'surge' })).toBe('singbox');
        expect(resolveOutputTarget({ collectionDefault: null, systemDefault: 'surge' })).toBe('surge');
        expect(() => normalizeTarget('unsupported')).toThrow(InvalidPayloadError);
        expect(new InvalidPayloadError().status).toBe(400);
    });

    it('emits Mihomo provider and standalone YAML with only the intended sections', () => {
        const full = formatSubscriptionOutput([ss]);
        const proxies = [{ name: 'Node', type: 'ss', server, port: 443, cipher: ss.method, password: ss.password, udp: true }];
        expect(full).toMatchObject({
            target: 'mihomo', contentType: 'text/yaml; charset=utf-8', convertedCount: 1, skippedCount: 0, warnings: []
        });
        expect(yaml.load(full.body)).toEqual({
            proxies, 'proxy-groups': [{ name: 'PROXY', type: 'select', 'include-all': true }], rules: ['MATCH,PROXY']
        });
        expect(yaml.load(formatSubscriptionOutput([ss], { target: 'clash', mode: 'provider' }).body)).toEqual({ proxies });
        expect(() => formatSubscriptionOutput([ss], { target: 'surge', mode: 'provider' })).toThrow('provider mode is only supported');
        expect(() => formatSubscriptionOutput([ss], { mode: 'custom' })).toThrow('Unsupported mode');
        expect(() => formatSubscriptionOutput([ss], { target: 'invalid' })).toThrow('Unsupported target format');
    });

    it('emits the minimal Sing-Box config for the UA tier and accounts for dropped nodes', () => {
        const legacy = formatSubscriptionOutput([ss, anytls], { target: 'singbox', userAgent: 'sing-box/1.11.9' });
        expect(legacy).toMatchObject({
            contentType: 'application/json; charset=utf-8', convertedCount: 1, skippedCount: 1,
            warnings: ['Node 2: unsupported by singbox']
        });
        expect(JSON.parse(legacy.body)).toEqual({
            outbounds: [{ type: 'selector', tag: 'PROXY', outbounds: ['Node'] }, ss, { type: 'direct', tag: 'direct' }],
            route: { final: 'PROXY' }
        });
        for (const userAgent of ['sing-box/1.12', 'sing-box/1.14.2']) {
            expect(formatSubscriptionOutput([ss, anytls], { target: 'singbox', userAgent }).convertedCount).toBe(2);
        }
    });

    it('emits Surge and Base64 and rejects an empty compatible set', () => {
        const surge = formatSubscriptionOutput([ss, anytls], { target: 'surge' });
        expect(surge).toEqual({
            body: '[Proxy]\nNode = ss, ' + server + ', 443, encrypt-method=aes-128-gcm, password=sample:password\n\n[Proxy Group]\nPROXY = select, Node\n\n[Rule]\nFINAL,PROXY\n',
            target: 'surge', contentType: 'text/plain; charset=utf-8', convertedCount: 1, skippedCount: 1,
            warnings: ['Node 2: unsupported by surge']
        });
        const base64 = formatSubscriptionOutput([ss], { target: 'xray' });
        expect(base64).toMatchObject({ target: 'base64', contentType: 'text/plain; charset=utf-8', convertedCount: 1, skippedCount: 0 });
        expect(decodeBase64(base64.body)).toBe(ssUri);
        expect(() => formatSubscriptionOutput([anytls], { target: 'surge' })).toThrow(InvalidConfigError);
        expect(() => formatSubscriptionOutput([], { target: 'base64' })).toThrow('No compatible proxy nodes for target base64');
    });
});
