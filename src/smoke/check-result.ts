export type CheckResult = { name: string; ok: boolean; detail: string };

export function printResults(results: CheckResult[]): boolean {
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  ${result.detail}` : ""}`);
  }
  return results.every((result) => result.ok);
}
