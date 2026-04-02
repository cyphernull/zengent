export async function parallel<
  TTasks extends Record<string, () => unknown | Promise<unknown>>,
>(tasks: TTasks): Promise<{
  [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>>;
}> {
  const entries = Object.entries(tasks);
  const values = await Promise.all(entries.map(([, task]) => task()));
  const output: Record<string, unknown> = {};

  for (const [index, [name]] of entries.entries()) {
    output[name] = values[index];
  }

  return output as {
    [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>>;
  };
}

export async function branch<
  TKey extends string,
  TBranches extends Record<TKey, () => unknown | Promise<unknown>>,
>(
  select: TKey | Promise<TKey>,
  branches: TBranches
): Promise<Awaited<ReturnType<TBranches[TKey]>>> {
  const key = await select;
  const target = branches[key];

  if (!target) {
    throw new Error(`Unknown branch "${key}"`);
  }

  return target() as Promise<Awaited<ReturnType<TBranches[TKey]>>>;
}
