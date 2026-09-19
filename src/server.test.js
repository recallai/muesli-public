const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');

process.env.RECALLAI_API_KEY = '';

const app = require('./server');

test('returns an error when the Recall API key is missing', async (t) => {
    const server = app.listen(0);
    t.after(
        () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    );
    await once(server, 'listening');

    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/start-recording`);

    assert.deepEqual(await response.json(), {
        status: 'error',
        message: 'RECALLAI_API_KEY is missing',
    });
});
