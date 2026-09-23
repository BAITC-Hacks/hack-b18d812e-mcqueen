'use strict';
const { train, predict } = require('./intelligence');

const fail = message => { throw new Error(message); };
const integer = value => Number.isInteger(value) && value >= 0 && value <= 5;
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
    if (!record(map) || Object.entries(map).some(([id, level]) => !skills.has(id) || !integer(level))) fail(`${label}: неизвестный навык или уровень вне 0–5.`);
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
    if (employee.career_goal != null && (!record(employee.career_goal) || !data.grades.some(g => g.role === employee.career_goal.target_role && g.name === employee.career_goal.target_grade))) fail(`Неверная карьерная цель: ${employee.id}.`);
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
  if (employee.career_goal != null) {
    const goal = employee.career_goal;
    return data.grades.find(g => g.role === goal.target_role && g.name === goal.target_grade) || null;
  }
  const current = data.grades.find(g => g.id === employee.grade);
  return data.grades.find(g => g.id === current?.next_grade) || null;
}

function gaps(data, employee) {
  return targetGaps(data, employee, nextGrade(data, employee));
}

function targetGaps(data, employee, target) {
  return target ? Object.entries(target.requirements).map(([skill, required]) => ({
    skill, name: data.skills.find(s => s.id === skill).name,
    current: employee.skills[skill] || 0, required,
    critical: (target.critical_skills || []).includes(skill), gap: Math.max(0, required - (employee.skills[skill] || 0))
  })) : [];
}

function eligible(activity, employee, data) {
  const today = data?.as_of || new Date().toISOString().slice(0, 10);
  if (employee.history.some(h => h.activity_id === activity.id && h.status === 'in_progress')) return false;
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
  return recommendForTarget(data, employee, nextGrade(data, employee), limit, model);
}

function recommendForTarget(data, employee, target, limit, model, goalLabel) {
  const missing = targetGaps(data, employee, target);
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
    const goalExplanation = employee.career_goal != null && target ? `Карьерная цель: ${target.role} — ${target.name}. ` : '';
    const context = goalLabel
      ? `${employee.role || current.role || 'Профиль'}: ${current.name}. Дальнейшая цель: ${goalLabel}. `
      : `${employee.role || current.role || 'Профиль'}: ${current.name} → ${target?.name || '—'}. ${goalExplanation}`;
    return { activity, effects, reasons, score, impact, behavior,
      explanation: `${context}${behavior.explanation} Критичные навыки имеют двойной вес; оценка учитывает ожидаемое завершение.` };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.activity.id.localeCompare(b.activity.id)).slice(0, Math.max(1, Math.min(3, limit)));
}

function coverage(missing) {
  const total = missing.reduce((sum, g) => sum + g.required, 0);
  return total ? 100 * missing.reduce((sum, g) => sum + Math.min(g.current, g.required), 0) / total : 100;
}

