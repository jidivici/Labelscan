export type FieldErrors = Record<string, string>;

export const PRIVILEGED_PASSWORD_RULES = 'minlength: 12; maxlength: 128; required: upper; required: lower; required: digit; required: special;';
export const PRIVILEGED_PASSWORD_HINT = '12 caractères minimum, avec majuscule, minuscule, chiffre et caractère spécial.';
export const PRIVILEGED_PASSWORD_ERROR = 'Utilisez 12 à 128 caractères avec une majuscule, une minuscule, un chiffre et un caractère spécial.';

export function hasPrivilegedPasswordPolicy(value: string): boolean {
  return value.length >= 12
    && value.length <= 128
    && /[A-Z]/.test(value)
    && /[a-z]/.test(value)
    && /\d/.test(value)
    && /[^\p{Alphabetic}\p{Number}]/u.test(value);
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <span id={id} className="field-error" aria-live="polite">{message}</span>;
}

export function clearFieldError(
  setErrors: (update: (current: FieldErrors) => FieldErrors) => void,
  name: string,
) {
  setErrors((current) => {
    if (!current[name]) return current;
    const next = { ...current };
    delete next[name];
    return next;
  });
}

export function focusFirstInvalidField(form: HTMLFormElement, fieldNames: string[]) {
  const validationTargets = Array.from(
    form.querySelectorAll<HTMLElement>('[data-validation-for]'),
  );
  for (const name of fieldNames) {
    const customTarget = validationTargets.find((target) => target.dataset.validationFor === name);
    const namedTarget = form.elements.namedItem(name);
    const target = customTarget
      ?? (namedTarget instanceof HTMLElement ? namedTarget : null);
    if (!target) continue;
    target.focus();
    return;
  }
}
