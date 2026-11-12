export interface SupervisorLimits {
  timeoutMs: number;
  heapMb: number;
  jobMemoryMb: number;
  stdoutMaxBytes: number;
  concurrency: number;
  queueLimit: number;
}
export const DEFAULT_SUPERVISOR_LIMITS: Readonly<SupervisorLimits> = Object.freeze({
  timeoutMs: 30_000, heapMb: 256, jobMemoryMb: 512,
  stdoutMaxBytes: 4 * 1024 * 1024, concurrency: 2, queueLimit: 32,
});
const bounds: Record<keyof SupervisorLimits, readonly [number, number]> = {
  timeoutMs: [50, 120_000], heapMb: [16, 512], jobMemoryMb: [64, 1024],
  stdoutMaxBytes: [1024, 8 * 1024 * 1024], concurrency: [1, 4], queueLimit: [0, 32],
};
export function resolveSupervisorLimits(input: Partial<SupervisorLimits> = {}): Readonly<SupervisorLimits> {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !(key in bounds))) throw new Error('PARSER_INVALID_CONFIG');
  const result = { ...DEFAULT_SUPERVISOR_LIMITS, ...input };
  for (const key of Object.keys(bounds) as Array<keyof SupervisorLimits>) {
    const value = result[key], [min, max] = bounds[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('PARSER_INVALID_CONFIG');
  }
  if (result.jobMemoryMb < result.heapMb) throw new Error('PARSER_INVALID_CONFIG');
  return Object.freeze(result);
}
