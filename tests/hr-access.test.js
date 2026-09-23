const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('HR startup code survives CRLF edits and never resets the account if the saved code is unavailable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-quest-hr-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['server.js', 'demo.json', 'lib']) {
    fs.cpSync(path.join(__dirname, '..', name), path.join(root, name), { recursive: true });
  }
  const { createApp } = require(path.join(root, 'server.js'));
  const storage = path.join(root, 'private');
  const first = createApp({ storage });
  const password = first.bootstrapPassword;
  assert.equal(typeof password, 'string');
  assert.ok(password.length > 0);
  const accessFile = path.join(storage, 'hr-access.txt');
  const authFile = path.join(storage, 'auth.json');
  const originalAuth = fs.readFileSync(authFile, 'utf8');

  fs.writeFileSync(accessFile, `Login: hr\r\nPassword: ${password}\r\n`);
  assert.equal(createApp({ storage }).bootstrapPassword, password);
  for (const content of ['Login: hr\nPassword: stale-code\n', 'malformed file', `Prefix Password: ${password}\n`]) {
    fs.writeFileSync(accessFile, content);
    assert.equal(createApp({ storage }).bootstrapPassword, undefined);
    assert.equal(fs.readFileSync(authFile, 'utf8'), originalAuth);
  }
  fs.unlinkSync(accessFile);
  assert.equal(createApp({ storage }).bootstrapPassword, undefined);
  assert.equal(fs.readFileSync(authFile, 'utf8'), originalAuth);
});
