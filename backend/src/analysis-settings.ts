import { z } from "zod";

export const BehaviorSchema = z.enum([
  "Rude",
  "Hostile",
  "Dismissive",
  "Sarcastic",
  "Interrupting",
  "Condescending",
]);
export const AlwaysEnabledBehaviors: AnalysisSettings["negativeBehaviors"] = ["Dismissive", "Interrupting"];

export const ToneRulesSchema = z.array(z.string().trim().min(1).max(300)).max(10);

export const AnalysisSettingsSchema = z.object({
  negativeBehaviors: z.array(BehaviorSchema).default([
    "Rude", "Hostile", "Dismissive", "Sarcastic", "Interrupting", "Condescending",
  ]),
  toneRules: ToneRulesSchema.default([]),
  includeCustomerRequests: z.boolean().default(true),
  includeImpliedCommitments: z.boolean().default(false),
  minConfidence: z.number().min(0).max(100).default(70),
  actionItemRules: z.string().max(5_000).default(""),
});

export type AnalysisSettings = z.infer<typeof AnalysisSettingsSchema>;

export function parseAnalysisSettings(value: unknown): AnalysisSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyRules = Array.isArray(source.toneRules)
    ? source.toneRules.map((rule) => typeof rule === "string" ? rule : rule && typeof rule === "object" && "text" in rule ? String((rule as { text: unknown }).text) : "")
    : typeof source.customRules === "string" && source.customRules.trim() ? [source.customRules.trim()] : [];
  const toneRules = legacyRules.map((rule) => rule.trim().slice(0, 300)).filter(Boolean).slice(0, 10);
  const parsed = AnalysisSettingsSchema.parse({ ...source, toneRules });
  const normalized = { ...parsed, negativeBehaviors: [...new Set([...parsed.negativeBehaviors, ...AlwaysEnabledBehaviors])] };
  return normalized;
}
