'use strict';
let state;
let selected;
const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const gradeName = id => state.grades.find(g => g.id === id)?.name || id;
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : 'success'; }
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(data.error || 'Ошибка запроса.'); }
  return data;
}
async function refresh() {
  state = await api('/api/state');
  $('login-panel').hidden = true; $('workspace').hidden = false;
  $('hr-tab').hidden = state.role !== 'hr'; $('access-button').hidden = state.role !== 'hr';
  if (state.role !== 'hr') tab(false);
  if (!state.employees.length) throw new Error('Профиль недоступен. Обратитесь к HR.');
  if (!state.employees.some(e => e.id === selected)) selected = state.employees[0].id;
  $('employee-select').innerHTML = state.employees.map(e => `<option value="${escape(e.id)}">${escape(e.name)}</option>`).join('');
  $('employee-select').value = selected;
  $('mode').textContent = state.demo ? 'Демо · Все профили и активности вымышлены' : `Стартовый набор · Дата среза ${state.as_of || '—'} · ${state.model}`;
  render(); hrDetails();
}
function render() {
  const e = state.employees.find(e => e.id === selected);
  const ready = e.gaps.every(g => g.gap === 0);
  $('route').innerHTML = `
    <p><b>${escape(e.role || "Сотрудник")}</b> · ${escape(e.department || "")} · Стаж: ${e.tenure_months ?? "—"} мес.</p><div class="metrics"><article><p>Текущий грейд</p><strong>${escape(gradeName(e.grade))}</strong></article><article><p>Следующая цель</p><strong>${escape(e.next_grade?.name || 'Верхний грейд')}</strong></article><article><p>Покрытие требований</p><strong>${e.next_grade ? e.readiness + '%' : '—'}</strong></article></div>
    <h2>Все навыки профиля</h2><p>${Object.entries(e.skills).map(([id, value]) => `${escape(state.skills.find(s => s.id === id)?.name || id)}: ${value}`).join(" · ")}</p><h2>Требования следующего грейда</h2><div class="skills">${e.gaps.length ? e.gaps.map(g => `<article><div class="row"><h3>${escape(g.name)}${g.critical ? " ★" : ""}</h3><span>${g.current} / ${g.required}</span></div><progress max="${Math.max(1, g.required)}" value="${Math.min(g.current, g.required)}"></progress><p class="muted">${g.gap ? `До цели: +${g.gap}` : 'Требование выполнено'}</p></article>`).join('') : '<article>Следующий грейд не задан.</article>'}</div>
    <div class="section-heading"><h2>Рекомендуем начать здесь</h2><span>До 3 активностей</span></div><p class="muted">Учитываются критичные навыки, роль, грейд, расписание и история участия. Локальная модель оценивает вероятность завершения. ★ — критичный навык. Участие добровольное.</p>
    <div class="recommendations">${e.recommendations.length ? e.recommendations.map((r, i) => `<article><span class="rank">ВАРИАНТ ${i + 1} · оценка ${r.score}</span><h3>${escape(r.activity.name)}</h3><p>${escape(r.activity.description || '')}</p><p>${escape(r.explanation)}</p><p class="muted">Оценка завершения: ${Math.round(r.behavior.probability * 100)}% — модельный прогноз, не гарантия.</p><div class="reasons">${r.reasons.map(reason => `<p><b>${escape(reason.name)}</b>: ${reason.before} → ${reason.after}; цель ${reason.required}. Закроет ${reason.covered} ур. разрыва. Предел активности: ${reason.max_level}.</p>`).join('')}</div><button data-complete="${escape(r.activity.id)}">Отметить завершение</button></article>`).join('') : `<article class="empty">${!e.next_grade ? 'Достигнут последний грейд в этом наборе.' : ready ? 'Требования следующего грейда выполнены. Обсудите повышение с HR.' : 'Подходящих активностей нет. HR может дополнить каталог или проверить входные требования.'}</article>`}</div>
    <h2>История участия</h2><div class="history">${e.history.length ? e.history.slice().reverse().map(h => `<p><span>${escape(state.activities.find(a => a.id === h.activity_id)?.name || h.activity_id)} · ${escape(statusName(h.status || "completed"))}</span><time>${escape(new Date(h.completed_at).toLocaleDateString('ru-RU'))}</time></p>`).join('') : '<p>Пока нет завершённых активностей.</p>'}</div>`;
  if (state.role !== 'hr') { $('hr').innerHTML = ''; return; }
  const advancing = state.employees.filter(e => e.next_grade);
  const average = advancing.length ? Math.round(advancing.reduce((sum, e) => sum + e.readiness, 0) / advancing.length) + '%' : '—';
  $('hr').innerHTML = `<div class="metrics"><article><p>Сотрудников</p><strong>${state.employees.length}</strong></article><article><p>Среднее покрытие требований</p><strong>${average}</strong></article><article><p>Готовы к обсуждению повышения</p><strong>${advancing.filter(e => e.gaps.every(g => !g.gap)).length}</strong></article></div><h2>Развитие команды</h2><div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th>Грейд → цель</th><th>Покрытие</th><th>Разрывы навыков</th><th>Завершено</th></tr></thead><tbody>${state.employees.map(e => `<tr><td><button class="text-button" data-profile="${escape(e.id)}">${escape(e.name)}</button></td><td>${escape(gradeName(e.grade))} → ${escape(e.next_grade?.name || '—')}</td><td>${e.next_grade ? e.readiness + '%' : '—'}</td><td>${e.gaps.filter(g => g.gap).map(g => `${escape(g.name)} +${g.gap}`).join(', ') || 'Нет'}</td><td>${e.history.filter(h => (h.status || "completed") === "completed").length}</td></tr>`).join('')}</tbody></table></div><p class="muted">Покрытие — доля достигнутых уровней в требованиях следующего грейда. Повышение автоматически не назначается.</p>`;
}
function statusName(status) { return ({completed:'Завершено', in_progress:'В процессе', dropped:'Прекращено', no_show:'Пропуск', declined:'Отказ', overdue:'Просрочено'})[status] || status; }
function hrDetails() {
  if (state.role !== 'hr' || !state.hr) return;
  const h = state.hr;
  $('hr').insertAdjacentHTML('beforeend', `<h2>Частые разрывы навыков</h2><div class="table-wrap"><table><thead><tr><th>Навык</th><th>Сотрудников с разрывом</th></tr></thead><tbody>${h.deficits.map(s => `<tr><td>${escape(s.name)}</td><td>${s.count}</td></tr>`).join('')}</tbody></table></div><h2>Без рекомендованного шага (${h.no_step.length})</h2><div class="history">${h.no_step.map(e => `<p>${escape(e.name)}: ${escape(e.reason)}</p>`).join('') || '<p>Нет</p>'}</div><h2>Нет участия за 90 дней (${h.inactive.length})</h2><div class="history">${h.inactive.map(e => `<p>${escape(e.name)}</p>`).join('') || '<p>Нет</p>'}</div><h2>Участие по активностям</h2><div class="table-wrap"><table><thead><tr><th>Активность</th><th>Записей</th><th>Статусы</th></tr></thead><tbody>${h.participation.map(a => `<tr><td>${escape(a.name)}</td><td>${a.total}</td><td>${Object.entries(a.counts).map(([k,v]) => `${escape(statusName(k))}: ${v}`).join('; ')}</td></tr>`).join('')}</tbody></table></div><p class="muted">Повторные завершения в источнике без повторного начисления: ${state.warnings}. Прогнозы модели не используются для публичного рейтинга сотрудников.</p>`);
}
function tab(hr) {
  $('hr-view').hidden = !hr; $('employee-view').hidden = hr;
  $('hr-tab').setAttribute('aria-pressed', String(hr)); $('employee-tab').setAttribute('aria-pressed', String(!hr));
}
$('employee-tab').onclick = () => tab(false);
$('hr-tab').onclick = () => tab(true);
$('employee-select').onchange = event => { $('access-result').textContent = ''; selected = event.target.value; render(); hrDetails(); };
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.profile) { selected = button.dataset.profile; $('employee-select').value = selected; tab(false); render(); hrDetails(); }
  if (button.dataset.complete) {
    button.disabled = true;
    try {
      const result = await api('/api/complete', { employee_id: selected, activity_id: button.dataset.complete });
      await refresh();
      notice(`Завершение сохранено. ${result.changes.map(c => `${state.skills.find(s => s.id === c.skill).name}: ${c.before} → ${c.after}`).join('; ')}`);
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
  state = null; selected = null;
  $('workspace').hidden = true; $('login-panel').hidden = false;
  for (const id of ['route','hr','access-result','employee-select']) $(id).textContent = '';
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
