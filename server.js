'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { validateDataset, dashboard, completeActivity } = require('./lib/domain');
const storage = path.join(__dirname, 'data');
const stateFile = path.join(storage, 'state.json');
const demo = () => validateDataset(JSON.parse(fs.readFileSync(path.join(__dirname, 'demo.json'), 'utf8')));
let state = fs.existsSync(stateFile) ? validateDataset(JSON.parse(fs.readFileSync(stateFile, 'utf8'))) : demo();
let isDemo = fs.existsSync(stateFile) ? state._demo === true : true;

function save(next, demoMode) {
  next._demo = demoMode;
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(next, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
  state = next;
  isDemo = demoMode;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) { reject(new Error('Максимальный размер JSON — 2 МБ.')); return; }
      text += chunk;
    });
    req.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error('Некорректный JSON.')); } });
    req.on('error', reject);
  });
}

const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const server = http.createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, { skills: state.skills, grades: state.grades, activities: state.activities, employees: dashboard(state), demo: isDemo });
    if (req.method === 'POST') {
      // Browser mutations must originate from this server and use JSON.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Недопустимый источник запроса.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Ожидается application/json.' });
      const input = await body(req);
      if (url.pathname === '/api/complete') {
        const next = structuredClone(state);
        const changes = completeActivity(next, input.employee_id, input.activity_id);
        save(next, isDemo);
        return send(200, { changes });
      }
      if (url.pathname === '/api/import') {
        // Validation finishes before the existing dataset is replaced.
        const next = validateDataset(input);
        save(next, false);
        return send(200, { imported: next.employees.length });
      }
      if (url.pathname === '/api/reset') { save(demo(), true); return send(200, { ok: true }); }
    }
    if (req.method === 'GET' && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
    }
    send(404, { error: 'Не найдено.' });
  } catch (error) {
    send(400, { error: error.message });
  }
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => console.log(`Career Quest: http://127.0.0.1:${port}`));
}
module.exports = { server };
