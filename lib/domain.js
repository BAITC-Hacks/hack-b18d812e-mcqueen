'use strict';
const { train, predict } = require('./intelligence');

const fail = message => { throw new Error(message); };
const integer = value => Number.isInteger(value) && value >= 0 && value <= 100;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function validateDataset(data) {
  if (!record(data)) fail('Ожидается JSON-объект.');
  for (const key of ['skills', 'grades', 'activities', 'employees']) {
    if (!Array.isArray(data[key]) || !data[key].length || data[key].length > 10000) fail(`Поле ${key}: нужен непустой массив, до 10000 элементов.`);
    const ids = new Set();
    for (const item of data[key]) {
      if (!record(item) || !safeId(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200) fail(`${key}: неверные id или name.`);
      if (ids.has(item.id)) fail(`${key}: повторный id ${item.id}.`);
      ids.add(item.id);
    }
  }
  const skills = new Set(data.skills.map(s => s.id));
  const grades = new Set(data.grades.map(g => g.id));
  const activities = new Set(data.activities.map(a => a.id));
  const levels = (map, label) => {
    if (!record(map) || Object.entries(map).some(([id, level]) => !skills.has(id) || !integer(level))) fail(`${label}: неизвестный навык или уровень вне 0–100.`);
  };
  for (const grade of data.grades) {
    levels(grade.requirements, `Грейд ${grade.id}`);
    if (grade.next_grade != null && (!grades.has(grade.next_grade) || grade.next_grade === grade.id)) fail(`Неверный следующий грейд: ${grade.id}.`);
    const visited = new Set([grade.id]);
    let cursor = grade;
    while (cursor.next_grade != null) {
      if (visited.has(cursor.next_grade)) fail('Цикл в последовательности грейдов.');
      visited.add(cursor.next_grade);
      cursor = data.grades.find(g => g.id === cursor.next_grade);
      if (!cursor) fail('Неизвестный следующий грейд.');
    }
  }
  for (const activity of data.activities) {
    if (!Array.isArray(activity.effects) || !activity.effects.length) fail(`Нет effects: ${activity.id}.`);
    const seen = new Set();
    for (const effect of activity.effects) {
      if (!record(effect) || !skills.has(effect.skill) || !integer(effect.gain) || effect.gain === 0 || !integer(effect.max_level) || effect.max_level === 0 || seen.has(effect.skill)) fail(`Неверные gain/max_level или повтор навыка: ${activity.id}.`);
      seen.add(effect.skill);
    }
    if (activity.prerequisites !== undefined) levels(activity.prerequisites, `Условия ${activity.id}`);
  }
  for (const employee of data.employees) {
    if (!grades.has(employee.grade)) fail(`Неизвестный грейд: ${employee.id}.`);
    levels(employee.skills, `Сотрудник ${employee.id}`);
    if (!Array.isArray(employee.history)) fail(`history должен быть массивом: ${employee.id}.`);
    const seen = new Set();
    for (const entry of employee.history) {
      if (!record(entry) || !activities.has(entry.activity_id) || typeof entry.completed_at !== 'string' || !Number.isFinite(Date.parse(entry.completed_at)) || seen.has(entry.activity_id)) fail(`Неверная или повторная запись history: ${employee.id}.`);
      seen.add(entry.activity_id);
    }
  }
  return data;
}

function nextGrade(data, employee) {
  const current = data.grades.find(g => g.id === employee.grade);
  return data.grades.find(g => g.id === current.next_grade) || null;
}

function gaps(data, employee) {
  const next = nextGrade(data, employee);
  return next ? Object.entries(next.requirements).map(([skill, required]) => ({
    skill, name: data.skills.find(s => s.id === skill).name,
    current: employee.skills[skill] || 0, required,
    critical: (next.critical_skills || []).includes(skill), gap: Math.max(0, required - (employee.skills[skill] || 0))
  })) : [];
}

function eligible(activity, employee, data) {
  const today = data?.as_of || new Date().toISOString().slice(0, 10);
  const completed = employee.history.filter(h => h.activity_id === activity.id && (h.status || 'completed') === 'completed');
  if (activity.mandatory || (!activity.repeatable && completed.length)) return false;
  if (activity.repeatable && completed.some(h => (h.date || h.completed_at).slice(0, 10) === today)) return false;
  if (activity.target_roles && !activity.target_roles.includes(employee.role)) return false;
  if (activity.target_grades && !activity.target_grades.includes(data.grades.find(g => g.id === employee.grade)?.name)) return false;
  if (activity.format && activity.format !== 'self_paced' && !activity.upcoming_sessions.some(d => d >= today && !completed.some(h => (h.date || h.completed_at).slice(0, 10) === d))) return false;
  return Object.entries(activity.prerequisites || {}).every(([skill, level]) => (employee.skills[skill] || 0) >= level);
}

function preview(activity, employee) {
  return activity.effects.map(effect => {
    const before = employee.skills[effect.skill] || 0;
    const after = Math.max(before, Math.min(before + effect.gain, effect.max_level));
    return { skill: effect.skill, before, after, gain: after - before, max_level: effect.max_level };
  });
}

function recommend(data, employee, limit = 3, model = train(data)) {
  const missing = gaps(data, employee);
  return data.activities.filter(a => eligible(a, employee, data)).map(activity => {
    const effects = preview(activity, employee);
    const reasons = effects.flatMap(effect => {
      const gap = missing.find(g => g.skill === effect.skill);
      const covered = gap ? Math.min(gap.gap, effect.gain) : 0;
      return covered > 0 ? [{ ...effect, name: gap.name, required: gap.required, critical: gap.critical, covered }] : [];
    });
    const behavior = predict(model, data, employee, activity);
    const impact = reasons.reduce((sum, r) => sum + r.covered * (r.critical ? 2 : 1), 0);
    const score = Number((impact * (0.25 + 0.75 * behavior.probability)).toFixed(4));
    const current = data.grades.find(g => g.id === employee.grade);
    const next = nextGrade(data, employee);
    return { activity, effects, reasons, score, impact, behavior,
      explanation: `${employee.role || 'Профиль'}: ${current.name} → ${next?.name || '—'}. ${behavior.explanation} Критичные навыки имеют двойной вес; оценка учитывает ожидаемое завершение.` };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.activity.id.localeCompare(b.activity.id)).slice(0, Math.max(1, Math.min(3, limit)));
}

function completeActivity(data, employeeId, activityId) {
  const employee = data.employees.find(e => e.id === employeeId);
  const activity = data.activities.find(a => a.id === activityId);
  if (!employee || !activity) fail('Сотрудник или активность не найдены.');
  if (!eligible(activity, employee, data)) fail('Активность уже завершена или не выполнены входные требования.');
  const completedAt = data.as_of || new Date().toISOString().slice(0, 10);
  if (activity.repeatable && employee.history.some(h => h.activity_id === activityId && (h.status || 'completed') === 'completed' && (h.date || h.completed_at).slice(0, 10) === completedAt)) fail('Завершение уже отмечено сегодня.');
  const changes = preview(activity, employee);
  for (const change of changes) employee.skills[change.skill] = change.after;
  employee.history.push({ activity_id: activityId, completed_at: completedAt, date: completedAt, status: 'completed' });
  return changes;
}

function dashboard(data) {
  const model = train(data);
  return data.employees.map(employee => {
    const missing = gaps(data, employee);
    const total = missing.reduce((sum, g) => sum + g.required, 0);
    return { ...employee, next_grade: nextGrade(data, employee), gaps: missing,
      readiness: total ? Math.round(100 * missing.reduce((sum, g) => sum + Math.min(g.current, g.required), 0) / total) : 100,
      recommendations: recommend(data, employee, 3, model) };
  });
}

function hrSummary(data, employees = dashboard(data)) {
  const deficits = data.skills.map(s => ({ id: s.id, name: s.name, count: employees.filter(e => e.gaps.some(g => g.skill === s.id && g.gap > 0)).length })).filter(s => s.count).sort((a, b) => b.count - a.count);
  const participation = data.activities.map(a => {
    const rows = employees.flatMap(e => e.history.filter(h => h.activity_id === a.id));
    const counts = {};
    for (const h of rows) { const status = h.status || 'completed'; counts[status] = (counts[status] || 0) + 1; }
    return { id: a.id, name: a.name, total: rows.length, counts };
  });
  const today = Date.parse(data.as_of || new Date().toISOString());
  return { deficits, participation, no_step: employees.filter(e => !e.recommendations.length).map(e => ({ id: e.id, name: e.name, reason: !e.next_grade ? 'Последний грейд' : e.gaps.every(g => !g.gap) ? 'Требования выполнены' : 'Нет доступной активности, закрывающей разрыв' })), inactive: employees.filter(e => !e.history.some(h => Date.parse(h.date || h.completed_at) >= today - 90 * 86400000)).map(e => ({ id: e.id, name: e.name })) };
}
module.exports = { validateDataset, gaps, recommend, completeActivity, dashboard, hrSummary };
