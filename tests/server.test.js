const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

test('HTTP flow serves UI, completes, imports atomically and survives restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-quest-test-'));
  const source = path.join(__dirname, '..');
  for (const name of ['server.js', 'demo.json', 'lib', 'public']) fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
  const modulePath = path.join(root, 'server.js');
  let server;
  const start = async () => {
    delete require.cache[require.resolve(modulePath)];
    server = require(modulePath).server;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  try {
    let base = await start();
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const asset of ['/', '/app.js', '/style.css']) assert.equal((await fetch(base + asset)).status, 200);
    let state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.employees.length, 3);
    assert.equal((await post('/api/complete', { employee_id: 'demo-1', activity_id: 'python-lab' })).status, 200);
    assert.equal((await post('/api/complete', { employee_id: 'demo-1', activity_id: 'python-lab' })).status, 400);
    assert.equal((await post('/api/import', { employees: [] })).status, 400);
    await stop();
    base = await start();
    state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.employees[0].skills.python, 3);
    assert.equal(state.employees[0].history.length, 1);
    const imported = JSON.parse(fs.readFileSync(path.join(root, 'demo.json'), 'utf8'));
    imported.employees[0].name = 'Проверочный профиль';
    assert.equal((await post('/api/import', imported)).status, 200);
    state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.demo, false);
    assert.equal(state.employees[0].name, 'Проверочный профиль');
    assert.equal((await post('/api/reset', {})).status, 200);
    state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.demo, true);
    assert.equal(state.employees[0].history.length, 0);
  } finally {
    if (server?.listening) await stop();
    // mkdtemp creates this exact isolated directory under the OS temp folder.
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('career-quest-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
});
