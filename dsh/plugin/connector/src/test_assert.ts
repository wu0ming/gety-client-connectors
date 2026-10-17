/** Minimal assertions so the connector tests have no remote dependencies. */

export function assertEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(message ?? `expected ${right}, got ${left}`);
  }
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  message?: string,
): void {
  if (!actual.includes(expected)) {
    throw new Error(
      message ?? `expected to include ${JSON.stringify(expected)}`,
    );
  }
}
