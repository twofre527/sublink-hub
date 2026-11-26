function normalizeValue(value) {
    if (Array.isArray(value)) {
        return value.filter(item => item !== undefined).map(normalizeValue);
    }
    if (value === null || typeof value !== 'object') return value;

    return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
        const field = value[key];
        if (key === 'tag' || key === 'name' || key.startsWith('_') || field === undefined) return [];
        if (key === 'server') return [[key, String(field).trim().toLowerCase()]];
        if (key === 'server_port') return [[key, Number(field)]];
        return [[key, normalizeValue(field)]];
    }));
}

export function computeNodeFingerprint(node) {
    return JSON.stringify(normalizeValue(node));
}

export function mergeSourceNodes(sourceEntries, { prefixEnabled = true, deduplicate = true } = {}) {
    const nodes = [];
    const seenFingerprints = new Set();
    const usedNames = new Set();
    let totalBeforeDedup = 0;
    let dedupedCount = 0;

    for (const { alias, nodes: sourceNodes } of sourceEntries) {
        totalBeforeDedup += sourceNodes.length;
        for (const node of sourceNodes) {
            if (deduplicate) {
                const fingerprint = computeNodeFingerprint(node);
                if (seenFingerprints.has(fingerprint)) {
                    dedupedCount++;
                    continue;
                }
                seenFingerprints.add(fingerprint);
            }

            const { name, ...proxy } = node;
            const baseName = proxy.tag || name || (proxy.server ? `${proxy.server}:${proxy.server_port}` : 'Node');
            const candidate = prefixEnabled && alias ? `${alias} | ${baseName}` : baseName;
            let tag = candidate;
            for (let suffix = 2; usedNames.has(tag); suffix++) {
                tag = `${candidate} (${suffix})`;
            }
            usedNames.add(tag);
            nodes.push({ ...proxy, tag });
        }
    }

    return { nodes, totalBeforeDedup, dedupedCount };
}
