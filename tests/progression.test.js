'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboard, completeActivity, chooseTask, hrSummary } = require('../lib/domain');

function chain() {
  const names = ['Junior', 'Middle', 'Senior', 'Lead', 'Principal'];
  return {
    as_of: '2026-10-01',
    skills: [{ id: 'design', name: 'Design' }],
    grades: names.map((name, index) => ({ id: name.toLowerCase(), name, role: 'Engineer', next_grade: names[index + 1]?.toLowerCase() || null, requirements: { design: index + 1 } })),
    activities: [2, 3, 4, 5].map(level => ({ id: `step-${level}`, name: `Design level ${level}`, target_roles: ['Engineer'], target_grades: ['Junior'], prerequisites: { design: level - 1 }, effects: [{ skill: 'design', gain: 1, max_level: level }] })),
    employees: [{ id: 'employee', name: 'Synthetic employee', role: 'Engineer', grade: 'junior', career_goal: { target_role: 'Engineer', target_grade: 'Middle' }, skills: { design: 1 }, history: [] }]
  };
}
const own = data => dashboard(data)[0];

test('the main route automatically advances through completed goals without promotion, repeats or profile mutation', () => {
  const data = chain();
  const careerGoal = structuredClone(data.employees[0].career_goal);
  for (let level = 2; level <= 5; level++) {
    const saved = structuredClone(data);
    const view = own(data);
    const route = view.progression;
    assert.equal(route.active_goal.target.requirements.design, level);
    assert.deepEqual(route.recommendations.map(r => r.activity.id), [`step-${level}`]);
    assert.deepEqual(route.completed_goals.map(g => g.name), ['Middle', 'Senior', 'Lead'].slice(0, level - 2));
    assert.deepEqual(data, saved, 'merely viewing a generated route never awards progress');
    chooseTask(data, view, 'catalog', `step-${level}`);
    completeActivity(data, 'employee', `step-${level}`);
    assert.equal(own(data).selected_task, null);
    assert.throws(() => completeActivity(data, 'employee', `step-${level}`), /уже завершена/);
    assert.equal(data.employees[0].grade, 'junior');
    assert.deepEqual(data.employees[0].career_goal, careerGoal);
  }
  const final = own(data);
  assert.equal(final.progression.stage, 'complete');
  assert.equal(final.progression.active_goal, null);
  assert.deepEqual(final.progression.recommendations, []);
  assert.deepEqual(final.progression.completed_goals.map(g => g.name), ['Middle', 'Senior', 'Lead', 'Principal']);
  assert.equal(final.history.length, 4);
  assert.equal(final.next_grade.id, 'middle', 'legacy target is preserved for existing integrations');
});

