export const RHYTHM_MAX_DURATION_MS = 10 * 60 * 1000;
export const RHYTHM_DEFAULT_DURATION_MS = RHYTHM_MAX_DURATION_MS;
export const RHYTHM_DEFAULT_MAX_LEVEL = 12;

const PLAN = Object.freeze([
  { suction: 0.25, vibration: 0.15, holdMs: 5_000 },
  { suction: 0.40, vibration: 0.30, holdMs: 4_500 },
  { suction: 0.55, vibration: 0.45, holdMs: 4_000 },
  { suction: 0.35, vibration: 0.65, holdMs: 5_500 },
  { suction: 0.70, vibration: 0.50, holdMs: 3_500 },
  { suction: 0.45, vibration: 0.80, holdMs: 4_000 },
  { suction: 0.85, vibration: 0.65, holdMs: 3_000 },
  { suction: 0.30, vibration: 0.25, holdMs: 6_000 }
]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeRhythmRequest(input = {}) {
  const rawDuration = input.durationMs ?? (
    Number.isFinite(Number(input.durationMinutes))
      ? Number(input.durationMinutes) * 60_000
      : RHYTHM_DEFAULT_DURATION_MS
  );
  const durationMs = clamp(
    Math.round(Number.isFinite(Number(rawDuration)) ? Number(rawDuration) : RHYTHM_DEFAULT_DURATION_MS),
    10_000,
    RHYTHM_MAX_DURATION_MS
  );
  const rawLevel = Number(input.maxLevel);
  const maxLevel = clamp(
    Math.round(Number.isFinite(rawLevel) ? rawLevel : RHYTHM_DEFAULT_MAX_LEVEL),
    1,
    20
  );
  return { durationMs, maxLevel };
}

export function rhythmStepAt(index, maxLevel = RHYTHM_DEFAULT_MAX_LEVEL) {
  const safeMax = clamp(Math.round(Number(maxLevel) || RHYTHM_DEFAULT_MAX_LEVEL), 1, 20);
  const step = PLAN[Math.abs(Math.trunc(Number(index) || 0)) % PLAN.length];
  return {
    suction: clamp(Math.round(step.suction * safeMax), 0, safeMax),
    vibration: clamp(Math.round(step.vibration * safeMax), 0, safeMax),
    holdMs: step.holdMs
  };
}