// A derived plan never promotes an employee or overwrites their chosen career goal.
// Every suggestion is recalculated from their current skills and eligible activities.
function developmentPlan(data, employee, model = train(data)) {
  const target = nextGrade(data, employee);
  const missing = targetGaps(data, employee, target);
  const currentReadiness = target ? coverage(missing) : null;
  const stage = !target ? 'no_target' : missing.every(g => !g.gap) ? 'completed' : currentReadiness >= 80 ? 'almost_complete' : 'in_progress';
  const plan = { stage, threshold: 80, current_readiness: currentReadiness, goals: [], completed_goals: [], message: '' };
  if (stage === 'in_progress') {
    plan.message = 'Новые цели появятся после выполнения 80% требований текущей цели.';
    return plan;
  }

  const gradeLabel = grade => grade.role ? `${grade.role} — ${grade.name}` : grade.name;
  const gradeSummary = grade => ({ id: `grade:${grade.id}`, type: 'grade', name: grade.name, label: gradeLabel(grade), target: grade });
  if (stage === 'completed') plan.completed_goals.push(gradeSummary(target));
  const visited = new Set(target ? [target.id] : []);
  let next = target && data.grades.find(g => g.id === target.next_grade);
  while (next && !visited.has(next.id)) {
    visited.add(next.id);
    const laterGaps = targetGaps(data, employee, next);
    if (laterGaps.some(g => g.gap > 0)) {
      const summary = gradeSummary(next);
      const recommendations = recommendForTarget(data, employee, next, 3, model, summary.label).map(r => ({ ...r, goal_id: summary.id }));
      plan.goals.push({ ...summary, gaps: laterGaps, readiness: Math.round(coverage(laterGaps)), recommendations,
        reason: `Следующий этап в последовательности грейдов после ${gradeLabel(target)}.${recommendations.length ? '' : ' Сейчас нет доступных активностей, закрывающих эти разрывы; HR может дополнить каталог.'}` });
      break;
    }
    plan.completed_goals.push(gradeSummary(next));
    next = data.grades.find(g => g.id === next.next_grade);
  }

  if (!plan.goals.length) {
    const current = data.grades.find(g => g.id === employee.grade);
    const role = employee.role || current?.role;
    const roleSkills = new Set(data.grades.filter(g => role ? g.role === role : g.id === current?.id).flatMap(g => Object.keys(g.requirements)));
    // Only skills that a currently eligible activity can actually increase qualify.
    const availableSkills = new Set(data.activities.filter(a => eligible(a, employee, data)).flatMap(a => preview(a, employee).filter(e => e.gain > 0 && e.before < 5).map(e => e.skill)));
    const candidates = data.skills.filter(skill => availableSkills.has(skill.id) && !missing.some(g => g.skill === skill.id && g.gap > 0)).map(skill => {
      const level = Math.min(5, (employee.skills[skill.id] || 0) + 1);
      const skillTarget = { name: skill.name, requirements: { [skill.id]: level } };
      const id = `skill:${skill.id}:${level}`;
      const label = `${skill.name}: уровень ${level}`;
      const skillGaps = targetGaps(data, employee, skillTarget);
      return { id, type: 'skill', name: skill.name, label, target: { skill: skill.id, name: skill.name, level }, gaps: skillGaps,
        readiness: Math.round(coverage(skillGaps)), recommendations: recommendForTarget(data, employee, skillTarget, 3, model, label).map(r => ({ ...r, goal_id: id })),
        reason: `Дальнейшее развитие навыка${roleSkills.has(skill.id) ? ' текущей роли' : ''}: с уровня ${employee.skills[skill.id] || 0} до ${level}. В каталоге есть доступная активность с подходящими gain/max_level.` };
    });
    candidates.sort((a, b) => Number(roleSkills.has(b.target.skill)) - Number(roleSkills.has(a.target.skill)) || b.recommendations[0].score - a.recommendations[0].score || a.id.localeCompare(b.id));
    plan.goals = candidates.slice(0, 3);
  }

  plan.message = !plan.goals.length
    ? 'В доступном каталоге нет активностей для новых целей за пределами текущих требований. HR может дополнить каталог или согласовать новую карьерную цель.'
    : stage === 'almost_complete'
      ? 'Выполнено не менее 80% требований. Завершите текущую цель; следующий этап развития уже подготовлен.'
      : stage === 'completed'
        ? 'Требования текущей цели выполнены. Подготовлены следующие цели развития; повышение грейда согласуется отдельно.'
        : 'Следующий грейд не задан. Подготовлены доступные цели развития навыков.';
  return plan;
}

function completeActivity(data, employeeId, activityId) {
  const employee = data.employees.find(e => e.id === employeeId);
  const activity = data.activities.find(a => a.id === activityId);
  if (!employee || !activity) fail('Сотрудник или активность не найдены.');
  if (!eligible(activity, employee, data)) fail('Активность уже завершена, находится в процессе или не выполнены входные требования.');
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
    const target = nextGrade(data, employee);
    return { ...employee, next_grade: target, target_source: target ? employee.career_goal != null ? 'career_goal' : 'next_grade' : 'not_set', gaps: missing,
      readiness: total ? Math.round(100 * missing.reduce((sum, g) => sum + Math.min(g.current, g.required), 0) / total) : null,
      recommendations: recommend(data, employee, 3, model), development: developmentPlan(data, employee, model) };
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
  return { deficits, participation, no_step: employees.filter(e => !e.recommendations.length && !e.development?.goals.some(g => g.recommendations.length)).map(e => ({ id: e.id, name: e.name,
    reason: e.development?.goals.length ? 'Нет доступной активности для следующей цели развития' : !e.next_grade ? 'Нет доступных целей развития навыков' : e.gaps.every(g => !g.gap) ? 'Требования выполнены; нет доступных новых целей' : 'Нет доступной активности, закрывающей разрыв' })), inactive: employees.filter(e => !e.history.some(h => Date.parse(h.date || h.completed_at) >= today - 90 * 86400000)).map(e => ({ id: e.id, name: e.name })) };
}
module.exports = { validateDataset, gaps, recommend, completeActivity, dashboard, hrSummary, developmentPlan };
