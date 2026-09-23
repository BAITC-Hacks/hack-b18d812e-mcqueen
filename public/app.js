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
  if (!response.ok) throw new Error(data.error || 'Ошибка запроса.');
  return data;
}
async function refresh() {
  state = await api('/api/state');
  if (!state.employees.some(e => e.id === selected)) selected = state.employees[0].id;
  $('employee-select').innerHTML = state.employees.map(e => `<option value="${escape(e.id)}">${escape(e.name)}</option>`).join('');
  $('employee-select').value = selected;
  $('mode').textContent = state.demo ? 'Демо · Все профили и активности вымышлены' : 'Импортированный набор · Локальное хранение';
  render();
}
function render() {
  const e = state.employees.find(e => e.id === selected);
  const ready = e.gaps.every(g => g.gap === 0);
  $('route').innerHTML = `
    <div class="metrics"><article><p>Текущий грейд</p><strong>${escape(gradeName(e.grade))}</strong></article><article><p>Следующая цель</p><strong>${escape(e.next_grade?.name || 'Верхний грейд')}</strong></article><article><p>Покрытие требований</p><strong>${e.next_grade ? e.readiness + '%' : '—'}</strong></article></div>
    <h2>Карта навыков</h2><div class="skills">${e.gaps.length ? e.gaps.map(g => `<article><div class="row"><h3>${escape(g.name)}</h3><span>${g.current} / ${g.required}</span></div><progress max="${Math.max(1, g.required)}" value="${Math.min(g.current, g.required)}"></progress><p class="muted">${g.gap ? `До цели: +${g.gap}` : 'Требование выполнено'}</p></article>`).join('') : '<article>Следующий грейд не задан.</article>'}</div>
    <div class="section-heading"><h2>Рекомендуем начать здесь</h2><span>До 3 активностей</span></div><p class="muted">Сначала активности, которые закрывают больше уровней недостающих навыков. Завершённые активности исключены; входные требования проверены. Каждая рекомендация оценена отдельно.</p>
    <div class="recommendations">${e.recommendations.length ? e.recommendations.map((r, i) => `<article><span class="rank">ШАГ ${i + 1} · +${r.score} к требованиям</span><h3>${escape(r.activity.name)}</h3><p>${escape(r.activity.description || '')}</p><div class="reasons">${r.reasons.map(reason => `<p><b>${escape(reason.name)}</b>: ${reason.before} → ${reason.after}; цель ${reason.required}. Закроет ${reason.covered} ур. разрыва. Предел активности: ${reason.max_level}.</p>`).join('')}</div><button data-complete="${escape(r.activity.id)}">Отметить завершение</button></article>`).join('') : `<article class="empty">${!e.next_grade ? 'Достигнут последний грейд в этом наборе.' : ready ? 'Требования следующего грейда выполнены. Обсудите повышение с HR.' : 'Подходящих активностей нет. HR может дополнить каталог или проверить входные требования.'}</article>`}</div>
    <h2>История участия</h2><div class="history">${e.history.length ? e.history.slice().reverse().map(h => `<p><span>${escape(state.activities.find(a => a.id === h.activity_id)?.name || h.activity_id)}</span><time>${escape(new Date(h.completed_at).toLocaleDateString('ru-RU'))}</time></p>`).join('') : '<p>Пока нет завершённых активностей.</p>'}</div>`;
  const advancing = state.employees.filter(e => e.next_grade);
  const average = advancing.length ? Math.round(advancing.reduce((sum, e) => sum + e.readiness, 0) / advancing.length) + '%' : '—';
  $('hr').innerHTML = `<div class="metrics"><article><p>Сотрудников</p><strong>${state.employees.length}</strong></article><article><p>Среднее покрытие требований</p><strong>${average}</strong></article><article><p>Готовы к обсуждению повышения</p><strong>${advancing.filter(e => e.gaps.every(g => !g.gap)).length}</strong></article></div><h2>Развитие команды</h2><div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th>Грейд → цель</th><th>Покрытие</th><th>Разрывы навыков</th><th>Завершено</th></tr></thead><tbody>${state.employees.map(e => `<tr><td><button class="text-button" data-profile="${escape(e.id)}">${escape(e.name)}</button></td><td>${escape(gradeName(e.grade))} → ${escape(e.next_grade?.name || '—')}</td><td>${e.next_grade ? e.readiness + '%' : '—'}</td><td>${e.gaps.filter(g => g.gap).map(g => `${escape(g.name)} +${g.gap}`).join(', ') || 'Нет'}</td><td>${e.history.length}</td></tr>`).join('')}</tbody></table></div><p class="muted">Покрытие — доля достигнутых уровней в требованиях следующего грейда. Повышение автоматически не назначается.</p>`;
}
function tab(hr) {
  $('hr-view').hidden = !hr; $('employee-view').hidden = hr;
  $('hr-tab').setAttribute('aria-pressed', String(hr)); $('employee-tab').setAttribute('aria-pressed', String(!hr));
}
$('employee-tab').onclick = () => tab(false);
$('hr-tab').onclick = () => tab(true);
$('employee-select').onchange = event => { selected = event.target.value; render(); };
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.profile) { selected = button.dataset.profile; $('employee-select').value = selected; tab(false); render(); }
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
    const file = $('import-file').files[0];
    if (!file) throw new Error('Выберите JSON-файл.');
    if (file.size > 2 * 1024 * 1024) throw new Error('Максимальный размер — 2 МБ.');
    const data = JSON.parse(await file.text());
    if (!confirm('Заменить текущие профили, каталог и историю данными из файла?')) return;
    const result = await api('/api/import', data);
    await refresh(); notice(`Импортировано сотрудников: ${result.imported}.`);
  } catch (error) { notice(error.message, true); }
};
$('reset-button').onclick = async () => {
  if (!confirm('Заменить текущий набор и историю синтетическими демоданными?')) return;
  try { await api('/api/reset', {}); await refresh(); notice('Демонстрационный набор восстановлен.'); }
  catch (error) { notice(error.message, true); }
};
refresh().catch(error => notice(`Не удалось загрузить данные: ${error.message}`, true));
