const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboard, completeActivity, chooseTask } = require('../lib/domain');
const { completePractice } = require('../lib/practice');
const fixture = () => structuredClone(require('../demo.json'));
const reflection = 'Подготовлен учебный пример, проверен граничный случай и записаны ограничения.';
const own = data => dashboard(data)[0];

test('practice starts only at 0–1 catalog recommendations and excludes missing or met targets', () => {
  const data = fixture();
  assert.equal(own(data).practice.tasks.length, 0);
  data.activities = data.activities.slice(0, 2);
  assert.equal(own(data).practice.tasks.length, 0);
  data.activities = data.activities.slice(0, 1);
  assert.equal(own(data).practice.tasks.length, 2);
  data.activities = [];
  assert.equal(own(data).practice.tasks.length, 3);
  const first = own(data).practice.tasks;
  assert.deepEqual(own(data).practice.tasks, first);
  assert.equal(new Set(first.map(t => t.skill)).size, 3);
  for (const task of first) {
    assert.ok(task.current < task.required);
    assert.equal(task.reasons.length, 4);
    assert.equal(task.steps.length, 3);
  }
  data.employees[0].skills = { python: 3, sql: 3, communication: 2 };
  assert.equal(own(data).practice.reason, 'target_met');
  data.employees[0].grade = 'senior';
  assert.equal(own(data).practice.reason, 'no_target');
});

test('catalog completion automatically replenishes the route; practice preserves official skills and history', () => {
  const data = fixture();
  data.activities = data.activities.slice(0, 2);
  assert.equal(own(data).practice.tasks.length, 0);
  completeActivity(data, 'demo-1', 'python-lab');
  let employee = own(data);
  assert.equal(employee.recommendations.length, 1);
  assert.ok(employee.practice.tasks.length > 0);
  const first = employee.practice.tasks[0];
  chooseTask(data, employee, 'practice', first.id);
  const skills = structuredClone(employee.skills);
  const history = structuredClone(employee.history);
  const readiness = employee.readiness;
  completePractice(data, own(data), first.id, reflection);
  employee = own(data);
  assert.equal(employee.selected_task, null);
  assert.deepEqual(employee.skills, skills);
  assert.deepEqual(employee.history, history);
  assert.equal(employee.readiness, readiness);
  assert.equal(employee.practice.completed.length, 1);
  assert.ok(!employee.practice.tasks.some(t => t.id === first.id));
  assert.ok(employee.practice.tasks.some(t => t.skill === first.skill && t.phase === 2));
  assert.throws(() => completePractice(data, employee, first.id, reflection), /уже/);
});

test('practice exhausts meaningful stages and rejects fabricated, outdated and empty submissions', () => {
  const data = fixture();
  data.activities = [];
  data.employees[0].skills = { python: 2, sql: 3, communication: 2 };
  const first = own(data).practice.tasks[0];
  assert.throws(() => completePractice(data, own(data), first.id, 'готово'), /20 до 2000/);
  assert.throws(() => completePractice(data, own(data), 'fake', reflection), /не актуально/);
  assert.throws(() => completePractice(data, dashboard(data)[1], first.id, reflection), /не актуально/);
  for (let phase = 1; phase <= 3; phase++) {
    const employee = own(data);
    assert.equal(employee.practice.tasks[0].phase, phase);
    completePractice(data, employee, employee.practice.tasks[0].id, reflection);
  }
  assert.equal(own(data).practice.reason, 'practice_exhausted');
  assert.equal(own(data).practice.tasks.length, 0);
  const stale = fixture();
  stale.activities = [];
  const outdated = own(stale).practice.tasks[0];
  stale.employees[0].skills[outdated.skill] = outdated.required;
  assert.throws(() => completePractice(stale, own(stale), outdated.id, reflection), /не актуально/);
});

test('employees can choose beyond the top three but cannot bypass prerequisites or retain a completed task', () => {
  const data = fixture();
  data.activities.push({ id: 'extra-task', name: 'Ещё один учебный разбор', effects: [{ skill: 'sql', gain: 1, max_level: 3 }] });
  const employee = own(data);
  assert.equal(employee.recommendations.length, 3);
  assert.equal(employee.available_activities.length, 4);
  const extra = employee.available_activities.find(r => !employee.recommendations.some(top => top.activity.id === r.activity.id));
  chooseTask(data, employee, 'catalog', extra.activity.id);
  assert.equal(own(data).selected_task.task_id, extra.activity.id);
  assert.throws(() => chooseTask(data, own(data), 'catalog', 'project'), /недоступна/);
  assert.equal(own(data).selected_task.task_id, extra.activity.id);
  chooseTask(data, own(data), 'catalog', null);
  assert.equal(own(data).selected_task, null);
  chooseTask(data, own(data), 'catalog', extra.activity.id);
  completeActivity(data, 'demo-1', extra.activity.id);
  assert.equal(own(data).selected_task, null);
  assert.throws(() => chooseTask(data, own(data), 'catalog', extra.activity.id), /недоступна/);
});
