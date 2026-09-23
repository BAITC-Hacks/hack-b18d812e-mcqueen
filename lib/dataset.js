'use strict';
const fs = require('node:fs');
const path = require('node:path');
const order = ['Junior', 'Middle', 'Senior', 'Lead'];
const statuses = ['completed', 'in_progress', 'dropped', 'no_show', 'declined', 'overdue'];
const check = (ok, message) => { if (!ok) throw new Error(message); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const array = (value, key) => Array.isArray(value) ? value : value?.[key];
function csv(text) {
  check(typeof text === 'string', 'История должна быть CSV.');
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  check(!quoted, 'Незакрытая кавычка CSV.');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift() || [];
  check(['record_id', 'employee_id', 'event_id', 'date', 'status', 'completion_pct'].every(k => headers.includes(k)), 'Неверные столбцы истории.');
  check(new Set(headers).size === headers.length, 'Повтор столбца CSV.');
  return rows.map(row => { check(row.length === headers.length, 'Неверное число полей CSV.'); return Object.fromEntries(headers.map((k, i) => [k, row[i]])); });
}
function loadDirectory(directory) {
  const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
  return { skills: JSON.parse(read('skills.json')), events: JSON.parse(read('events.json')), employees: JSON.parse(read('employees.json')), history: csv(read('activity_history.csv')) };
}
function normalize(raw) {
  raw = structuredClone(raw);
  const employees = array(raw.employees, 'employees');
  const events = array(raw.events, 'events');
  const catalog = raw.skills;
  const history = typeof raw.history === 'string' ? csv(raw.history) : raw.history;
  if (Array.isArray(history)) for (const h of history) for (const field of ['date', 'due_date']) {
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(h[field] || '')) h[field] = h[field].split('/').reverse().join('-');
  }
  check(Array.isArray(employees) && employees.length > 0 && employees.length <= 10000, 'Нужны employees.');
  check(Array.isArray(events) && events.length > 0 && Array.isArray(catalog?.skills) && Array.isArray(catalog?.role_profiles), 'Нужны events, skills и role_profiles.');
  check(Array.isArray(history) && history.length <= 100000, 'Неверная история.');
  const unique = (rows, field) => { const keys = rows.map(r => r?.[field]); check(keys.every(id) && new Set(keys).size === keys.length, `Неверные или повторные ${field}.`); };
  unique(employees, 'employee_id'); unique(events, 'event_id'); unique(catalog.skills, 'skill_id'); unique(history, 'record_id');
  const knownSkills = new Set(catalog.skills.map(s => s.skill_id));
  const knownEmployees = new Set(employees.map(e => e.employee_id));
  const knownEvents = new Set(events.map(e => e.event_id));
  const levels = map => check(map && typeof map === 'object' && !Array.isArray(map) && Object.entries(map).every(([k, v]) => knownSkills.has(k) && Number.isInteger(v) && v >= 0 && v <= 5), 'Навыки должны ссылаться на каталог и иметь уровни 0–5.');
  const profiles = catalog.role_profiles;
  check(new Set(profiles.map(p => `${p.role}|${p.grade}`)).size === profiles.length, 'Повтор профиля роли/грейда.');
  const key = (role, grade) => `grade-${profiles.findIndex(p => p.role === role && p.grade === grade)}`;
  const grades = profiles.map(p => {
    check(typeof p.role === 'string' && order.includes(p.grade), 'Неверная роль/грейд.'); levels(p.required_skills);
    check(Array.isArray(p.critical_skills) && p.critical_skills.every(s => Object.hasOwn(p.required_skills, s)), 'Неверные critical_skills.');
    const next = order[order.indexOf(p.grade) + 1];
    check(!next || profiles.some(g => g.role === p.role && g.grade === next), 'Нет следующего грейда роли.');
    return { id: key(p.role, p.grade), name: p.grade, role: p.role, requirements: p.required_skills, critical_skills: p.critical_skills, next_grade: next ? key(p.role, next) : null };
  });
  const activities = events.map(e => {
    levels(e.prerequisites);
    check(typeof e.title === 'string' && typeof e.mandatory === 'boolean' && Array.isArray(e.target_roles) && Array.isArray(e.target_grades) && Array.isArray(e.develops_skills), 'Неверные поля события.');
    check(['online', 'offline', 'self_paced'].includes(e.format) && typeof e.type === 'string', 'Неверный формат события.');
    check(Array.isArray(e.upcoming_sessions) && e.upcoming_sessions.every(date), 'Неверное расписание.');
    check(new Set(e.develops_skills.map(s => s.skill_id)).size === e.develops_skills.length, 'Повтор навыка события.');
    check(e.develops_skills.every(s => knownSkills.has(s.skill_id) && Number.isInteger(s.gain) && s.gain > 0 && s.gain <= 5 && Number.isInteger(s.max_level) && s.max_level > 0 && s.max_level <= 5), 'Неверные gain/max_level.');
    return { ...e, id: e.event_id, name: e.title, repeatable: e.event_id === 'EV_036', effects: e.develops_skills.map(s => ({ skill: s.skill_id, gain: s.gain, max_level: s.max_level })) };
  });
  for (const h of history) {
    check(knownEmployees.has(h.employee_id) && knownEvents.has(h.event_id) && date(h.date) && statuses.includes(h.status), 'Неверная ссылка, дата или статус истории.');
    const pct = Number(h.completion_pct);
    check(Number.isInteger(pct) && pct >= 0 && pct <= 100 && (h.status !== 'completed' || pct === 100), 'Неверный completion_pct.');
    check(!h.due_date || date(h.due_date), 'Неверный due_date.');
  }
  const now = '2026-10-01';
  const warnings = [];
  const result = { source: 'starter-kit', as_of: now, warnings, raw: structuredClone({ ...raw, history }), skills: catalog.skills.map(s => ({ ...s, id: s.skill_id })), grades, activities,
    employees: employees.map(e => {
      check(typeof e.full_name === 'string' && profiles.some(p => p.role === e.role && p.grade === e.grade) && date(e.last_review_date), 'Неверный профиль сотрудника.'); levels(e.skills);
      if (e.tenure_months != null) check(Number.isInteger(e.tenure_months) && e.tenure_months >= 0, 'Стаж должен быть неотрицательным целым числом месяцев.');
      if (e.career_goal != null) check(typeof e.career_goal === 'object' && !Array.isArray(e.career_goal) && profiles.some(p => p.role === e.career_goal.target_role && p.grade === e.career_goal.target_grade), 'Карьерная цель должна ссылаться на существующую роль и грейд.');
      check(e.last_review_date <= now, 'Оценка навыков позже даты среза.');
      const records = history.filter(h => h.employee_id === e.employee_id).sort((a, b) => a.date.localeCompare(b.date) || a.record_id.localeCompare(b.record_id));
      const employee = { ...e, id: e.employee_id, name: e.full_name, grade: key(e.role, e.grade), skills: { ...e.skills }, history: records.map(h => ({ ...h, activity_id: h.event_id, completed_at: h.date })) };
      // Imported levels are the last assessment, so replay only later completions.
      const completed = new Set();
      const completedSessions = new Set();
      for (const h of records) {
        check(h.date <= now, 'История позже даты среза.');
        if (h.status !== 'completed') continue;
        const activity = activities.find(a => a.id === h.event_id);
        const sessionKey = `${activity.id}|${h.date}`;
        if (activity.repeatable && completedSessions.has(sessionKey)) { warnings.push('Повтор завершения клуба в один день сохранён в истории без повторного начисления.'); continue; }
        completedSessions.add(sessionKey);
        if (!activity.repeatable && completed.has(activity.id)) { warnings.push('Повтор завершения неповторяемой активности сохранён в истории без повторного начисления.'); continue; }
        completed.add(activity.id);
        if (h.date > e.last_review_date) for (const effect of activity.effects) employee.skills[effect.skill] = Math.max(employee.skills[effect.skill] || 0, Math.min((employee.skills[effect.skill] || 0) + effect.gain, effect.max_level));
      }
      return employee;
    }) };
  return result;
}
function mergeProfiles(state, input) {
  check(state.raw, 'Сначала загрузите стартовый набор.');
  const incoming = array(input.employees, 'employees');
  const history = typeof input.history === 'string' ? csv(input.history) : input.history;
  check(Array.isArray(incoming) && incoming.length && Array.isArray(history), 'Нужны профили JSON и история CSV.');
  check(new Set(incoming.map(e => e.employee_id)).size === incoming.length, 'Повтор employee_id в импорте.');
  const ids = new Set(incoming.map(e => e.employee_id));
  check(history.every(h => ids.has(h.employee_id)), 'История должна относиться к импортируемым профилям.');
  const raw = structuredClone(state.raw);
  raw.employees = [...array(raw.employees, 'employees').filter(e => !ids.has(e.employee_id)), ...incoming];
  raw.history = [...raw.history.filter(h => !ids.has(h.employee_id)), ...history];
  const next = normalize(raw);
  // Preserve all live progress of employees not replaced by this import.
  next.employees = next.employees.map(e => ids.has(e.id) ? e : structuredClone(state.employees.find(old => old.id === e.id) || e));
  return next;
}
module.exports = { csv, loadDirectory, normalize, mergeProfiles };
