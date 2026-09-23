'use strict';

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
    gap: Math.max(0, required - (employee.skills[skill] || 0))
  })) : [];
}

function eligible(activity, employee) {
  return !employee.history.some(h => h.activity_id === activity.id) &&
    Object.entries(activity.prerequisites || {}).every(([skill, level]) => (employee.skills[skill] || 0) >= level);
}

function preview(activity, employee) {
  return activity.effects.map(effect => {
    const before = employee.skills[effect.skill] || 0;
    const after = Math.max(before, Math.min(before + effect.gain, effect.max_level));
    return { skill: effect.skill, before, after, gain: after - before, max_level: effect.max_level };
  });
}

function recommend(data, employee, limit = 3) {
  const missing = gaps(data, employee);
  return data.activities.filter(a => eligible(a, employee)).map(activity => {
    const effects = preview(activity, employee);
    const reasons = effects.flatMap(effect => {
      const gap = missing.find(g => g.skill === effect.skill);
      const covered = gap ? Math.min(gap.gap, effect.gain) : 0;
      return covered > 0 ? [{ ...effect, name: gap.name, required: gap.required, covered }] : [];
    });
    return { activity, effects, reasons, score: reasons.reduce((sum, r) => sum + r.covered, 0) };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.activity.id.localeCompare(b.activity.id)).slice(0, Math.max(1, Math.min(3, limit)));
}

function completeActivity(data, employeeId, activityId) {
  const employee = data.employees.find(e => e.id === employeeId);
  const activity = data.activities.find(a => a.id === activityId);
  if (!employee || !activity) fail('Сотрудник или активность не найдены.');
  if (!eligible(activity, employee)) fail('Активность уже завершена или не выполнены входные требования.');
  const changes = preview(activity, employee);
  for (const change of changes) employee.skills[change.skill] = change.after;
  employee.history.push({ activity_id: activityId, completed_at: new Date().toISOString() });
  return changes;
}

function dashboard(data) {
  return data.employees.map(employee => {
    const missing = gaps(data, employee);
    const total = missing.reduce((sum, g) => sum + g.required, 0);
    return { ...employee, next_grade: nextGrade(data, employee), gaps: missing,
      readiness: total ? Math.round(100 * missing.reduce((sum, g) => sum + Math.min(g.current, g.required), 0) / total) : 100,
      recommendations: recommend(data, employee) };
  });
}

module.exports = { validateDataset, gaps, recommend, completeActivity, dashboard };
