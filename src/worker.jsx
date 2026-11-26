/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { createApp } from './app/createApp.jsx';
import { createCloudflareRuntime } from './runtime/cloudflare.js';

const apps = new WeakMap();

function getApp(env) {
    if (!env || typeof env !== 'object') {
        return createApp(createCloudflareRuntime(env));
    }
    if (!apps.has(env)) apps.set(env, createApp(createCloudflareRuntime(env)));
    return apps.get(env);
}

export default {
    fetch(request, env, ctx) {
        const app = getApp(env);
        return app.fetch(request, env, ctx);
    }
};
