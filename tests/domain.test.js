const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDataset, recommend, completeActivity, dashboard } = require('../lib/domain');
const fixture = () => structuredClone(require('../demo.json'));

test('valid demo recommendations explain actual gap coverage and exclude prerequisites', () => {
  const data = validateDataset(fixture());
  const list = recommend(data, data.employees[0]);
  assert.equal(list.length, 3);
  assert.equal(list[0].score, 2);
  assert.ok(!list.some(r => r.activity.id === 'project'));
  for (const rec of list) assert.equal(rec.score, rec.reasons.reduce((sum, r) => sum + r.covered, 0));
});
test('completion caps skills, records history and cannot be repeated', () => {
  const data = fixture();
  data.employees[0].skills.python = 2;
  assert.equal(completeActivity(data, 'demo-1', 'python-lab')[0].after, 3);
  assert.equal(data.employees[0].history.length, 1);
  assert.ok(!recommend(data, data.employees[0]).some(r => r.activity.id === 'python-lab'));
  assert.throws(() => completeActivity(data, 'demo-1', 'python-lab'), /уже завершена/);
});
test('activity cap never reduces skills; prerequisites are enforced on completion', () => {
  const data = fixture();
  assert.throws(() => completeActivity(data, 'demo-1', 'project'), /входные требования/);
  data.employees[0].skills.python = 5;
  completeActivity(data, 'demo-1', 'python-lab');
  assert.equal(data.employees[0].skills.python, 5);
});
test('terminal and ready employees receive no irrelevant recommendations', () => {
  const data = fixture();
  assert.deepEqual(recommend(data, data.employees[2]), []);
  data.employees[0].skills = { python: 3, sql: 3, communication: 2 };
  assert.deepEqual(recommend(data, data.employees[0]), []);
  assert.equal(dashboard(data)[0].readiness, 100);
});
test('import rejects unknown skills, duplicate ids, invalid history and grade cycles', () => {
  const badSkill = fixture(); badSkill.employees[0].skills.unknown = 2;
  assert.throws(() => validateDataset(badSkill), /неизвестный навык/);
  const badId = fixture(); badId.employees.push(structuredClone(badId.employees[0]));
  assert.throws(() => validateDataset(badId), /повторный id/);
  const badHistory = fixture(); badHistory.employees[0].history.push({ activity_id: 'missing', completed_at: 'yesterday' });
  assert.throws(() => validateDataset(badHistory), /history/);
  const cycle = fixture(); cycle.grades[2].next_grade = 'junior';
  assert.throws(() => validateDataset(cycle), /Цикл/);
});
test('ranking counts only the gap and ignores exhausted activity caps', () => {
  const data = fixture();
  data.employees[0].skills = { python: 4, sql: 2, communication: 2 };
  const recs = recommend(data, data.employees[0]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].activity.id, 'sql-lab');
  assert.equal(recs[0].score, 1);
});
