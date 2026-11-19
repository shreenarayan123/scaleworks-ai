import { z } from "zod";

export const BehaviorSchema = z.enum([
  "Rude",
  "Hostile",
  "Dismissive",
  "Sarcastic",
  "Interrupting",
  "Condescending",
]);

export const AnalysisSettingsSchema = z.object({
  negativeBehaviors: z.array(BehaviorSchema).default([
    "Rude", "Hostile", "Dismissive", "Sarcastic", "Interrupting", "Condescending",
  ]),
  customRules: z.string().max(5_000).default(""),
  includeCustomerRequests: z.boolean().default(true),
  includeImpliedCommitments: z.boolean().default(false),
  minConfidence: z.number().min(0).max(100).default(70),
  actionItemRules: z.string().max(5_000).default(""),
});

export type AnalysisSettings = z.infer<typeof AnalysisSettingsSchema>;

export function parseAnalysisSettings(value: unknown): AnalysisSettings {
  return AnalysisSettingsSchema.parse(value ?? {});
}
