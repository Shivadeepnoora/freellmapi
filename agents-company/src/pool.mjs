// Run async tasks with a concurrency cap, keeping result order. A failed task
// yields {error} instead of rejecting the whole batch.
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { value: await worker(items[i], i) }; }
      catch (error) { results[i] = { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}
