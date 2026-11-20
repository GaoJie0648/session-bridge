import { orElse } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const emptyTotals = () => ({
  sessions: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  latestModel: null,
  latestRateLimits: null,
});

/**
 * 輕量用量查詢：支援查單一 task、單一 session，或近期各 provider 彙總
 */
export const createUsageTools = ({ registry, taskStore }) => {
  const getUsage = async ({ task_id, source, id, days = 7 } = {}) => {
    if (task_id) {
      const task = await taskStore.read(task_id);
      let liveUsage = task.usage;
      const sessionId = task.sessions?.[task.provider];
      if (sessionId && registry.has(task.provider)) {
        const provider = registry.get(task.provider);
        const sessions = await provider.listSessions();
        const found = sessions.find((item) => item.id.toLowerCase() === sessionId.toLowerCase());
        if (found && provider.readUsage) {
          liveUsage = await orElse(provider.readUsage, task.usage)(found.file);
        }
      }
      return {
        scope: 'task',
        taskId: task.id,
        provider: task.provider,
        status: task.status,
        model: liveUsage?.model ?? task.model,
        effort: task.effort,
        usage: liveUsage ?? null,
      };
    }

    if (source && id) {
      const provider = registry.get(source);
      const sessions = await provider.listSessions();
      const found = sessions.find((item) => item.id.toLowerCase() === id.toLowerCase());
      if (!found) throw new Error(`找不到 ${source} session：${id}`);
      const usage = provider.readUsage ? await provider.readUsage(found.file) : null;
      return {
        scope: 'session',
        source,
        id: found.id,
        title: found.title,
        updatedAt: found.updatedAt,
        usage,
      };
    }

    const cutoff = Date.now() - Math.max(1, Math.min(90, days)) * DAY_MS;
    const providers = source && source !== 'all' ? [registry.get(source)] : registry.all();
    const summary = {};
    for (const provider of providers) {
      const totals = emptyTotals();
      const sessions = (await orElse(provider.listSessions, [])())
        .filter((item) => Date.parse(item.updatedAt) >= cutoff)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const session of sessions) {
        const usage = provider.readUsage ? await orElse(provider.readUsage, null)(session.file) : null;
        if (!usage) continue;
        totals.sessions += 1;
        totals.turns += Number(usage.turns ?? 0);
        totals.inputTokens += Number(usage.inputTokens ?? 0);
        totals.outputTokens += Number(usage.outputTokens ?? 0);
        totals.cacheReadTokens += Number(usage.cacheReadTokens ?? 0);
        if (!totals.latestModel && usage.model) totals.latestModel = usage.model;
        if (!totals.latestRateLimits && usage.rateLimits) totals.latestRateLimits = usage.rateLimits;
      }
      summary[provider.name] = totals;
    }

    return {
      scope: 'summary',
      days,
      providers: summary,
    };
  };

  return { getUsage };
};
