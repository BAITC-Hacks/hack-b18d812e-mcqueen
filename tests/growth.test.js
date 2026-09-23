'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { developmentPlan, dashboard, completeActivity, recommend, validateDataset, hrSummary } = require('../lib/domain');
const { normalize, mergeProfiles } = require('../lib/dataset');

function fixture() {
  const data = structuredClone(require('../demo.json'));
  data.as_of = '2026-10-01';
  for (const grade of data.grades) grade.role = 'Engineer';
  for (const employee of data.employees) employee.role = 'Engineer';
  data.grades.find(g => g.id === 'senior').next_grade = 'lead';
  data.grades.push({ id: 'lead', name: 'Lead', role: 'Engineer', next_grade: null, requirements: { python: 5, sql: 5, communication: 5 } });
  data.activities.push(
    { id: 'python-advanced', name: 'Advanced Python', effects: [{ skill: 'python', gain: 1, max_level: 5 }] },
    { id: 'sql-advanced', name: 'Advanced SQL', effects: [{ skill: 'sql', gain: 1, max_level: 5 }] },
    { id: 'communication-advanced', name: 'Advanced communication', effects: [{ skill: 'communication', gain: 1, max_level: 5 }] }
  );
  return data;
}

test('new goals appear at 80% without replacing unfinished current recommendations', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.skills = { python: 3, sql: 1, communication: 2 };
  assert.equal(developmentPlan(data, employee).stage, 'in_progress');
  assert.deepEqual(developmentPlan(data, employee).goals, []);
  employee.skills.sql = 2;
  const before = structuredClone(data);
  const view = dashboard(data)[0];
  assert.equal(view.development.stage, 'almost_complete');
  assert.equal(view.development.current_readiness, 87.5);
  assert.equal(view.development.threshold, 80);
  assert.equal(view.next_grade.id, 'middle');
  assert.equal(view.development.goals[0].target.id, 'senior');
  assert.deepEqual(view.recommendations, recommend(data, employee));
  assert.ok(view.recommendations.some(r => r.activity.id === 'sql-lab'));
  assert.deepEqual(data, before);
});

