export const HERDR_EXECUTABLE = "herdr";

export interface HerdrInvocation {
  executable: string;
  args: string[];
}

export function createHerdrInvocation(
  args: readonly string[],
  executable = HERDR_EXECUTABLE,
): HerdrInvocation {
  return {
    executable,
    args: [...args],
  };
}
