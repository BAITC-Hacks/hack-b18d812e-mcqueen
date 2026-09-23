'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// Synthetic test data only; neither the dataset nor local source configuration is copied.
const fixture = {
  as_of: '2026-09-23',
  skills: [
    { id: 'python', name: 'Python' },
    { id: 'sql', name: 'SQL' },
    { id: 'communication', name: 'Communication' }
  ],
  grades: [
    { id: 'junior', name: 'Junior', next_grade: 'middle', requirements: { python: 1, sql: 1 } },
    { id: 'middle', name: 'Middle', next_grade: 'senior', requirements: { python: 3, sql: 3, communication: 2 } },
    { id: 'senior', name: 'Senior', next_grade: null, requirements: { python: 5, sql: 4, communication: 4 } }
  ],
  activities: [
    { id: 'python-lab', name: 'Python practice', effects: [{ skill: 'python', gain: 2, max_level: 3 }] },
    { id: 'sql-lab', name: 'SQL practice', effects: [{ skill: 'sql', gain: 2, max_level: 4 }] },
    { id: 'team-demo', name: 'Team presentation', effects: [{ skill: 'communication', gain: 1, max_level: 4 }] },
    { id: 'project', name: 'Mentored project', prerequisites: { python: 2 }, effects: [{ skill: 'python', gain: 2, max_level: 5 }, { skill: 'communication', gain: 1, max_level: 3 }] }
  ],
  employees: [{ id: 'demo-1', name: 'Synthetic employee', grade: 'junior', skills: { python: 1, sql: 1, communication: 1 }, history: [] }]
};

test('HTTP development goals appear near completion, update after completion, and persist through restart without promotion or duplicate credits', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-quest-growth-http-'));
  const source = path.join(__dirname, '..');
  for (const name of ['server.js', 'lib', 'public']) fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo.json'), JSON.stringify(fixture));
  const storage = path.join(root, 'private');
  const stateFile = path.join(storage, 'state.json');
  const modulePath = path.join(root, 'server.js');
  let server, base, hrPassword, hrCookie;
  const stop = async () => {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  t.after(async () => {
    await stop();
    // Delete only the exact isolated directory created above.
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('career-quest-growth-http-')) fs.rmSync(root, { recursive: true, force: true });
  });
  const post = (route, body, cookie = hrCookie) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body)
  });
  const login = async credentials => {
    const response = await post('/api/login', credentials, null);
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const start = async () => {
    delete require.cache[require.resolve(modulePath)];
    const previousSource = process.env.CAREER_QUEST_DATASET;
    let app;
    try {
      delete process.env.CAREER_QUEST_DATASET;
      app = require(modulePath).createApp({ storage });
    } finally {
      if (previousSource === undefined) delete process.env.CAREER_QUEST_DATASET;
      else process.env.CAREER_QUEST_DATASET = previousSource;
    }
    hrPassword ||= app.bootstrapPassword;
    server = app.server;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    hrCookie = await login({ login: 'hr', password: hrPassword });
  };
  const employee = async (cookie = hrCookie) => {
    const response = await fetch(base + '/api/state', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return (await response.json()).employees.find(item => item.id === 'demo-1');
  };
  const complete = async (activityId, cookie = hrCookie) => {
    const response = await post('/api/complete', { employee_id: 'demo-1', activity_id: activityId }, cookie);
    assert.equal(response.status, 200);
    return response.json();
  };
  const seniorGoal = view => {
    assert.equal(view.grade, 'junior', 'recommendations must not promote the employee');
    assert.equal(view.next_grade.id, 'middle', 'the current target must remain visible');
    const goal = view.development.goals.find(item => item.type === 'grade' && item.target.id === 'senior');
    assert.ok(goal, 'Senior should be the further development goal');
    return goal;
  };

  await start();
  let view = await employee();
  assert.equal(view.development.stage, 'in_progress');
  assert.equal(view.development.threshold, 80);
  assert.equal(view.development.current_readiness, 37.5);
  assert.deepEqual(view.development.goals, []);

  await complete('python-lab');
  await complete('sql-lab');
  view = await employee();
  assert.equal(view.development.stage, 'almost_complete');
  assert.equal(view.development.current_readiness, 87.5);
  assert.ok(seniorGoal(view).recommendations.some(item => item.activity.id === 'project'));
  assert.ok(view.recommendations.some(item => item.activity.id === 'team-demo'), 'the unfinished current goal should still have recommendations');

  await complete('team-demo');
  view = await employee();
  assert.equal(view.development.stage, 'completed');
  assert.equal(view.development.current_readiness, 100);
  assert.ok(view.development.completed_goals.some(item => item.target.id === 'middle'));
  const beforeProject = seniorGoal(view);
  assert.ok(beforeProject.recommendations.some(item => item.activity.id === 'project'));
  assert.equal(view.recommendations.length, 0);

  // Employees receive the same generated goals and can complete their future activities.
  const accessResponse = await post('/api/access', { employee_id: 'demo-1' });
  assert.equal(accessResponse.status, 200);
  const credentials = await accessResponse.json();
  let employeeCookie = await login(credentials);
  assert.deepEqual((await employee(employeeCookie)).development, view.development);
  assert.equal((await post('/api/plan', { employee_id: 'demo-1', source: 'catalog', task_id: 'project' }, employeeCookie)).status, 200);
  assert.equal((await employee(employeeCookie)).selected_task.task_id, 'project');
  await stop();
  await start();
  employeeCookie = await login(credentials);
  assert.equal((await employee(employeeCookie)).selected_task.task_id, 'project');
  await complete('project', employeeCookie);
  const afterProject = await employee(employeeCookie);
  assert.equal(afterProject.selected_task, null);
  const next = seniorGoal(afterProject);
  assert.ok(next.readiness > beforeProject.readiness);
  assert.deepEqual(afterProject.skills, { python: 5, sql: 3, communication: 3 });
  assert.equal(next.gaps.find(item => item.skill === 'python').gap, 0);
  assert.equal(next.gaps.find(item => item.skill === 'communication').gap, 1);
  assert.equal(afterProject.history.length, 4);
  assert.equal(next.recommendations.some(item => item.activity.id === 'project'), false);

  // Reopening the dashboard must not award credits or otherwise mutate saved skills.
  const savedState = fs.readFileSync(stateFile, 'utf8');
  assert.deepEqual((await employee()).development, afterProject.development);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), savedState);
  await stop();
  await start();
  const renewedEmployeeCookie = await login(credentials);
  const restarted = await employee(renewedEmployeeCookie);
  assert.deepEqual(restarted.skills, afterProject.skills);
  assert.deepEqual(restarted.history, afterProject.history);
  assert.deepEqual(restarted.development, afterProject.development);
  seniorGoal(restarted);
  assert.equal((await post('/api/complete', { employee_id: 'demo-1', activity_id: 'project' }, renewedEmployeeCookie)).status, 400);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), savedState);
  assert.deepEqual((await employee()).skills, afterProject.skills);
});
