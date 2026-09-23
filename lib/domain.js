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
  return rankForTarget(data, employee, target, model, goalLabel).slice(0, Math.max(1, Math.min(3, limit)));
}

function rankForTarget(data, employee, target, model, goalLabel) {
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
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.activity.id.localeCompare(b.activity.id));
}

function chooseTask(data, employee, source, taskId) {
  if (!employee) fail('Сотрудник не найден.');
  if (source !== 'catalog' && !(taskId === null && source === undefined)) fail('Выберите шаг из каталога развития. Шаблонные практические задания больше не используются.');
  if (taskId !== null) {
    const valid = employee.available_activities.some(r => r.activity.id === taskId);
    if (!valid) fail('Эта задача недоступна или уже не помогает текущей цели. Обновите маршрут.');
  }
  data.task_choices = (data.task_choices || []).filter(choice => choice.employee_id !== employee.id);
  if (taskId !== null) data.task_choices.push({ employee_id: employee.id, source, task_id: taskId });
}

function coverage(missing) {
  const total = missing.reduce((sum, g) => sum + g.required, 0);
  return total ? 100 * missing.reduce((sum, g) => sum + Math.min(g.current, g.required), 0) / total : 100;
}

const gradeLabel = grade => grade.role ? `${grade.role} — ${grade.name}` : grade.name;
const gradeSummary = grade => ({ id: `grade:${grade.id}`, type: 'grade', name: grade.name, label: gradeLabel(grade), target: grade });

function goalWithSteps(data, employee, summary, target, model) {
  const missing = targetGaps(data, employee, target);
  const available = rankForTarget(data, employee, target, model, summary.label).map(r => ({ ...r, goal_id: summary.id, goal_label: summary.label }));
  return { ...summary, gaps: missing, readiness: Math.round(coverage(missing)), recommendations: available.slice(0, 3), available_activities: available };
}

function skillGoals(data, employee, model, excludedGaps = []) {
  const current = data.grades.find(g => g.id === employee.grade);
  const role = employee.role || current?.role;
  const roleSkills = new Set(data.grades.filter(g => role ? g.role === role : g.id === current?.id).flatMap(g => Object.keys(g.requirements)));
  // Only skills that a currently eligible activity can actually increase qualify.
  const availableSkills = new Set(data.activities.filter(a => eligible(a, employee, data)).flatMap(a => preview(a, employee).filter(e => e.gain > 0 && e.before < 5).map(e => e.skill)));
  const candidates = data.skills.filter(skill => availableSkills.has(skill.id) && !excludedGaps.some(g => g.skill === skill.id && g.gap > 0)).map(skill => {
    const level = Math.min(5, (employee.skills[skill.id] || 0) + 1);
    const summary = { id: `skill:${skill.id}:${level}`, type: 'skill', name: skill.name, label: `${skill.name}: уровень ${level}`, target: { skill: skill.id, name: skill.name, level } };
    const goal = goalWithSteps(data, employee, summary, { requirements: { [skill.id]: level } }, model);
    return { ...goal, reason: `Дальнейшее развитие навыка${roleSkills.has(skill.id) ? ' текущей роли' : ''}: с уровня ${employee.skills[skill.id] || 0} до ${level}. В каталоге есть доступная активность с подходящими gain/max_level.` };
  });
  candidates.sort((a, b) => Number(roleSkills.has(b.target.skill)) - Number(roleSkills.has(a.target.skill)) || b.recommendations[0].score - a.recommendations[0].score || a.id.localeCompare(b.id));
  return candidates.slice(0, 3);
}