test('80% preview is recalculated for the new active goal and uses exact coverage', () => {
  const data = chain();
  data.skills = Array.from({ length: 10 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${i}` }));
  const requirements = Object.fromEntries(data.skills.map((s, i) => [s.id, i === 9 ? 4 : 5]));
  data.grades[1].requirements = requirements;
  for (const grade of data.grades.slice(2)) grade.requirements = Object.fromEntries(data.skills.map(s => [s.id, 5]));
  data.employees[0].skills = Object.fromEntries(data.skills.map((s, i) => [s.id, i < 7 ? 5 : i === 7 ? 4 : 0]));
  data.activities = [{ id: 'available', name: 'Available step', effects: [{ skill: 'skill-8', gain: 1, max_level: 5 }] }];
  let route = own(data).progression;
  assert.equal(route.active_goal.readiness, 80);
  assert.equal(route.stage, 'in_progress');
  assert.deepEqual(route.upcoming_goals, []);
  data.grades[1].requirements['skill-9'] = 5;
  data.employees[0].skills['skill-7'] = 5;
  route = own(data).progression;
  assert.equal(route.stage, 'almost_complete');
  assert.equal(route.active_goal.target.id, 'middle');
  assert.equal(route.upcoming_goals[0].target.id, 'senior');

  const advanced = chain();
  advanced.grades[2].requirements = { design: 5 };
  advanced.skills.push({ id: 'mentoring', name: 'Mentoring' });
  advanced.grades[3].requirements = { design: 5, mentoring: 1 };
  advanced.employees[0].skills.design = 4;
  advanced.activities.push({ id: 'mentor', name: 'Mentoring step', effects: [{ skill: 'mentoring', gain: 1, max_level: 2 }] });
  route = own(advanced).progression;
  assert.equal(route.active_goal.target.id, 'senior');
  assert.equal(route.stage, 'almost_complete');
  assert.equal(route.upcoming_goals[0].target.id, 'lead');
  assert.deepEqual(route.recommendations.map(r => r.activity.id), ['step-5']);
});

test('satisfied future grades are skipped and unavailable catalog steps never fabricate progress', () => {
  const data = chain();
  data.employees[0].skills.design = 3;
  let route = own(data).progression;
  assert.equal(route.active_goal.target.id, 'lead');
  assert.deepEqual(route.completed_goals.map(g => g.name), ['Middle', 'Senior']);
  data.activities = data.activities.map(a => ({ ...a, mandatory: true }));
  route = own(data).progression;
  assert.equal(route.stage, 'no_steps');
  assert.equal(route.active_goal.target.id, 'lead');
  assert.equal(route.active_goal.gaps[0].gap, 1);
  assert.deepEqual(route.recommendations, []);
  assert.match(route.message, /нет доступных шагов/);
  assert.deepEqual(own(data).available_activities, []);
  assert.equal(own(data).practice, undefined);
  assert.equal(hrSummary(data).no_step[0].reason, route.message);
});

test('terminal employees receive attainable skill steps that advance to a new level', () => {
  const data = chain();
  data.employees[0].grade = 'principal';
  delete data.employees[0].career_goal;
  data.employees[0].skills.design = 2;
  for (const activity of data.activities) delete activity.target_grades;
  let route = own(data).progression;
  assert.equal(route.active_goal.type, 'skill');
  assert.equal(route.active_goal.target.level, 3);
  assert.deepEqual(route.recommendations.map(r => r.activity.id), ['step-3']);
  completeActivity(data, 'employee', 'step-3');
  route = own(data).progression;
  assert.equal(route.active_goal.target.level, 4);
  assert.deepEqual(route.recommendations.map(r => r.activity.id), ['step-4']);
  assert.equal(data.employees[0].grade, 'principal');
});

test('a blocked near-complete goal may still offer an eligible step for the upcoming goal', () => {
  const data = chain();
  data.skills.push({ id: 'mentoring', name: 'Mentoring' });
  data.employees[0].skills.design = 4;
  data.grades[2].requirements = { design: 5 };
  data.grades[3].requirements = { design: 5, mentoring: 1 };
  data.activities = [{ id: 'mentor', name: 'Mentoring step', effects: [{ skill: 'mentoring', gain: 1, max_level: 2 }] }];
  const view = own(data);
  assert.equal(view.progression.stage, 'no_steps');
  assert.equal(view.progression.active_goal.target.id, 'senior');
  assert.equal(view.progression.upcoming_goals[0].target.id, 'lead');
  assert.deepEqual(view.available_activities.map(r => r.activity.id), ['mentor']);
  assert.deepEqual(hrSummary(data).no_step, []);
  chooseTask(data, view, 'catalog', 'mentor');
  assert.equal(own(data).selected_task.task_id, 'mentor');
});

test('routes retain actual role, grade, history, sessions and prerequisite exclusions', () => {
  const exclusions = [
    activity => { activity.mandatory = true; },
    activity => { activity.target_roles = ['Designer']; },
    activity => { activity.target_grades = ['Senior']; },
    activity => { activity.prerequisites = { design: 5 }; },
    activity => { activity.format = 'offline'; activity.upcoming_sessions = ['2026-09-01']; },
    (activity, employee) => { employee.history = [{ activity_id: activity.id, completed_at: '2026-09-01' }]; },
    (activity, employee) => { employee.history = [{ activity_id: activity.id, completed_at: '2026-09-01', status: 'in_progress' }]; },
    (activity, employee) => { activity.repeatable = true; employee.history = [{ activity_id: activity.id, completed_at: '2026-10-01' }]; }
  ];
  for (const exclude of exclusions) {
    const data = chain();
    data.employees[0].skills.design = 2;
    exclude(data.activities[1], data.employees[0]);
    const view = own(data);
    assert.equal(view.progression.active_goal.target.id, 'senior');
    assert.equal(view.progression.stage, 'no_steps');
    assert.deepEqual(view.progression.recommendations, []);
    assert.throws(() => chooseTask(data, view, 'catalog', 'step-3'), /недоступна/);
    assert.throws(() => completeActivity(data, 'employee', 'step-3'), /входные требования/);
  }
});

test('legacy practice records are retained on disk but are not achievements or selectable steps', () => {
  const data = chain();
  data.practice_completions = [{ employee_id: 'employee', task: { id: 'old-practice' }, completed_at: '2026-09-01' }];
  data.task_choices = [{ employee_id: 'employee', source: 'practice', task_id: 'old-practice' }];
  const saved = structuredClone(data);
  let view = own(data);
  assert.equal(view.practice, undefined);
  assert.equal(view.selected_task, null);
  assert.deepEqual(view.history, []);
  assert.deepEqual(view.progression.completed_goals, []);
  assert.deepEqual(data, saved);
  assert.throws(() => chooseTask(data, view, 'practice', 'old-practice'), /больше не используются/);
  assert.throws(() => chooseTask(data, view, 'practice', null), /больше не используются/);
  chooseTask(data, view, 'catalog', 'step-2');
  chooseTask(data, own(data), undefined, null);
  assert.equal(own(data).selected_task, null);
  assert.deepEqual(data.practice_completions, saved.practice_completions);
});

test('employees may select another available catalog step but cannot bypass eligibility', () => {
  const data = structuredClone(require('../demo.json'));
  data.activities.push({ id: 'extra-task', name: 'Additional course', effects: [{ skill: 'sql', gain: 1, max_level: 3 }] });
  const view = own(data);
  assert.equal(view.progression.recommendations.length, 3);
  assert.equal(view.available_activities.length, 4);
  const extra = view.available_activities.find(r => !view.progression.recommendations.some(top => top.activity.id === r.activity.id));
  chooseTask(data, view, 'catalog', extra.activity.id);
  assert.equal(own(data).selected_task.task_id, extra.activity.id);
  assert.throws(() => chooseTask(data, own(data), 'catalog', 'project'), /недоступна/);
  completeActivity(data, 'demo-1', extra.activity.id);
  assert.equal(own(data).selected_task, null);
  assert.throws(() => chooseTask(data, own(data), 'catalog', extra.activity.id), /недоступна/);
});
