'use strict';
const { createHash } = require('node:crypto');

// Supplemental exercises use local templates, not generated official events or
// evidence of a skill level. Catalog eligibility and grade calculations stay intact.
const formats = {
  engineering: ['схему или минимальный технический пример', 'Описать входные данные, результат и один отказный сценарий.'],
  frontend: ['небольшой прототип интерфейса', 'Проверить основной сценарий, клавиатуру и узкий экран.'],
  quality: ['набор из пяти тест-кейсов', 'Включить обычный, граничный и ошибочный сценарии с ожидаемым результатом.'],
  data: ['мини-разбор синтетических данных', 'Указать вопрос, метод проверки и ограничение сделанного вывода.'],
  product: ['одностраничное описание учебного продуктового кейса', 'Сформулировать проблему пользователя, гипотезу и критерий успеха.'],
  hr: ['разбор вымышленной рабочей ситуации', 'Отделить факты от предположений и записать вопросы для профильного специалиста.'],
  sales: ['сценарий разговора с вымышленным клиентом', 'Сформулировать потребность, три уточняющих вопроса и следующий шаг.'],
  support: ['ответ на вымышленное обращение', 'Указать уточнения, порядок диагностики и условие передачи специалисту.'],
  communication: ['короткое выступление или сообщение для коллеги', 'Сформулировать одну главную мысль, пример и ожидаемое действие.'],
  leadership: ['сценарий учебного разговора с участником команды', 'Сформулировать цель разговора, открытые вопросы и конкретную договорённость.'],
  collaboration: ['разбор ситуации совместной работы', 'Описать позиции участников, общую цель и способ проверить договорённость.'],
  thinking: ['разбор небольшой учебной проблемы', 'Сравнить два варианта, перечислить предположения и способ их проверить.'],
  personal_effectiveness: ['план одного учебного рабочего дня', 'Выделить приоритет, ограничение по времени и резервный вариант.']
};
const phases = ['Разобрать пример', 'Применить на практике', 'Проверить решение'];
const historyFor = (data, employeeId) => (data.practice_completions || []).filter(item => item.employee_id === employeeId);

function taskFor(data, employee, gap, phase, priorCount) {
  const skill = data.skills.find(s => s.id === gap.skill);
  const [artifact, check] = formats[skill?.category] || ['небольшой учебный пример применения навыка', 'Показать исходную задачу, способ решения и проверку результата.'];
  const role = employee.next_grade.role || employee.role || 'ваша роль';
  const goal = `${role} · ${employee.next_grade.name}`;
  const interrupted = employee.history.filter(h => ['no_show', 'declined', 'dropped'].includes(h.status)).length;
  const minutes = interrupted ? 15 : 25;
  const contexts = [
    [`Выберите ${artifact} по теме «${gap.name}» для роли «${role}». Используйте учебные или синтетические данные.`, 'Выделите три основных решения и объясните, зачем нужно каждое.', `${check} Запишите один вопрос, который остался непонятным.`],
    [`Подготовьте ${artifact} по теме «${gap.name}» для роли «${role}». Измените одно условие разобранного примера.`, check, 'Кратко объясните выбор решения и сохраните результат для обсуждения с наставником.'],
    [`Вернитесь к своему решению по навыку «${gap.name}» и проверьте его при изменении одного условия.`, 'Найдите одно ограничение или ошибку; опишите исправление и повторную проверку.', 'Запишите, что теперь получается самостоятельно, а что стоит проверить с наставником.']
  ];
  const id = 'practice-' + createHash('sha256').update(JSON.stringify([employee.id, employee.next_grade.id, gap.skill, gap.current, gap.required, phase])).digest('hex').slice(0, 24);
  return {
    id, source: 'local_template', title: `${phases[phase]}: ${gap.name}`, skill: gap.skill, skill_name: gap.name,
    current: gap.current, required: gap.required, critical: gap.critical, phase: phase + 1,
    target_id: employee.next_grade.id, target: goal, minutes, steps: contexts[phase],
    checks: ['Есть конкретный учебный пример или результат.', 'Описаны проверка результата и ограничения.', 'Сформулирован вывод или вопрос для наставника.'],
    reasons: [
      `Цель: ${goal}. Навык «${gap.name}» входит в её требования.`,
      `Текущий уровень ${gap.current}, требуется ${gap.required}; разрыв ${gap.gap}.${gap.critical ? ' Навык критичен для цели.' : ''}`,
      interrupted ? `В истории есть ${interrupted} незавершённых участий. Предлагается короткая практика на ${minutes} минут без расписания.` : 'Практика доступна сейчас, без ожидания сессии или записи на курс.',
      priorCount ? `По этому навыку уже выполнено ${priorCount} практических заданий для текущей цели; следующий этап — ${phases[phase].toLowerCase()}.` : 'Начинаем с разбора примера; выполненные этапы не предлагаются повторно.'
    ]
  };
}

function practicePlan(data, employee) {
  const completed = historyFor(data, employee.id);
  const result = { mode: 'local_templates', tasks: [], available_tasks: [], completed, reason: 'catalog_available' };
  if (!employee.next_grade) return { ...result, reason: 'no_target' };
  const missing = employee.gaps.filter(g => g.gap > 0);
  if (!missing.length) return { ...result, reason: 'target_met' };
  if (employee.recommendations.length > 1) return result;
  const done = new Set(completed.map(item => item.task.id));
  const covered = new Set(employee.recommendations.flatMap(r => r.reasons.map(reason => reason.skill)));
  const candidates = missing.flatMap(gap => {
    const priorCount = completed.filter(item => item.task.skill === gap.skill && item.task.target_id === employee.next_grade.id).length;
    for (let phase = 0; phase < phases.length; phase++) {
      const task = taskFor(data, employee, gap, phase, priorCount);
      if (!done.has(task.id)) return [{ task, priorCount, score: gap.gap * (gap.critical ? 2 : 1), covered: covered.has(gap.skill) }];
    }
    return [];
  });
  // Prefer untouched gaps and rotate skills instead of repeating one exercise.
  candidates.sort((a, b) => Number(a.covered) - Number(b.covered) || a.priorCount - b.priorCount || b.score - a.score || a.task.id.localeCompare(b.task.id));
  result.available_tasks = candidates.map(item => item.task);
  result.tasks = result.available_tasks.slice(0, 3 - employee.recommendations.length);
  result.reason = result.tasks.length ? 'low_catalog' : 'practice_exhausted';
  return result;
}

function completePractice(data, employee, taskId, reflection = '') {
  if (!employee) throw new Error('Сотрудник не найден.');
  if (typeof taskId !== 'string') throw new Error('Укажите задание.');
  if (historyFor(data, employee.id).some(item => item.task.id === taskId)) throw new Error('Практика уже отмечена выполненной.');
  const task = practicePlan(data, employee).available_tasks.find(item => item.id === taskId);
  if (!task) throw new Error('Задание больше не актуально. Обновите маршрут.');
  if (typeof reflection !== 'string' || reflection.length > 2000) throw new Error('Комментарий должен быть строкой не длиннее 2000 символов.');
  const completion = { employee_id: employee.id, task, reflection: reflection.trim(), completed_at: new Date().toISOString() };
  data.practice_completions ||= [];
  data.practice_completions.push(completion);
  data.task_choices = (data.task_choices || []).filter(choice => !(choice.employee_id === employee.id && choice.source === 'practice' && choice.task_id === taskId));
  return completion;
}

module.exports = { practicePlan, completePractice };
