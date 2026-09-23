'use strict';
let state;
let selected;
let routePanel = 'recommendations';
let hrPanel = 'overview';
let teamPage = 0;
let taskSkill = '';
const pageSize = 12;
const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const alphabet = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
const byName = (a, b) => alphabet.compare(a.name, b.name) || alphabet.compare(a.id || '', b.id || '');
const employeesByName = () => [...state.employees].sort(byName);
const gradeName = id => state.grades.find(g => g.id === id)?.name || id;
const skillName = id => state.skills.find(s => s.id === id)?.name || id;
const targetName = e => e.progression.active_goal?.label || 'Согласовать новую цель';
const coverage = e => e.progression.active_goal ? `${e.progression.active_goal.readiness}%` : '—';
const routeGaps = e => e.progression.active_goal?.gaps || [];
const dateLabel = value => new Date(value).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : 'success'; }
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(data.error || 'Ошибка запроса.'); }
  return data;
}
async function refresh() {
  state = await api('/api/state');
  $('access-result').textContent = '';
  $('login-panel').hidden = true;
  $('workspace').hidden = false;
  $('hr-tab').hidden = state.role !== 'hr';
  $('access-button').hidden = state.role !== 'hr';
  if (state.role !== 'hr') tab(false);
  if (!state.employees.length) throw new Error('Профиль недоступен. Обратитесь к HR.');
  const employees = employeesByName();
  if (!employees.some(e => e.id === selected)) selected = employees[0].id;
  $('employee-select').innerHTML = employees.map(e => `<option value="${escape(e.id)}">${escape(e.name)}</option>`).join('');
  $('employee-select').value = selected;
  $('mode').textContent = state.demo ? 'Демонстрационный набор · Вымышленные профили' : `Стартовый набор · Срез на ${dateLabel(state.as_of)}`;
  render();
  renderHR();
}
function chooseButton(source, id) {
  const choice = state.employees.find(e => e.id === selected).selected_task;
  const chosen = choice?.source === source && choice.task_id === id;
  return `<button data-choose-source="${source}" data-choose-id="${escape(id)}" ${chosen ? 'disabled' : ''}>${chosen ? 'В вашем плане' : 'Добавить в план'}</button>`;
}
function recommendationCard(r, index) {
  const formats = { online: 'Онлайн', offline: 'Очно', self_paced: 'В своём темпе' };
  return `<article class="recommendation ${index === 0 ? 'recommended' : ''}">
    <div class="recommendation-top"><span class="rank">${index === 0 ? '01 · Первый шаг' : `0${index + 1} · Альтернатива`}</span>${r.activity.format ? `<span class="tag">${escape(formats[r.activity.format] || r.activity.format)}</span>` : ''}</div>
    <h3>${escape(r.activity.name)}</h3>
    ${r.goal_label ? `<p class="muted">Цель: ${escape(r.goal_label)}</p>` : ''}
    <p class="description">${escape(r.activity.description || 'Активность для развития навыков целевого грейда.')}</p>
    <div class="impact-list">${r.reasons.map(reason => `<div class="impact-row"><div><span>${escape(reason.name)}</span><small>${reason.critical ? '★ Критичный навык · ' : ''}Цель: ${reason.required}</small></div><strong>${reason.before} → ${reason.after}</strong></div>`).join('')}</div>
    <p class="muted">Вероятность завершения: <b>${Math.round(r.behavior.probability * 100)}%</b><br><small>Прогноз модели, не гарантия результата.</small></p>
    <details class="explanation"><summary>Почему этот шаг</summary><p>${escape(r.explanation)}</p><div class="reason-notes">${r.reasons.map(reason => `<p><b>${escape(reason.name)}</b>: закроет ${reason.covered} ур. разрыва. Предел активности: ${reason.max_level}.</p>`).join('')}</div><p class="muted">Оценка приоритета: ${r.score}. Участие добровольное.</p></details>
    ${chooseButton('catalog', r.activity.id)}
  </article>`;
}
function developmentSection(employee) {
  const plan = employee.progression;
  if (!plan.upcoming_goals.length) return '';
  return `<section class="development-plan" aria-label="Дальнейшее развитие"><div class="section-heading"><div><p class="eyebrow">ДАЛЬШЕ ПО МАРШРУТУ</p><h2>Следующая цель уже рядом</h2><p class="muted">Выполнено не менее ${plan.threshold}% требований активной цели. Эти шаги помогут продолжить развитие.</p></div></div>
    <div class="growth-goals">${plan.upcoming_goals.map(goal => `<article class="growth-goal"><div class="section-heading"><div><span class="rank">${goal.type === 'grade' ? 'КАРЬЕРНЫЙ ОРИЕНТИР' : 'РАЗВИТИЕ НАВЫКА'}</span><h3>${escape(goal.label || goal.name)}</h3></div><span class="tag">${goal.readiness ?? '—'}% требований</span></div><div class="growth-gaps">${goal.gaps.filter(g => g.gap).map(g => `<span>${escape(g.name)}: ${g.current} → ${g.required}${g.critical ? ' ★' : ''}</span>`).join('')}</div><details><summary>Шаги к следующей цели (${goal.recommendations.length})</summary><div class="recommendations">${goal.recommendations.map(recommendationCard).join('')}</div>${goal.recommendations.length ? '' : '<p class="muted">Пока нет доступных шагов. Обсудите подходящие активности с HR.</p>'}</details></article>`).join('')}</div></section>`;
}
function activeTask(e) {
  const choice = e.selected_task;
  if (!choice || choice.source !== 'catalog') return '';
  const task = e.available_activities.find(r => r.activity.id === choice.task_id);
  if (!task) return '';
  return `<article class="active-task panel"><div class="section-heading"><div><p class="eyebrow">ШАГ В ВАШЕМ ПЛАНЕ</p><h3>${escape(task.activity.name)}</h3></div><button class="secondary" data-clear-task>Убрать из плана</button></div><p>${escape(task.activity.description || '')}</p><p class="muted">${task.reasons.map(r => `${escape(r.name)}: ${r.before} → ${r.after}`).join(' · ')}</p><button data-complete="${escape(task.activity.id)}">Завершить шаг</button></article>`;
}
function renderChoices(e) {
  const catalog = e.available_activities.filter(r => !taskSkill || r.reasons.some(reason => reason.skill === taskSkill));
  $('choice-results').innerHTML = `<p class="muted" role="status">Доступных шагов: ${catalog.length}</p><div class="recommendations">${catalog.map(recommendationCard).join('') || '<article class="empty"><h3>Пока нет доступных шагов</h3><p>Выберите другой навык или обсудите цель и каталог активностей с HR.</p></article>'}</div>`;
}
function completedTask(e) {
  const items = e.history.filter(h => (!h.status || h.status === 'completed') && h.recorded_at)
    .map(h => ({ title: state.activities.find(a => a.id === h.activity_id)?.name || h.activity_id, date: h.recorded_at }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  if (!items.length) return '';
  const last = items[0];
  return `<article class="completed-task"><span class="completion-check" aria-hidden="true">✓</span><div><span class="status completed">Шаг выполнен</span><h3>${escape(last.title)}</h3><p class="muted">${dateLabel(last.date)} · Прогресс сохранён, рекомендации обновлены.</p></div><button class="secondary" data-route-panel="history">Посмотреть историю</button></article>`;
}
function render() {
  const e = state.employees.find(employee => employee.id === selected);
  const plan = e.progression;
  const goal = plan.active_goal;
  const initials = e.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('');
  const skills = Object.entries(e.skills).map(([id, value]) => ({ id, name: skillName(id), value })).sort(byName);
  const gaps = [...(goal?.gaps || [])].sort(byName);
  const choiceGaps = [...new Map([...gaps, ...plan.upcoming_goals.flatMap(g => g.gaps)].filter(g => g.gap).map(g => [g.skill, g])).values()].sort(byName);
  const history = e.history.slice().sort((a, b) => Date.parse(b.recorded_at || b.completed_at) - Date.parse(a.recorded_at || a.completed_at));
  $('route').innerHTML = `
    <article class="profile-summary">
      <div class="profile-identity"><div class="avatar" aria-hidden="true">${escape(initials)}</div><div><h2>${escape(e.name)}</h2><p>${escape(e.role || 'Сотрудник')}${e.department ? ` · ${escape(e.department)}` : ''}</p><small>Стаж: ${escape(e.tenure_months ?? '—')} мес.</small></div></div>
      <div class="career-path"><div class="path-step"><small>Текущий грейд</small><strong>${escape(gradeName(e.grade))}</strong></div><span class="path-arrow" aria-hidden="true">→</span><div class="path-step"><small>Цель развития</small><strong id="active-goal-name">${escape(goal?.label || goal?.name || 'Согласовать новую цель')}</strong></div></div>
      <div class="readiness"><div><strong>${goal ? `${goal.readiness}%` : '—'}</strong><span>Покрытие активной цели</span></div><progress aria-label="Покрытие активной цели" max="100" value="${goal?.readiness ?? 0}"></progress><small>${goal ? `${gaps.filter(g => !g.gap).length} из ${gaps.length} навыков на нужном уровне` : 'Обсудите следующий этап с HR'}</small></div>
    </article>
    ${plan.completed_goals.length ? `<aside class="achieved-goals"><p><b>Требования уже выполнены:</b> ${plan.completed_goals.map(g => `<span>✓ ${escape(g.label || g.name)}</span>`).join(' ')}</p><small>Маршрут перешёл к следующей цели. Повышение грейда согласуется с компанией.</small></aside>` : ''}
    <article class="step-progress" aria-label="Завершённые шаги"><div><strong id="completed-step-count">${e.history.filter(h => !h.status || h.status === 'completed').length}</strong><span>Шагов завершено</span></div><p>Завершённые активности из вашей истории. Покрытие активной цели рассчитывается по уровням навыков.</p><button class="secondary" data-route-panel="history">История шагов</button></article>
    ${activeTask(e)}
    ${completedTask(e)}
    <nav class="subnav" aria-label="Разделы маршрута">
      <button data-route-panel="recommendations" aria-controls="route-recommendations" aria-pressed="true">Рекомендации</button>
      <button data-route-panel="choices" aria-controls="route-choices" aria-pressed="false">Все шаги</button>
      <button data-route-panel="skills" aria-controls="route-skills" aria-pressed="false">Навыки</button>
      <button data-route-panel="history" aria-controls="route-history" aria-pressed="false">История <span class="tab-count">${e.history.length}</span></button>
    </nav>
    <div id="route-recommendations" class="panel-body">
      <div class="section-heading"><div><p class="eyebrow">${goal ? 'АКТИВНАЯ ЦЕЛЬ' : 'МАРШРУТ РАЗВИТИЯ'}</p><h2>${escape(goal?.label || goal?.name || 'Следующий этап развития')}</h2><p class="muted">${escape(plan.message)}</p></div><span class="tag">Шагов: ${plan.recommendations.length}</span></div>
      <div class="recommendations">${plan.recommendations.map(recommendationCard).join('') || `<article class="empty"><h3>${plan.stage === 'complete' ? 'Доступный маршрут пройден' : 'Для этой цели нужны новые активности'}</h3><p>HR может дополнить каталог или согласовать следующую цель развития.</p></article>`}</div>
      <p class="muted">Завершите выбранный шаг — прогресс обновится, и появятся следующие рекомендации. Когда требования цели выполнены, маршрут автоматически перейдёт дальше.</p>
      ${developmentSection(e)}
    </div>
    <div id="route-choices" class="panel-body" hidden><div class="section-heading"><div><h2>Выберите свой следующий шаг</h2><p class="muted">Курсы и мероприятия для активной цели и следующих этапов. Выбор можно изменить.</p></div><div class="task-filter"><label for="task-skill-filter">Какой навык улучшить?</label><select id="task-skill-filter"><option value="">Все навыки с разрывом</option>${choiceGaps.map(g => `<option value="${escape(g.skill)}">${escape(g.name)}</option>`).join('')}</select></div></div><div id="choice-results"></div></div>
    <div id="route-skills" class="panel-body" hidden>
      <div class="skills-layout">
        <article class="panel"><div class="section-heading"><h3>Требования активной цели</h3><span>Текущий / нужный</span></div><p class="muted">По алфавиту. ★ — критичный навык.</p>
          <div class="skill-list scroll-panel">${gaps.length ? gaps.map(g => `<div class="skill-row"><div class="skill-name"><div><b>${escape(g.name)}${g.critical ? ' ★' : ''}</b><small>${g.gap ? `До цели: +${g.gap}` : 'Требование выполнено'}</small></div><span>${g.current} / ${g.required}</span></div><progress aria-label="${escape(g.name)}: ${g.current} из ${g.required}" max="${Math.max(1, g.required)}" value="${Math.min(g.current, g.required)}"></progress></div>`).join('') : '<p class="muted">Требования пока не заданы.</p>'}</div>
        </article>
        <article class="panel"><h3>Все навыки профиля</h3><p class="muted">Текущие уровни по шкале от 0 до 5.</p><div class="skill-tags scroll-panel">${skills.map(s => `<div class="skill-tag"><span>${escape(s.name)}</span><strong>${s.value}</strong></div>`).join('') || '<p class="muted">Навыки пока не добавлены.</p>'}</div></article>
      </div>
    </div>
    <div id="route-history" class="panel-body" hidden>
      <article class="panel"><div class="section-heading"><h3>История участия</h3><span>${history.length} записей</span></div><p class="muted">Сначала последние события.</p><div class="history-list scroll-panel">${history.length ? history.map(h => { const status = h.status || 'completed'; const date = h.recorded_at || h.completed_at; return `<div class="history-item"><div><b>${escape(state.activities.find(a => a.id === h.activity_id)?.name || h.activity_id)}</b><span class="status ${['completed', 'in_progress'].includes(status) ? status : ''}">${escape(statusName(status))}</span></div><time datetime="${escape(date)}">${dateLabel(date)}</time></div>`; }).join('') : '<p class="muted">История пока пуста. Здесь появятся ваши активности.</p>'}</div></article>
    </div>`;
  if (!choiceGaps.some(g => g.skill === taskSkill)) taskSkill = '';
  $('task-skill-filter').value = taskSkill;
  $('task-skill-filter').onchange = event => { taskSkill = event.target.value; renderChoices(e); };
  renderChoices(e);
  setRoutePanel(routePanel);
}
function statusName(status) { return ({ completed: 'Завершено', in_progress: 'В процессе', dropped: 'Прекращено', no_show: 'Пропуск', declined: 'Отказ', overdue: 'Просрочено' })[status] || status; }
function attentionList(employees) {
  return employees.length ? `<div class="attention-list scroll-panel">${[...employees].sort(byName).map(e => `<div><button class="text-button" data-profile="${escape(e.id)}">${escape(e.name)}</button>${e.reason ? `<small>${escape(e.reason)}</small>` : ''}</div>`).join('')}</div>` : '<p class="muted">Таких сотрудников нет.</p>';
}
function renderHR() {
  if (state.role !== 'hr') { $('hr').textContent = ''; $('team-table').textContent = ''; $('data-notes').textContent = ''; return; }
  const advancing = state.employees.filter(e => e.progression.active_goal);
  const average = advancing.length ? Math.round(advancing.reduce((sum, e) => sum + e.progression.active_goal.readiness, 0) / advancing.length) + '%' : '—';
  const h = state.hr;
  $('hr').innerHTML = `<div class="metrics">
    <article><p>Сотрудников в команде</p><strong>${state.employees.length}</strong><small>В текущем наборе</small></article>
    <article><p>Среднее покрытие активных целей</p><strong>${average}</strong><small>Для сотрудников с заданной целью</small></article>
    <article><p>Достигли целей развития</p><strong>${state.employees.filter(e => e.progression.completed_goals.length).length}</strong><small>Готовы продолжать маршрут развития</small></article>
    </div>${h ? `<div class="hr-grid">
      <article class="panel"><div class="section-heading"><h3>Навыки, которым нужно внимание</h3><span>Топ-8</span></div><p class="muted">Количество сотрудников с разрывом до целевого уровня.</p><div class="bar-list">${h.deficits.slice(0, 8).map(s => `<div class="bar-row"><span>${escape(s.name)}</span><strong>${s.count}</strong><progress aria-label="${escape(s.name)}: ${s.count} сотрудников" max="${state.employees.length}" value="${s.count}"></progress></div>`).join('') || '<p class="muted">Разрывов нет.</p>'}</div>
      <details class="compact-details"><summary>Все дефициты (${h.deficits.length})</summary><div class="table-wrap scroll-panel"><table><thead><tr><th>Навык</th><th>Сотрудников</th></tr></thead><tbody>${[...h.deficits].sort(byName).map(s => `<tr><td>${escape(s.name)}</td><td>${s.count}</td></tr>`).join('')}</tbody></table></div></details></article>
      <div><article class="panel"><div class="section-heading"><h3>Без шага из каталога</h3><span class="tag">${h.no_step.length}</span></div><p class="muted">Проверьте цель и доступность курсов. Шаги следующих целей также учитываются.</p><details class="compact-details"><summary>Посмотреть сотрудников</summary>${attentionList(h.no_step)}</details></article>
      <article class="panel"><div class="section-heading"><h3>Без участия 90 дней</h3><span class="tag">${h.inactive.length}</span></div><p class="muted">Повод обсудить удобный формат развития.</p><details class="compact-details"><summary>Посмотреть сотрудников</summary>${attentionList(h.inactive)}</details></article></div>
    </div><article class="panel"><details class="compact-details"><summary>Участие по активностям (${h.participation.length})</summary><div class="table-wrap scroll-panel"><table><thead><tr><th>Активность</th><th>Записей</th><th>Статусы</th></tr></thead><tbody>${[...h.participation].sort(byName).map(a => `<tr><td>${escape(a.name)}</td><td>${a.total}</td><td>${Object.entries(a.counts).map(([k, v]) => `${escape(statusName(k))}: ${v}`).join('; ') || 'Нет участия'}</td></tr>`).join('')}</tbody></table></div></details></article>` : ''}
    <p class="muted">Покрытие — доля достигнутых уровней в требованиях цели. Повышение автоматически не назначается.</p>`;
  $('data-notes').innerHTML = `<p><b>Источник</b><span>${state.demo ? 'Демонстрационный набор' : 'Стартовый набор'}</span></p><p><b>Профилей / активностей</b><span>${state.employees.length} / ${state.activities.length}</span></p><p><b>Модель рекомендаций</b><span>${escape(state.model || 'Локальная статистическая модель')}</span></p><p class="muted">Повторных завершений без повторного начисления: ${state.warnings || 0}. Прогнозы не используются для публичного рейтинга сотрудников.</p>`;
  renderTeam();
  setHRPanel(hrPanel);
}
function renderTeam() {
  const query = $('team-search').value.trim().toLocaleLowerCase('ru');
  const employees = employeesByName().filter(e => [e.name, e.role, e.department].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(query));
  const pages = Math.max(1, Math.ceil(employees.length / pageSize));
  teamPage = Math.min(Math.max(0, teamPage), pages - 1);
  const start = teamPage * pageSize;
  $('team-table').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th>Грейд → цель</th><th>Покрытие</th><th>Навыки с разрывом</th></tr></thead><tbody>${employees.slice(start, start + pageSize).map(e => `<tr><td><button class="text-button" data-profile="${escape(e.id)}">${escape(e.name)}</button><small>${escape(e.role || '')}</small></td><td>${escape(gradeName(e.grade))} → ${escape(targetName(e))}</td><td>${coverage(e)}</td><td>${routeGaps(e).filter(g => g.gap).length ? `${routeGaps(e).filter(g => g.gap).length} из ${routeGaps(e).length}` : e.progression.active_goal ? 'Нет разрывов' : 'Согласовать цель'}</td></tr>`).join('') || '<tr><td colspan="4">Ничего не найдено. Попробуйте другое имя, роль или отдел.</td></tr>'}</tbody></table></div>
    <div class="pagination"><span role="status" aria-live="polite">${employees.length ? `${start + 1}–${Math.min(start + pageSize, employees.length)} из ${employees.length}` : '0 сотрудников'}</span><div><button class="secondary" data-team-page="${teamPage - 1}" ${teamPage === 0 ? 'disabled' : ''} aria-label="Предыдущая страница">← Назад</button><button class="secondary" data-team-page="${teamPage + 1}" ${teamPage >= pages - 1 ? 'disabled' : ''} aria-label="Следующая страница">Далее →</button></div></div>`;
}
function setRoutePanel(name) {
  routePanel = name;
  for (const button of document.querySelectorAll('[data-route-panel]')) button.setAttribute('aria-pressed', String(button.dataset.routePanel === name));
  for (const key of ['recommendations', 'choices', 'skills', 'history']) $(`route-${key}`).hidden = key !== name;
}
function setHRPanel(name) {
  hrPanel = name;
  for (const button of document.querySelectorAll('[data-hr-panel]')) button.setAttribute('aria-pressed', String(button.dataset.hrPanel === name));
  for (const key of ['overview', 'employees', 'data']) $(`hr-${key}`).hidden = key !== name;
}
function tab(hr) {
  $('hr-view').hidden = !hr; $('employee-view').hidden = hr;
  $('hr-tab').setAttribute('aria-pressed', String(hr)); $('employee-tab').setAttribute('aria-pressed', String(!hr));
}
function selectEmployee(id) {
  notice(''); $('access-result').textContent = '';
  selected = id; routePanel = 'recommendations'; taskSkill = '';
  $('employee-select').value = selected;
  render();
}
$('employee-tab').onclick = () => tab(false);
$('hr-tab').onclick = () => tab(true);
$('employee-select').onchange = event => selectEmployee(event.target.value);
$('team-search').oninput = () => { teamPage = 0; renderTeam(); };
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.routePanel) setRoutePanel(button.dataset.routePanel);
  if (button.dataset.hrPanel) setHRPanel(button.dataset.hrPanel);
  if (button.dataset.teamPage !== undefined) { teamPage = Number(button.dataset.teamPage); renderTeam(); }
  if (button.dataset.profile) { selectEmployee(button.dataset.profile); tab(false); $('employee-select').focus(); }
  if (button.dataset.chooseId || button.hasAttribute('data-clear-task')) {
    button.disabled = true;
    try {
      const clearing = button.hasAttribute('data-clear-task');
      await api('/api/plan', { employee_id: selected, source: button.dataset.chooseSource, task_id: clearing ? null : button.dataset.chooseId });
      await refresh();
      notice(clearing ? 'Шаг убран из плана. Можно выбрать другой.' : 'Шаг добавлен в план. После завершения маршрут обновится.');
      if (!clearing) $('route').querySelector('.active-task')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) { notice(error.message, true); button.disabled = false; }
  }
  if (button.dataset.complete) {
    button.disabled = true;
    try {
      const previousGoal = state.employees.find(e => e.id === selected).progression.active_goal?.id;
      const result = await api('/api/complete', { employee_id: selected, activity_id: button.dataset.complete });
      await refresh();
      const plan = state.employees.find(e => e.id === selected).progression;
      const advanced = previousGoal && plan.active_goal?.id !== previousGoal;
      const next = advanced && plan.active_goal ? ` Следующая цель: ${plan.active_goal.label}.` : ' Рекомендации обновлены.';
      notice(`Шаг завершён. ${result.changes.map(c => `${skillName(c.skill)}: ${c.before} → ${c.after}`).join('; ')}.${next}`);
    } catch (error) { notice(error.message, true); button.disabled = false; }
  }
});
$('import-button').onclick = async () => {
  try {
    const files = [...$('import-file').files];
    if (files.reduce((sum, f) => sum + f.size, 0) > 8 * 1024 * 1024) throw new Error('Максимальный размер — 8 МБ.');
    const file = name => files.find(f => f.name.toLowerCase() === name);
    const read = async (name, json = true) => { const f = file(name); if (!f) throw new Error(`Нужен ${name}`); const text = await f.text(); return json ? JSON.parse(text) : text; };
    const data = { mode: $('import-mode').value, employees: await read('employees.json'), history: await read('activity_history.csv', false) };
    if (data.mode === 'full') { data.skills = await read('skills.json'); data.events = await read('events.json'); }
    if (!confirm('Применить импорт? Совпадающие профили и их история будут заменены; коды сотрудников отозваны.')) return;
    const result = await api('/api/import', data);
    await refresh(); notice(`В наборе сотрудников: ${result.imported}. Предупреждений о повторах: ${result.warnings}.`);
  } catch (error) { notice(error.message, true); }
};
$('reset-button').onclick = async () => {
  if (!confirm('Восстановить исходный набор? Все изменения и коды сотрудников будут сброшены.')) return;
  try { await api('/api/reset', {}); await refresh(); notice('Исходный набор восстановлен.'); }
  catch (error) { notice(error.message, true); }
};
function showLogin() {
  state = null; selected = null; routePanel = 'recommendations'; hrPanel = 'overview'; teamPage = 0; taskSkill = '';
  $('workspace').hidden = true; $('login-panel').hidden = false;
  for (const id of ['route', 'hr', 'team-table', 'data-notes', 'access-result', 'employee-select', 'mode']) $(id).textContent = '';
  $('team-search').value = '';
  tab(false);
}
$('login-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/login', { login: $('login-name').value.trim(), password: $('login-password').value }); $('login-password').value = ''; await refresh(); notice('Вход выполнен.'); }
  catch (error) { notice(error.message, true); }
};
$('logout-button').onclick = async () => { try { await api('/api/logout', {}); showLogin(); notice('Вы вышли.'); } catch (error) { notice(error.message, true); } };
$('access-button').onclick = async () => {
  try { const access = await api('/api/access', { employee_id: selected }); $('access-result').textContent = `Передайте сотруднику лично. Логин: ${access.login}. Код: ${access.password}`; }
  catch (error) { notice(error.message, true); }
};
refresh().catch(error => notice(error.message, true));
