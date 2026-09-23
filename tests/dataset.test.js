const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, mergeProfiles, csv } = require('../lib/dataset');
const { recommend, completeActivity, hrSummary } = require('../lib/domain');
// Independently authored small fixture; no hackathon records are committed.
function fixture() {
  const event = (event_id, skill_id, type = 'workshop') => ({ event_id, title: event_id, description: '', type, format: 'self_paced', mandatory: false, target_roles: ['Engineer'], target_grades: ['Junior', 'Middle'], prerequisites: {}, develops_skills: [{ skill_id, gain: 2, max_level: 5 }], upcoming_sessions: [] });
  return { skills: { skills: [{ skill_id: 'design', name: 'Design' }, { skill_id: 'speech', name: 'Speech' }], role_profiles: ['Junior', 'Middle', 'Senior', 'Lead'].map((grade, i) => ({ role: 'Engineer', grade, required_skills: { design: Math.min(5, i + 2), speech: 2 }, critical_skills: ['design'] })) },
    events: { events: [event('design-course', 'design', 'course'), event('speech-workshop', 'speech'), { ...event('mandatory', 'speech'), mandatory: true }] },
    employees: { employees: [{ employee_id: 'example', full_name: 'Synthetic example', role: 'Engineer', grade: 'Junior', last_review_date: '2026-09-01', skills: { design: 2, speech: 0 } }] },
    history: [1, 2, 3].map(n => ({ record_id: 'skip-' + n, employee_id: 'example', event_id: 'speech-workshop', date: `0${n}/09/2026`, status: 'no_show', completion_pct: 0 })) };
}
test('critical next-grade skill beats lowest skill after repeated no-shows', () => {
  const data = normalize(fixture());
  const recs = recommend(data, data.employees[0]);
  assert.equal(recs[0].activity.id, 'design-course');
  assert.equal(recs.find(r => r.activity.id === 'speech-workshop').behavior.failures, 3);
  assert.ok(!recs.some(r => r.activity.mandatory));
  assert.match(recs[0].explanation, /Junior → Middle/);
});
test('assessment replay is chronological, capped and not doubled by import', () => {
  const raw = fixture();
  raw.history.push({ record_id: 'done', employee_id: 'example', event_id: 'design-course', date: '2026-09-10', status: 'completed', completion_pct: 100 });
  const state = normalize(raw);
  assert.equal(state.employees[0].skills.design, 4);
  const next = mergeProfiles(state, { employees: raw.employees, history: raw.history });
  assert.equal(next.employees[0].skills.design, 4);
  assert.ok(!recommend(next, next.employees[0]).some(r => r.activity.id === 'design-course'));
  raw.history.push({ ...raw.history.at(-1), record_id: 'duplicate', date: '2026-09-11' });
  const repeated = normalize(raw);
  assert.equal(repeated.warnings.length, 1);
  assert.equal(repeated.employees[0].skills.design, 4);
});
test('unrelated progress survives incremental profile import and bad import is rejected', () => {
  const raw = fixture(); const state = normalize(raw);
  completeActivity(state, 'example', 'design-course');
  const second = { ...raw.employees.employees[0], employee_id: 'second' };
  const next = mergeProfiles(state, { employees: [second], history: [] });
  assert.equal(next.employees.find(e => e.id === 'example').skills.design, 4);
  assert.equal(next.employees.length, 2);
  assert.throws(() => mergeProfiles(state, { employees: [second], history: raw.history }), /импортируемым/);
  assert.throws(() => normalize({ ...raw, employees: [{ ...second, skills: { design: 6 } }] }), /0–5|ссылка/);
});
test('roles, grade, prerequisites and schedules exclude unavailable events', () => {
  const raw = fixture();
  raw.events.events[0].target_roles = ['Other'];
  raw.events.events[1].format = 'offline'; raw.events.events[1].upcoming_sessions = ['2026-09-01'];
  const state = normalize(raw);
  assert.deepEqual(recommend(state, state.employees[0]), []);
  assert.throws(() => completeActivity(state, 'example', 'design-course'), /требования/);
  assert.equal(hrSummary(state).no_step.length, 1);
  assert.equal(hrSummary(state).participation.find(a => a.id === 'speech-workshop').counts.no_show, 3);
});
test('recurring club permits another day but never double credits same day', () => {
  const raw = fixture(); raw.events.events.push({ ...raw.events.events[0], event_id: 'EV_036' });
  const state = normalize(raw);
  completeActivity(state, 'example', 'EV_036');
  const before = state.employees[0].skills.design;
  assert.throws(() => completeActivity(state, 'example', 'EV_036'), /сегодня|уже завершена/);
  assert.equal(state.employees[0].skills.design, before);
  state.as_of = '2026-10-02'; completeActivity(state, 'example', 'EV_036');
  assert.equal(state.employees[0].skills.design, 5);
});
test('CSV handles quoted commas, CRLF and malformed headers', () => {
  const rows = csv('record_id,employee_id,event_id,date,status,completion_pct,note\r\na,b,c,2026-01-01,completed,100,"a,b"\r\n');
  assert.equal(rows[0].note, 'a,b');
  assert.throws(() => csv('not,history\n1,2'), /столбцы/);
});
