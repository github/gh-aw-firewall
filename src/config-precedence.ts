export function applyConfigOptionsInPlaceWithCliPrecedence(
  options: Record<string, unknown>,
  configOptions: Record<string, unknown>,
  isCliProvided: (optionName: string) => boolean
): void {
  for (const [key, value] of Object.entries(configOptions)) {
    if (value === undefined) continue;
    if (isCliProvided(key)) continue;
    options[key] = value;
  }
}
