/** Presentation only: retain the complete printed code and every qualifier. */
const AREA_NAMES: Record<number, string> = {
  21: 'Atlantique Nord-Ouest',
  27: 'Atlantique Nord-Est',
  31: 'Atlantique Centre-Ouest',
  34: 'Atlantique Centre-Est',
  37: 'Méditerranée et mer Noire',
  41: 'Atlantique Sud-Ouest',
  47: 'Atlantique Sud-Est',
  51: 'Océan Indien Ouest',
  57: 'Océan Indien Est',
  61: 'Pacifique Nord-Ouest',
  67: 'Pacifique Nord-Est',
  71: 'Pacifique Centre-Ouest',
  77: 'Pacifique Centre-Est',
  81: 'Pacifique Sud-Ouest',
  87: 'Pacifique Sud-Est',
};

export function formatFaoDisplay(value: string | null | undefined): string | null | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return value;
  const match = /^(?:FAO\s*:?\s*)?(\d{2}(?:\.[a-z0-9]+)*)$/i.exec(raw);
  if (!match) return raw;
  const code = match[1];
  const area = AREA_NAMES[Number(code.split('.')[0])];
  return area ? `${code} — ${area}` : raw;
}
