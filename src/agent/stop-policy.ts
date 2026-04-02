export interface StopPolicy {
  maxSteps: number;
}

export function createStopPolicy(policy: Partial<StopPolicy> = {}): StopPolicy {
  return {
    maxSteps: policy.maxSteps ?? 8,
  };
}
