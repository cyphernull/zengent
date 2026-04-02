export interface PauseSignal<TState = unknown> {
  __zengentPause: true;
  state: TState;
  reason?: string;
}

export function pause<TState = unknown>(
  state: TState,
  reason?: string
): PauseSignal<TState> {
  return {
    __zengentPause: true,
    state,
    reason,
  };
}

export function isPauseSignal(value: unknown): value is PauseSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "__zengentPause" in value &&
    value.__zengentPause === true
  );
}
