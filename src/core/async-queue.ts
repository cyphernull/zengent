export function createAsyncQueue<TValue>() {
  const values: TValue[] = [];
  const resolvers: Array<
    (value: IteratorResult<TValue>) => void
  > = [];
  let finished = false;
  let failure: Error | undefined;

  return {
    push(value: TValue) {
      if (finished) {
        return;
      }

      const resolver = resolvers.shift();

      if (resolver) {
        resolver({ done: false, value });
        return;
      }

      values.push(value);
    },
    finish() {
      finished = true;

      while (resolvers.length > 0) {
        const resolver = resolvers.shift();
        resolver?.({ done: true, value: undefined });
      }
    },
    fail(error: Error) {
      failure = error;
      finished = true;

      while (resolvers.length > 0) {
        const resolver = resolvers.shift();
        resolver?.({ done: true, value: undefined });
      }
    },
    async *stream() {
      while (!finished || values.length > 0) {
        if (failure) {
          throw failure;
        }

        if (values.length > 0) {
          yield values.shift() as TValue;
          continue;
        }

        const result = await new Promise<IteratorResult<TValue>>((resolve) => {
          resolvers.push(resolve);
        });

        if (failure) {
          throw failure;
        }

        if (result.done) {
          return;
        }

        yield result.value;
      }
    },
  };
}