test('threshold compares exact coverage, not a rounded display percentage', () => {
  const data = fixture();
  data.skills = Array.from({ length: 10 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${i}` }));
  const requirements = Object.fromEntries(data.skills.map((s, i) => [s.id, i === 9 ? 4 : 5]));
  data.grades.find(g => g.id === 'middle').requirements = requirements;
  data.grades.find(g => g.id === 'senior').requirements = requirements;
  const employee = data.employees[0];
  employee.skills = Object.fromEntries(data.skills.map((s, i) => [s.id, i < 7 ? 5 : i === 7 ? 4 : 0]));
  const plan = developmentPlan(data, employee);
  assert.equal(Math.round(plan.current_readiness), 80);
  assert.equal(plan.stage, 'in_progress');
  assert.deepEqual(plan.goals, []);
  data.grades.find(g => g.id === 'middle').requirements['skill-9'] = 5;
  employee.skills['skill-7'] = 5;
  assert.equal(developmentPlan(data, employee).current_readiness, 80);
  assert.equal(developmentPlan(data, employee).stage, 'almost_complete');
});

test('completion derives the next goal without promotion and skips satisfied future grades', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.skills = { python: 3, sql: 3, communication: 2 };
  const completed = developmentPlan(data, employee);
  assert.equal(completed.stage, 'completed');
  assert.equal(completed.current_readiness, 100);
  assert.equal(completed.goals[0].id, 'grade:senior');
  assert.ok(completed.completed_goals.some(g => g.target.id === 'middle'));
  employee.skills = { python: 5, sql: 4, communication: 4 };
  const later = developmentPlan(data, employee);
  assert.equal(later.goals[0].id, 'grade:lead');
  assert.deepEqual(later.completed_goals.map(g => g.target.id), ['middle', 'senior']);
  assert.equal(employee.grade, 'junior');
  assert.equal(employee.career_goal, undefined);
  assert.equal(dashboard(data)[0].next_grade.id, 'middle');
  assert.deepEqual(recommend(data, employee), []);
});

test('future recommendations use their own gaps, critical weights and real activity caps', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.skills = { python: 3, sql: 3, communication: 2 };
  data.grades.find(g => g.id === 'senior').critical_skills = ['python'];
  employee.history.push({ activity_id: 'communication-advanced', completed_at: '2026-09-01', status: 'no_show' });
  const goal = developmentPlan(data, employee).goals[0];
  assert.ok(goal.recommendations.length > 0 && goal.recommendations.length <= 3);
  assert.ok(!goal.recommendations.some(r => r.activity.id === 'python-lab'));
  for (const rec of goal.recommendations) {
    assert.equal(rec.goal_id, goal.id);
    assert.match(rec.explanation, /Дальнейшая цель: Engineer — Senior/);
    assert.equal(rec.impact, rec.reasons.reduce((sum, r) => sum + r.covered * (r.critical ? 2 : 1), 0));
    assert.ok(rec.behavior.failures > 0);
    for (const reason of rec.reasons) {
      assert.equal(reason.required, data.grades.find(g => g.id === 'senior').requirements[reason.skill]);
      assert.ok(reason.covered <= reason.gain);
      assert.ok(reason.after <= reason.max_level);
    }
  }
});

test('cross-role career goals follow the chosen role chain while eligibility stays on the current role and grade', () => {
  const data = fixture();
  data.grades.push(
    { id: 'designer-middle', role: 'Designer', name: 'Middle', next_grade: 'designer-senior', requirements: { communication: 2 } },
    { id: 'designer-senior', role: 'Designer', name: 'Senior', next_grade: null, requirements: { communication: 4 } }
  );
  const employee = data.employees[0];
  employee.skills.communication = 2;
  employee.career_goal = { target_role: 'Designer', target_grade: 'Middle' };
  data.activities = [
    { id: 'current-access', name: 'Current employee access', target_roles: ['Engineer'], target_grades: ['Junior'], effects: [{ skill: 'communication', gain: 1, max_level: 5 }] },
    { id: 'future-role', name: 'Future role only', target_roles: ['Designer'], effects: [{ skill: 'communication', gain: 1, max_level: 5 }] },
    { id: 'future-grade', name: 'Future grade only', target_grades: ['Senior'], effects: [{ skill: 'communication', gain: 1, max_level: 5 }] }
  ];
  const plan = developmentPlan(data, employee);
  assert.equal(plan.goals[0].target.id, 'designer-senior');
  assert.deepEqual(plan.goals[0].recommendations.map(r => r.activity.id), ['current-access']);
  assert.deepEqual(employee.career_goal, { target_role: 'Designer', target_grade: 'Middle' });
  assert.equal(employee.role, 'Engineer');
  assert.equal(employee.grade, 'junior');
});

test('terminal grade generates up to three attainable skill goals and prefers current-role skills', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.grade = 'lead';
  employee.skills = { python: 4, sql: 4, communication: 4 };
  data.skills.push({ id: 'other', name: 'Other-role skill' });
  data.grades.push({ id: 'other-lead', role: 'Other', name: 'Lead', next_grade: null, requirements: { other: 5 } });
  data.activities.push({ id: 'aaa-other', name: 'Other skill course', effects: [{ skill: 'other', gain: 2, max_level: 5 }] });
  const plan = developmentPlan(data, employee);
  assert.equal(plan.stage, 'no_target');
  assert.equal(plan.current_readiness, null);
  assert.equal(plan.goals.length, 3);
  for (const goal of plan.goals) {
    assert.equal(goal.type, 'skill');
    assert.notEqual(goal.target.skill, 'other');
    assert.equal(goal.target.level, 5);
    assert.equal(goal.gaps[0].gap, 1);
    assert.ok(goal.recommendations.length > 0 && goal.recommendations.length <= 3);
    assert.ok(goal.recommendations.every(r => r.reasons.some(reason => reason.skill === goal.target.skill && reason.gain > 0)));
  }
  assert.deepEqual(plan, developmentPlan(data, employee));
});

test('skill fallback honors mandatory, history, role, grade, prerequisite and session exclusions', () => {
  const exclusions = [
    (activity) => { activity.mandatory = true; },
    (activity) => { activity.target_roles = ['Other']; },
    (activity) => { activity.target_grades = ['Junior']; },
    (activity) => { activity.prerequisites = { python: 5 }; },
    (activity) => { activity.format = 'offline'; activity.upcoming_sessions = ['2026-09-01']; },
    (activity) => { activity.effects[0].max_level = 3; },
    (activity, employee) => { employee.history = [{ activity_id: activity.id, completed_at: '2026-09-01' }]; },
    (activity, employee) => { employee.history = [{ activity_id: activity.id, completed_at: '2026-09-01', status: 'in_progress' }]; },
    (activity, employee) => { activity.repeatable = true; employee.history = [{ activity_id: activity.id, completed_at: '2026-10-01', status: 'completed' }]; }
  ];
  for (const exclude of exclusions) {
    const data = fixture();
    const employee = data.employees[0];
    employee.grade = 'lead';
    employee.skills = { python: 3 };
    data.activities = [{ id: 'unavailable', name: 'Unavailable activity', effects: [{ skill: 'python', gain: 1, max_level: 5 }] }];
    exclude(data.activities[0], employee);
    const plan = developmentPlan(data, employee);
    assert.deepEqual(plan.goals, []);
    assert.match(plan.message, /нет активностей/);
  }
});

test('all skills at the scale maximum produce an explicit empty plan', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.skills = { python: 5, sql: 5, communication: 5 };
  const plan = developmentPlan(data, employee);
  assert.equal(plan.stage, 'completed');
  assert.deepEqual(plan.goals, []);
  assert.deepEqual(plan.completed_goals.map(g => g.target.id), ['middle', 'senior', 'lead']);
  assert.match(plan.message, /нет активностей/);
});

test('near-complete terminal goal does not relabel outstanding requirements as new skill goals', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.grade = 'senior';
  employee.skills = { python: 5, sql: 4, communication: 3 };
  assert.equal(developmentPlan(data, employee).stage, 'almost_complete');
  assert.deepEqual(developmentPlan(data, employee).goals, []);
  employee.skills.sql = 5;
  data.skills.push({ id: 'mentoring', name: 'Mentoring' });
  data.activities.push({ id: 'mentoring-workshop', name: 'Mentoring workshop', effects: [{ skill: 'mentoring', gain: 1, max_level: 3 }] });
  const plan = developmentPlan(data, employee);
  assert.equal(plan.goals.length, 1);
  assert.equal(plan.goals[0].target.skill, 'mentoring');
  assert.equal(plan.goals[0].target.level, 1);
});

test('HR counts actionable future goals as next steps and explains blocked future goals', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.skills = { python: 3, sql: 3, communication: 2 };
  assert.deepEqual(recommend(data, employee), []);
  assert.ok(!hrSummary(data).no_step.some(e => e.id === employee.id));
  employee.grade = 'lead';
  assert.ok(!hrSummary(data).no_step.some(e => e.id === employee.id));
  employee.grade = 'junior';
  data.activities = data.activities.map(a => ({ ...a, mandatory: true }));
  assert.match(hrSummary(data).no_step.find(e => e.id === employee.id).reason, /следующей цели развития/);
});

test('a later grade without available activities keeps honest requirements and an actionable explanation', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.skills = { python: 3, sql: 3, communication: 2 };
  data.activities = data.activities.map(a => ({ ...a, mandatory: true }));
  const goal = developmentPlan(data, employee).goals[0];
  assert.equal(goal.target.id, 'senior');
  assert.ok(goal.gaps.some(g => g.gap > 0));
  assert.deepEqual(goal.recommendations, []);
  assert.match(goal.reason, /нет доступных активностей/);
});

test('completing a generated goal activity recomputes the plan and removes exhausted activities', () => {
  const data = fixture();
  const employee = data.employees[0];
  employee.skills = { python: 3, sql: 3, communication: 2 };
  const first = developmentPlan(data, employee).goals[0];
  const recommendation = first.recommendations[0];
  completeActivity(data, employee.id, recommendation.activity.id);
  const next = developmentPlan(data, employee).goals[0];
  assert.ok(next.readiness > first.readiness);
  assert.ok(!next.recommendations.some(r => r.activity.id === recommendation.activity.id));
  assert.equal(employee.grade, 'junior');
});

test('reimported assessment and history drive new goals without persisting or duplicating plans', () => {
  const raw = {
    skills: { skills: [{ skill_id: 'design', name: 'Design' }], role_profiles: ['Junior', 'Middle', 'Senior', 'Lead'].map((grade, i) => ({ role: 'Engineer', grade, required_skills: { design: i + 2 }, critical_skills: ['design'] })) },
    events: [{ event_id: 'design-course', title: 'Design course', type: 'course', format: 'self_paced', mandatory: false, target_roles: ['Engineer'], target_grades: ['Junior'], prerequisites: {}, develops_skills: [{ skill_id: 'design', gain: 1, max_level: 5 }], upcoming_sessions: [] }],
    employees: [{ employee_id: 'employee', full_name: 'Synthetic employee', role: 'Engineer', grade: 'Junior', last_review_date: '2026-09-01', skills: { design: 1 } }],
    history: []
  };
  const initial = normalize(raw);
  assert.equal(developmentPlan(initial, initial.employees[0]).stage, 'in_progress');
  const updated = mergeProfiles(initial, { employees: [{ ...raw.employees[0], skills: { design: 2 } }], history: [{ record_id: 'done', employee_id: 'employee', event_id: 'design-course', date: '2026-09-10', status: 'completed', completion_pct: 100 }] });
  const snapshot = structuredClone(updated);
  const plan = developmentPlan(updated, updated.employees[0]);
  assert.equal(plan.stage, 'completed');
  assert.equal(plan.goals[0].target.name, 'Senior');
  assert.deepEqual(plan.goals[0].recommendations, []);
  assert.deepEqual(developmentPlan(updated, updated.employees[0]), plan);
  assert.deepEqual(updated, snapshot);
  assert.equal(Object.hasOwn(updated.employees[0], 'development'), false);
});

test('empty requirements are already complete and the derived plan does not depend on persisted fields', () => {
  const data = fixture();
  data.grades.find(g => g.id === 'middle').requirements = {};
  validateDataset(data);
  const view = dashboard(data)[0];
  assert.equal(view.readiness, null);
  assert.equal(view.development.stage, 'completed');
  assert.equal(view.development.current_readiness, 100);
  assert.equal(view.development.goals[0].target.id, 'senior');
});
