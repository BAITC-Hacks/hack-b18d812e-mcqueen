'use strict';
// Local empirical Bayesian model: no remote inference or exported profiles.
const finished = h => (h.status || 'completed') === 'completed';
const negative = h => ['no_show', 'declined', 'dropped'].includes(h.status);
function train(data) {
  const buckets = new Map();
  const events = new Map(data.activities.map(a => [a.id, a]));
  for (const employee of data.employees) for (const h of employee.history) {
    if (!finished(h) && !negative(h)) continue;
    const event = events.get(h.activity_id);
    if (!event || event.mandatory) continue;
    const key = `${event.type || 'activity'}|${event.format || 'any'}`;
    const bucket = buckets.get(key) || { success: 0, total: 0 };
    bucket.total++; if (finished(h)) bucket.success++;
    buckets.set(key, bucket);
  }
  return buckets;
}
function predict(model, data, employee, activity) {
  const key = `${activity.type || 'activity'}|${activity.format || 'any'}`;
  const bucket = model.get(key) || { success: 0, total: 0 };
  const relevant = employee.history.filter(h => {
    const prior = data.activities.find(a => a.id === h.activity_id);
    return prior && !prior.mandatory && (prior.id === activity.id || (prior.type === activity.type && prior.format === activity.format));
  });
  const successes = relevant.filter(finished).length;
  const failures = relevant.filter(negative).length;
  // Leave this employee out of the cohort prior to avoid double-counting history.
  const cohortSuccess = Math.max(0, bucket.success - successes);
  const cohortTotal = Math.max(0, bucket.total - successes - failures);
  const prior = (cohortSuccess + 1) / (cohortTotal + 2);
  const probability = (2 * prior + successes) / (2 + successes + failures);
  return { probability, successes, failures, observations: successes + failures,
    explanation: successes + failures ? `История этого типа и формата: завершено ${successes}, пропущено/отклонено/прекращено ${failures}.` : 'Личной истории этого типа и формата нет; использована сглаженная оценка по набору.' };
}
module.exports = { train, predict };
