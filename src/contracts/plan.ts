import { z } from "zod";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."),
    "must be a workspace-relative path",
  );
export const AssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file_exists"), path: relativePath }).strict(),
  z
    .object({
      kind: z.literal("file_matches"),
      path: relativePath,
      pattern: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file_not_matches"),
      path: relativePath,
      pattern: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      argv: z.array(z.string()).min(1),
      exitCode: z.number().int().default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stdout"),
      from: z.string().min(1),
      contains: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal("git_diff"), path: relativePath.optional() })
    .strict(),
  z
    .object({
      kind: z.literal("human_review"),
      instructions: z.string().min(1),
    })
    .strict(),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

export const PlanStepSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    dependsOn: z.array(z.string()).default([]),
    verify: z.array(AssertionSchema).min(1),
  })
  .strict();
export const PlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: z.string().min(1),
    steps: z.array(PlanStepSchema).min(1),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

export function validatePlan(plan: Plan): Plan {
  const parsed = PlanSchema.parse(plan);
  const ids = new Set<string>();
  for (const step of parsed.steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate plan step id: ${step.id}`);
    ids.add(step.id);
    for (let index = 0; index < step.verify.length; index++) {
      const assertion = step.verify[index];
      if (
        assertion.kind === "file_matches" ||
        assertion.kind === "file_not_matches"
      ) {
        try {
          new RegExp(assertion.pattern);
        } catch {
          throw new Error(
            `Invalid regular expression in step ${step.id}: ${assertion.pattern}`,
          );
        }
      } else if (assertion.kind === "stdout") {
        const match = /^assertion:(\d+)$/.exec(assertion.from);
        const source = match ? Number(match[1]) : -1;
        if (
          source < 0 ||
          source >= index ||
          step.verify[source]?.kind !== "command"
        )
          throw new Error(
            `Invalid stdout source in step ${step.id}: ${assertion.from} must reference an earlier command assertion`,
          );
      }
    }
  }
  for (const step of parsed.steps)
    for (const dependency of step.dependsOn)
      if (!ids.has(dependency))
        throw new Error(`Unknown dependency ${dependency} in step ${step.id}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(parsed.steps.map((s) => [s.id, s]));
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new Error(`Cyclic plan dependency involving ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return parsed;
}