// The active route advances when requirements are met, while factual grade and
// the employee's chosen career goal remain unchanged until HR updates them.
function progressionPlan(data, employee, model = train(data)) {
  const plan = { stage: 'in_progress', active_goal: null, upcoming_goals: [], completed_goals: [], recommendations: [], message: '', threshold: 80 };
  const visited = new Set();
  let target = nextGrade(data, employee);
  while (target && !visited.has(target.id)) {
    visited.add(target.id);
    const summary = gradeSummary(target);
    const missing = targetGaps(data, employee, target);
    if (missing.every(g => !g.gap)) {
      plan.completed_goals.push(summary);
    } else {
      const goal = goalWithSteps(data, employee, summary, target, model);
      if (!plan.active_goal) {
        plan.active_goal = goal;
        if (coverage(missing) < plan.threshold) break;
      } else {
        plan.upcoming_goals.push(goal);
        break;
      }
    }
    target = data.grades.find(g => g.id === target.next_grade);
  }
  if (!plan.active_goal) {
    const goals = skillGoals(data, employee, model);
    plan.active_goal = goals[0] || null;
    if (plan.active_goal && coverage(plan.active_goal.gaps) >= plan.threshold) plan.upcoming_goals = goals.slice(1);
  } else if (!target && coverage(plan.active_goal.gaps) >= plan.threshold) {
    plan.upcoming_goals = skillGoals(data, employee, model, plan.active_goal.gaps);
  }
  if (!plan.active_goal) {
    plan.stage = plan.completed_goals.length || data.skills.every(s => (employee.skills[s.id] || 0) >= 5) ? 'complete' : 'no_steps';
    plan.message = plan.completed_goals.length
      ? 'Требования целей выполнены. В доступном каталоге пока нет новых шагов развития; HR может дополнить каталог или согласовать новую цель. Повышение грейда согласуется отдельно.'
      : 'В доступном каталоге пока нет новых шагов развития. HR может дополнить каталог или согласовать новую цель.';
    return plan;
  }
  plan.recommendations = plan.active_goal.recommendations;
  const readiness = coverage(plan.active_goal.gaps);
  plan.stage = !plan.recommendations.length ? 'no_steps' : readiness >= plan.threshold ? 'almost_complete' : 'in_progress';
  plan.message = plan.stage === 'no_steps'
    ? `Для ${plan.completed_goals.length ? 'следующей цели развития' : 'текущей цели'} нет доступных шагов в каталоге. HR может дополнить каталог или согласовать доступ к подходящему обучению.`
    : plan.stage === 'almost_complete'
      ? `Выполнено не менее 80% требований текущей цели.${plan.upcoming_goals.length ? ' Следующая цель уже подготовлена.' : ''} Завершите оставшиеся шаги — маршрут обновится автоматически.`
      : plan.completed_goals.length
        ? 'Предыдущие требования выполнены. Рекомендации уже подобраны для следующей цели развития; повышение грейда согласуется отдельно.'
        : 'Рекомендованные шаги закрывают разрывы до текущей цели. После выполнения цели маршрут автоматически продолжится.';
  return plan;
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

  if (stage === 'completed') plan.completed_goals.push(gradeSummary(target));
  const visited = new Set(target ? [target.id] : []);
  let next = target && data.grades.find(g => g.id === target.next_grade);
  while (next && !visited.has(next.id)) {
    visited.add(next.id);
    const laterGaps = targetGaps(data, employee, next);
    if (laterGaps.some(g => g.gap > 0)) {
      const summary = gradeSummary(next);
      const available = rankForTarget(data, employee, next, model, summary.label).map(r => ({ ...r, goal_id: summary.id, goal_label: summary.label }));
      const recommendations = available.slice(0, 3);
      plan.goals.push({ ...summary, gaps: laterGaps, readiness: Math.round(coverage(laterGaps)), recommendations, available_activities: available,
        reason: `Следующий этап в последовательности грейдов после ${gradeLabel(target)}.${recommendations.length ? '' : ' Сейчас нет доступных активностей, закрывающих эти разрывы; HR может дополнить каталог.'}` });
      break;
    }
    plan.completed_goals.push(gradeSummary(next));
    next = data.grades.find(g => g.id === next.next_grade);
  }

  if (!plan.goals.length) {
    plan.goals = skillGoals(data, employee, model, missing);
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
  employee.history.push({ activity_id: activityId, completed_at: completedAt, date: completedAt, status: 'completed', recorded_at: new Date().toISOString() });
  data.task_choices = (data.task_choices || []).filter(choice => !(choice.employee_id === employeeId && choice.source === 'catalog' && choice.task_id === activityId));
  return changes;
}

function dashboard(data) {
  const model = train(data);
  return data.employees.map(employee => {
    const missing = gaps(data, employee);
    const total = missing.reduce((sum, g) => sum + g.required, 0);
    const target = nextGrade(data, employee);
    const current = rankForTarget(data, employee, target, model);
    const development = developmentPlan(data, employee, model);
    const progression = progressionPlan(data, employee, model);
    // One course can serve several goals; keep a single selectable task.
    const route = [progression.active_goal, ...progression.upcoming_goals].filter(Boolean);
    const available = [...new Map([...route.flatMap(goal => goal.available_activities), ...current].map(r => [r.activity.id, r])).values()].sort((a, b) => b.score - a.score || a.activity.id.localeCompare(b.activity.id));
    const view = { ...employee, next_grade: target, target_source: target ? employee.career_goal != null ? 'career_goal' : 'next_grade' : 'not_set', gaps: missing,
      readiness: total ? Math.round(100 * missing.reduce((sum, g) => sum + Math.min(g.current, g.required), 0) / total) : null,
      recommendations: current.slice(0, 3), available_activities: available, development, progression };
    delete view.practice;
    const choice = (data.task_choices || []).find(item => item.employee_id === employee.id);
    const validChoice = choice && choice.source === 'catalog' && available.some(r => r.activity.id === choice.task_id);
    return { ...view, selected_task: validChoice ? choice : null };
  });
}

function hrSummary(data, employees = dashboard(data)) {
  const deficits = data.skills.map(s => ({ id: s.id, name: s.name, count: employees.filter(e => (e.progression?.active_goal?.gaps || e.gaps).some(g => g.skill === s.id && g.gap > 0)).length })).filter(s => s.count).sort((a, b) => b.count - a.count);
  const participation = data.activities.map(a => {
    const rows = employees.flatMap(e => e.history.filter(h => h.activity_id === a.id));
    const counts = {};
    for (const h of rows) { const status = h.status || 'completed'; counts[status] = (counts[status] || 0) + 1; }
    return { id: a.id, name: a.name, total: rows.length, counts };
  });
  const today = Date.parse(data.as_of || new Date().toISOString());
  return { deficits, participation, no_step: employees.filter(e => !e.progression.recommendations.length && !e.progression.upcoming_goals.some(g => g.recommendations.length)).map(e => ({ id: e.id, name: e.name,
    reason: e.progression.message })), inactive: employees.filter(e => !e.history.some(h => Date.parse(h.date || h.completed_at) >= today - 90 * 86400000)).map(e => ({ id: e.id, name: e.name })) };
}
module.exports = { validateDataset, gaps, recommend, completeActivity, dashboard, hrSummary, developmentPlan, progressionPlan, chooseTask };
