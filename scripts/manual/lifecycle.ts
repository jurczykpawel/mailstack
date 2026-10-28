export async function withBackgroundTasks<T>(
  operation: (waitUntil: (task: Promise<unknown>) => void) => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  const pending: Promise<void>[] = [], errors: unknown[] = [];
  const waitUntil = (task: Promise<unknown>) => {
    // Observe rejections immediately, including tasks registered by another task.
    pending.push(task.then(() => {}, error => { errors.push(error); }));
  };
  let result: T | undefined;
  try {
    try { result = await operation(waitUntil); }
    catch (error) { errors.push(error); }
    let cursor = 0;
    while (cursor < pending.length) {
      const batch = pending.slice(cursor);
      cursor = pending.length;
      await Promise.all(batch);
    }
  } finally { await cleanup(); }
  if (errors.length) throw new AggregateError(errors, 'Manual operation or background task failed');
  return result!;
}
