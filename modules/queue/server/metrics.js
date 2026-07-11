function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function durationStats(values) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) {
    return { count: 0, averageMs: null, p50Ms: null, p95Ms: null };
  }
  const total = clean.reduce((sum, value) => sum + value, 0);
  return {
    count: clean.length,
    averageMs: Math.round(total / clean.length),
    p50Ms: percentile(clean, 50),
    p95Ms: percentile(clean, 95),
  };
}

async function maybeGetWorkers(queue) {
  if (typeof queue.getWorkers !== 'function') return [];
  try {
    return await queue.getWorkers();
  } catch {
    return [];
  }
}

async function sampleJobs(queue, states, sampleSize) {
  if (typeof queue.getJobs !== 'function') return [];
  try {
    return await queue.getJobs(states, 0, sampleSize - 1, false);
  } catch {
    return [];
  }
}

export async function collectQueueMetrics({
  queue,
  name,
  configuredConcurrency = null,
  sampleSize = 100,
}) {
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'prioritized',
    'waiting-children',
    'paused',
    'completed',
    'failed'
  );
  const workers = await maybeGetWorkers(queue);
  const jobs = await sampleJobs(queue, ['completed', 'failed', 'active'], sampleSize);

  const waitTimes = [];
  const runTimes = [];
  for (const job of jobs) {
    if (Number.isFinite(job?.timestamp) && Number.isFinite(job?.processedOn)) {
      waitTimes.push(job.processedOn - job.timestamp);
    }
    if (Number.isFinite(job?.processedOn) && Number.isFinite(job?.finishedOn)) {
      runTimes.push(job.finishedOn - job.processedOn);
    }
  }

  return {
    name,
    counts,
    workers: workers.map((worker) => ({
      id: worker.id || worker.name || null,
      addr: worker.addr || null,
      name: worker.name || null,
      age: worker.age ?? null,
    })),
    configuredConcurrency,
    sampledJobs: jobs.length,
    waitTime: durationStats(waitTimes),
    runTime: durationStats(runTimes),
  };
}

export async function collectQueueMetricsSnapshot({ queues, generatedAt = new Date() }) {
  const results = await Promise.all(queues.map((queueConfig) => collectQueueMetrics(queueConfig)));
  return {
    generatedAt: generatedAt.toISOString(),
    queues: results,
  };
}
