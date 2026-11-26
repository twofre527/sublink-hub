#!/usr/bin/env node
import { webcrypto } from 'node:crypto';
import { stdin, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { hashPassword, randomBase64Url } from '../src/hub/crypto.js';

globalThis.crypto ??= webcrypto;

async function readPassword() {
    if (stdin.isTTY) {
        // A silent terminal output keeps the password out of the visible prompt.
        const output = new Writable({ write(chunk, encoding, done) { done(); } });
        const prompt = createInterface({ input: stdin, output, terminal: true });
        stderr.write('Password: ');
        try {
            return await prompt.question('');
        } finally {
            prompt.close();
            stderr.write('\n');
        }
    }
    stdin.setEncoding('utf8');
    let password = '';
    for await (const chunk of stdin) password += chunk;
    return password.replace(/\r?\n$/, '');
}

try {
    const { values } = parseArgs({ options: { 'gen-key': { type: 'boolean' } } });
    console.log(values['gen-key'] ? randomBase64Url(32) : await hashPassword(await readPassword()));
} catch (error) {
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
