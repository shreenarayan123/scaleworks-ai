-- Convert nested settings from legacy {id,text,kind,severity} objects to condition strings.
UPDATE "Job" AS job
SET "analysisSettings" =
  (job."analysisSettings" - 'customRules') || jsonb_build_object(
    'toneRules', COALESCE((
      SELECT jsonb_agg(to_jsonb(left(CASE
        WHEN jsonb_typeof(rule.value) = 'object' THEN COALESCE(rule.value->>'text', '')
        WHEN jsonb_typeof(rule.value) = 'string' THEN rule.value #>> '{}'
        ELSE ''
      END, 300)) ORDER BY rule.ordinality)
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(job."analysisSettings"->'toneRules') = 'array' THEN job."analysisSettings"->'toneRules'
        WHEN jsonb_typeof(job."analysisSettings"->'customRules') = 'string' AND length(job."analysisSettings"->>'customRules') > 0 THEN jsonb_build_array(job."analysisSettings"->>'customRules')
        ELSE '[]'::jsonb
      END) WITH ORDINALITY AS rule(value, ordinality)
      WHERE rule.ordinality <= 10
    ), '[]'::jsonb)
  )
WHERE job."analysisSettings" IS NOT NULL
  AND (job."analysisSettings" ? 'toneRules' OR job."analysisSettings" ? 'customRules');
