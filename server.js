'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { validateDataset, dashboard, completeActivity, hrSummary } = require('./lib/domain');
const { loadDirectory, normalize, mergeProfiles } = require('./lib/dataset');
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const defaultStorage = () => path.join(os.tmpdir(), 'career-quest-' + crypto.createHash('sha256').update(__dirname).digest('hex').slice(0, 12));
function createApp(options = {}) {
  const storage = options.storage || process.env.CAREER_QUEST_STORAGE || defaultStorage();
  fs.mkdirSync(storage, { recursive: true });
  const stateFile = path.join(storage, 'state.json');
  const authFile = path.join(storage, 'auth.json');
  const sourceConfig = path.join(__dirname, 'data', 'source.json');
  const source = options.source || process.env.CAREER_QUEST_DATASET || (fs.existsSync(sourceConfig) ? JSON.parse(fs.readFileSync(sourceConfig, 'utf8')).directory : null);
  const demo = () => ({ ...validateDataset(JSON.parse(fs.readFileSync(path.join(__dirname, 'demo.json'), 'utf8'))), _demo: true });
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : source ? normalize(loadDirectory(source)) : demo();
  const write = (file, data) => { fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  if (!fs.existsSync(stateFile)) write(stateFile, state);
  let accounts = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : {};
  const passwordRecord = (password, role, employeeId) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return { role, employeeId, salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
  };
  let bootstrapPassword;
  if (!accounts.hr) {
    bootstrapPassword = crypto.randomBytes(18).toString('base64url');
    accounts.hr = passwordRecord(bootstrapPassword, 'hr', null);
    write(authFile, accounts);
    fs.writeFileSync(path.join(storage, 'hr-access.txt'), `Login: hr\nPassword: ${bootstrapPassword}\n`, { mode: 0o600 });
  }
  const sessions = new Map();
  const attempts = new Map();
  let cached;
  function snapshot() { if (!cached) { const employees = dashboard(state); cached = { employees, hr: hrSummary(state, employees) }; } return cached; }
  function save(next) { write(stateFile, next); state = next; cached = null; }
  const readBody = req => new Promise((resolve, reject) => {
    let text = '', bytes = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 8 * 1024 * 1024) return reject(new Error('Максимальный размер — 8 МБ.')); text += chunk; });
    req.on('end', () => { try { const data = JSON.parse(text); if (!data || typeof data !== 'object') throw new Error(); resolve(data); } catch { reject(new Error('Некорректный JSON.')); } });
    req.on('error', reject);
  });
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'Только локальный доступ.' });
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [file, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
      }
      let input;
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Недопустимый источник запроса.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Ожидается JSON.' });
        input = await readBody(req);
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const address = req.socket.remoteAddress;
        const attempt = attempts.get(address) || { count: 0, until: Date.now() + 60000 };
        if (Date.now() > attempt.until) { attempt.count = 0; attempt.until = Date.now() + 60000; }
        if (++attempt.count > 20) return send(429, { error: 'Слишком много попыток. Повторите через минуту.' });
        attempts.set(address, attempt);
        const account = Object.hasOwn(accounts, input.login) ? accounts[input.login] : null;
        const validPassword = typeof input.password === 'string' && input.password.length <= 200;
        const calculated = crypto.scryptSync(validPassword ? input.password : '', account?.salt || 'dummy-salt', 32);
        if (!account || !validPassword || !crypto.timingSafeEqual(calculated, Buffer.from(account.hash, 'hex'))) return send(401, { error: 'Неверный логин или код доступа.' });
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { login: input.login, ...account, expires: Date.now() + 8 * 3600000 });
        res.setHeader('Set-Cookie', `cq_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(200, { role: account.role });
      }
      const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('cq_session='))?.slice(11);
      const session = sessions.get(token);
      if (!session || session.expires < Date.now()) { sessions.delete(token); return send(401, { error: 'Войдите в приложение.' }); }
      const isHR = session.role === 'hr';
      if (req.method === 'POST' && url.pathname === '/api/logout') { sessions.delete(token); res.setHeader('Set-Cookie', 'cq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(200, { ok: true }); }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const view = snapshot();
        return send(200, { role: session.role, demo: !!state._demo, as_of: state.as_of, model: 'Локальная Bayesian-модель завершения', skills: state.skills, grades: state.grades, activities: state.activities,
          employees: isHR ? view.employees : view.employees.filter(e => e.id === session.employeeId), ...(isHR ? { hr: view.hr, warnings: state.warnings?.length || 0 } : {}) });
      }
      if (req.method === 'POST' && url.pathname === '/api/complete') {
        if (!isHR && input.employee_id !== session.employeeId) return send(403, { error: 'Нет доступа к другому сотруднику.' });
        const next = structuredClone(state);
        const changes = completeActivity(next, input.employee_id, input.activity_id);
        save(next); return send(200, { changes });
      }
      if (!isHR) return send(403, { error: 'Доступно только HR.' });
      if (req.method === 'POST' && url.pathname === '/api/access') {
        if (!state.employees.some(e => e.id === input.employee_id)) return send(400, { error: 'Сотрудник не найден.' });
        const login = 'employee-' + input.employee_id;
        const password = crypto.randomBytes(16).toString('base64url');
        accounts[login] = passwordRecord(password, 'employee', input.employee_id); write(authFile, accounts);
        for (const [key, value] of sessions) if (value.login === login) sessions.delete(key);
        return send(200, { login, password });
      }
      if (req.method === 'POST' && url.pathname === '/api/import') {
        let next;
        if (input.mode === 'profiles') next = mergeProfiles(state, input);
        else if (input.events && input.skills && input.employees) next = normalize(input);
        else next = validateDataset(input);
        // Reject datasets that cannot produce a view before replacing saved state.
        dashboard(next);
        next._demo = false; save(next);
        // Imports may replace identities; revoke all employee sessions and credentials.
        accounts = { hr: accounts.hr }; write(authFile, accounts);
        for (const [key, value] of sessions) if (value.role !== 'hr') sessions.delete(key);
        return send(200, { imported: next.employees.length, warnings: next.warnings?.length || 0 });
      }
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        save(source ? normalize(loadDirectory(source)) : demo());
        accounts = { hr: accounts.hr }; write(authFile, accounts);
        for (const [key, value] of sessions) if (value.role !== 'hr') sessions.delete(key);
        return send(200, { ok: true });
      }
      send(404, { error: 'Не найдено.' });
    } catch (error) { send(400, { error: error.message }); }
  });
  return { server, storage, bootstrapPassword };
}
if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Career Quest: http://127.0.0.1:${port}\nЛокальные данные: ${app.storage}\nКод HR: ${path.join(app.storage, 'hr-access.txt')}`);
  });
}
module.exports = { createApp, defaultStorage };
