const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDataset, recommend, completeActivity, dashboard } = require('../lib/domain');
const fixture = () => structuredClone(require('../demo.json'));

test('valid demo recommendations explain actual gap coverage and exclude prerequisites', () => {
  const data = validateDataset(fixture());
  const list = recommend(data, data.employees[0]);
  assert.equal(list.length, 3);
  assert.equal(list[0].impact, 2);
  assert.ok(!list.some(r => r.activity.id === 'project'));
  for (const rec of list) assert.equal(rec.impact, rec.reasons.reduce((sum, r) => sum + r.covered, 0));
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
  assert.equal(recs[0].impact, 1);
});
test('legacy import also enforces the dataset skill scale and valid goals', () => {
  const data = fixture();
  data.employees[0].skills.python = 6;
  assert.throws(() => validateDataset(data), /0–5/);
  data.employees[0].skills.python = 1;
  data.employees[0].career_goal = { target_role: 'Missing', target_grade: 'Middle' };
  assert.throws(() => validateDataset(data), /карьерная цель/);
  assert.equal(dashboard(fixture())[2].readiness, null);
});

const careerFixture = () => {
  const data = fixture();
  for (const grade of data.grades) grade.role = 'Аналитик';
  data.grades.find(g => g.id === 'senior').next_grade = 'analyst-lead';
  data.grades.push(
    { id: 'analyst-lead', name: 'Lead', role: 'Аналитик', next_grade: null, requirements: { python: 5, sql: 5, communication: 5 } },
    { id: 'developer-middle', name: 'Middle', role: 'Разработчик', next_grade: null, requirements: { python: 4, sql: 2, communication: 3 }, critical_skills: ['python'] }
  );
  for (const employee of data.employees) employee.role = 'Аналитик';
  return data;
};

test('same-role career goal determines requirements instead of the immediate next grade', () => {
  const data = careerFixture();
  data.employees[0].career_goal = { target_role: 'Аналитик', target_grade: 'Senior' };
  const view = dashboard(validateDataset(data))[0];
  assert.equal(view.target_source, 'career_goal');
  assert.equal(view.next_grade.id, 'senior');
  assert.equal(view.gaps.find(g => g.skill === 'python').required, 5);
  assert.equal(view.gaps.find(g => g.skill === 'communication').required, 4);
  assert.equal(view.readiness, 23);
  assert.ok(view.recommendations.length > 0);
  for (const recommendation of view.recommendations) assert.match(recommendation.explanation, /Карьерная цель: Аналитик — Senior/);
});

test('Lead may target a different role while eligibility uses the current role, grade and prerequisites', () => {
  const data = careerFixture();
  const employee = data.employees[0];
  employee.grade = 'analyst-lead';
  employee.career_goal = { target_role: 'Разработчик', target_grade: 'Middle' };
  const python = data.activities.find(a => a.id === 'python-lab');
  python.target_roles = ['Аналитик'];
  python.target_grades = ['Lead'];
  data.activities.find(a => a.id === 'sql-lab').target_roles = ['Разработчик'];
  data.activities.find(a => a.id === 'team-demo').target_grades = ['Middle'];
  const view = dashboard(validateDataset(data))[0];
  assert.equal(view.target_source, 'career_goal');
  assert.equal(view.next_grade.id, 'developer-middle');
  assert.equal(view.gaps.find(g => g.skill === 'python').required, 4);
  assert.equal(view.gaps.find(g => g.skill === 'python').critical, true);
  assert.deepEqual(view.recommendations.map(r => r.activity.id), ['python-lab']);
  assert.equal(view.recommendations[0].impact, 4);
  assert.match(view.recommendations[0].explanation, /Карьерная цель: Разработчик — Middle/);
  assert.throws(() => completeActivity(data, employee.id, 'sql-lab'), /входные требования/);
  assert.throws(() => completeActivity(data, employee.id, 'team-demo'), /входные требования/);
  assert.throws(() => completeActivity(data, employee.id, 'project'), /входные требования/);
});

test('absent or null career goal follows next grade and terminal grade has no target', () => {
  const data = careerFixture();
  data.employees[1].career_goal = null;
  data.employees[2].grade = 'analyst-lead';
  const views = dashboard(validateDataset(data));
  assert.equal(views[0].target_source, 'next_grade');
  assert.equal(views[0].next_grade.id, 'middle');
  assert.equal(views[1].target_source, 'next_grade');
  assert.equal(views[1].next_grade.id, 'senior');
  assert.equal(views[2].target_source, 'not_set');
  assert.equal(views[2].next_grade, null);
  assert.deepEqual(views[2].gaps, []);
  assert.deepEqual(views[2].recommendations, []);
});

test('unresolved explicit career goal is not silently replaced with another target', () => {
  const data = careerFixture();
  data.employees[0].career_goal = { target_role: 'Неизвестная роль', target_grade: 'Middle' };
  const view = dashboard(data)[0];
  assert.equal(view.next_grade, null);
  assert.equal(view.target_source, 'not_set');
  assert.deepEqual(view.recommendations, []);
});

test('in-progress activities cannot be recommended or completed as a new record, including repeatable activities', () => {
  for (const repeatable of [false, true]) {
    const data = fixture();
    data.activities.find(a => a.id === 'python-lab').repeatable = repeatable;
    const employee = data.employees[0];
    employee.history.push({ activity_id: 'python-lab', completed_at: '2026-09-01T10:00:00Z', status: 'in_progress' });
    assert.ok(!recommend(data, employee).some(r => r.activity.id === 'python-lab'));
    const before = structuredClone(employee);
    assert.throws(() => completeActivity(data, employee.id, 'python-lab'), /находится в процессе/);
    assert.deepEqual(employee, before);
  }
});
