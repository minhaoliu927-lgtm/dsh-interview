/** Node filesystem errors carry errno-style codes and a syscall, unlike parser errors. */
export function isFileSystemError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as NodeJS.ErrnoException;
  return typeof details.code === 'string'
    && /^E[A-Z0-9]+$/u.test(details.code)
    && typeof details.syscall === 'string';
}
