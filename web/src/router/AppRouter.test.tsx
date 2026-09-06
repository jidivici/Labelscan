import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { AuthProvider } from '../auth/AuthContext';
import { adminFixtureSession, managerFixtureSession, superAdminFixtureSession } from '../fixtures/portalFixtures';
import type { Session } from '../types';
import { ApplicationRoutes } from './AppRouter';

function renderAt(path: string, session: Session | null = managerFixtureSession) {
  const { hook } = memoryLocation({ path });
  return render(<Router hook={hook}><AuthProvider initialSession={session}><ApplicationRoutes /></AuthProvider></Router>);
}

describe('capability based routing', () => {
  it('keeps a manager out of the super-admin workspace', async () => {
    renderAt('/o/labelscan/super-administration');
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retour à mon espace' })).toHaveAttribute('href', '/o/labelscan');
  });

  it('does not expose the retired operator workspace', async () => {
    renderAt('/o/labelscan/portails/boucherie/operateurs');
    expect(await screen.findByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
  });

  it('opens the super-admin workspace for an authorized principal', async () => {
    renderAt('/o/labelscan/super-administration', superAdminFixtureSession);
    expect(await screen.findByRole('heading', { name: 'Administrateurs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Métier Tous les métiers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nouvel administrateur' })).toBeInTheDocument();
    const navigationElement = screen.getByRole('navigation', { name: 'Navigation principale' });
    const navigation = within(navigationElement);
    expect(navigation.getByRole('link', { name: 'Arrivages' })).toHaveAttribute('href', '/o/labelscan/portails/tous/arrivages');
    expect(navigation.queryByText('Portail', { exact: true })).not.toBeInTheDocument();
    expect(navigation.queryByText('Administration', { exact: true })).not.toBeInTheDocument();
    expect(navigationElement.querySelector('.nav-divider')).toBeNull();
  });

  it('keeps the all-professions arrivals view limited to administrators', async () => {
    renderAt('/o/labelscan/portails/tous/arrivages');
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });

  it('uses arrivals as the super-admin home', async () => {
    renderAt('/o/labelscan', superAdminFixtureSession);
    expect(await screen.findByRole('heading', { name: 'Tous les arrivages' })).toBeInTheDocument();
  });

  it('keeps all professions selected in the administration workspace', async () => {
    renderAt('/o/labelscan/administration', adminFixtureSession);

    expect(await screen.findByRole('button', { name: 'Métier Tous les métiers' })).toBeInTheDocument();
  });

  it('keeps Tous les métiers selected in the global arrivals view', async () => {
    renderAt('/o/labelscan/portails/tous/arrivages', adminFixtureSession);

    expect(await screen.findByRole('button', { name: 'Métier Tous les métiers' })).toBeInTheDocument();
  });

  it('keeps Tous les métiers selected on the super-admin account page', async () => {
    renderAt('/o/labelscan/compte', superAdminFixtureSession);

    expect(await screen.findByRole('heading', { name: 'Mon compte' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Métier Tous les métiers' })).toBeInTheDocument();
  });

  it.each([
    ['une lettre accentuée', 'Abcdefghij1é'],
    ['un chiffre Unicode', 'Abcdefghij1٢'],
  ])('explains that %s is not a special character on the account page', async (_case, password) => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/compte', superAdminFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });

    await user.type(screen.getByLabelText('Mot de passe actuel'), 'CurrentPassword1!');
    await user.type(screen.getByLabelText('Nouveau mot de passe'), password);
    await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), password);

    const submit = screen.getByRole('button', { name: 'Modifier le mot de passe' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(screen.getByLabelText('Nouveau mot de passe')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Respectez tous les critères de sécurité indiqués.')).toBeInTheDocument();
  });

  it('accepts punctuation as a special character on the account page', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/compte', superAdminFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });
    const password = 'Abcdefghi1é!';

    await user.type(screen.getByLabelText('Mot de passe actuel'), 'CurrentPassword1!');
    await user.type(screen.getByLabelText('Nouveau mot de passe'), password);
    await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), password);

    expect(screen.getByRole('button', { name: 'Modifier le mot de passe' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Modifier le mot de passe' })).toHaveClass('primary');
    expect(screen.getByText('Tous les critères sont respectés')).toBeInTheDocument();
  });

  it('shows each unmet password requirement before enabling the account action', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/compte', superAdminFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });

    await user.type(screen.getByLabelText('Nouveau mot de passe'), 'abcdefghijk');
    await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), 'autre-valeur');

    const requirements = screen.getByRole('region', { name: 'Critères du nouveau mot de passe' });
    expect(within(requirements).getByText('12 caractères minimum').closest('li')).toHaveClass('unmet');
    expect(within(requirements).getByText('Une lettre majuscule').closest('li')).toHaveClass('unmet');
    expect(within(requirements).getByText('Un chiffre').closest('li')).toHaveClass('unmet');
    expect(within(requirements).getByText('Les deux nouveaux mots de passe correspondent').closest('li')).toHaveClass('unmet');
    const submit = screen.getByRole('button', { name: 'Modifier le mot de passe' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(screen.getByText('Renseignez votre mot de passe actuel.')).toBeInTheDocument();
    expect(screen.getByText('Respectez tous les critères de sécurité indiqués.')).toBeInTheDocument();
    expect(screen.getByText('Les deux nouveaux mots de passe ne correspondent pas.')).toBeInTheDocument();
  });

  it('exposes password-change semantics to Safari AutoFill', async () => {
    renderAt('/o/labelscan/compte', superAdminFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });

    expect(screen.queryByText('Sécurité du compte')).not.toBeInTheDocument();
    expect(screen.queryByText('Choisissez un mot de passe unique que vous n’utilisez sur aucun autre service.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Identifiant')).not.toBeInTheDocument();
    expect(document.querySelector('input[name="username"]')).toHaveAttribute('autocomplete', 'username');
    expect(document.querySelector('input[name="username"]')).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('input[name="username"]')).toHaveAttribute('id', 'account-username-autofill');
    expect(screen.getByLabelText('Mot de passe actuel')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Mot de passe actuel')).toHaveAttribute('id', 'account-current-password');
    expect(screen.getByLabelText('Nouveau mot de passe')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Nouveau mot de passe')).toHaveAttribute('id', 'account-new-password');
    expect(screen.getByLabelText('Nouveau mot de passe')).toHaveAttribute(
      'passwordrules',
      'minlength: 12; maxlength: 128; required: upper; required: lower; required: digit; required: special;',
    );
    expect(screen.getByLabelText('Confirmer le nouveau mot de passe')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirmer le nouveau mot de passe')).toHaveAttribute('id', 'account-new-password-confirmation');
    expect(screen.getByLabelText('Confirmer le nouveau mot de passe')).not.toHaveAttribute('passwordrules');
  });

  it('treats login as an existing password and preserves it when revealed', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/connexion', null);

    const password = await screen.findByLabelText('Mot de passe');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(password).not.toHaveAttribute('passwordrules');

    await user.type(password, 'Existing-Password-42!');
    await user.click(screen.getByRole('button', { name: 'Afficher le mot de passe' }));

    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue('Existing-Password-42!');
    expect(screen.getByRole('button', { name: 'Masquer le mot de passe' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('replaces native login validation with accessible inline guidance', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderAt('/o/labelscan/connexion', null);

    const submit = await screen.findByRole('button', { name: 'Se connecter' });
    expect(submit.closest('form')).toHaveAttribute('novalidate');
    await user.click(submit);

    expect(screen.getByText('Renseignez votre identifiant.')).toBeInTheDocument();
    expect(screen.getByText('Renseignez votre mot de passe.')).toBeInTheDocument();
    expect(screen.getByLabelText('Identifiant')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Identifiant')).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('submits Safari-autofilled login values even without input events', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      detail: 'Identifiants invalides',
      error_code: 'INVALID_CREDENTIALS',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    renderAt('/o/labelscan/connexion', null);
    const username = await screen.findByLabelText('Identifiant') as HTMLInputElement;
    const password = screen.getByLabelText('Mot de passe') as HTMLInputElement;

    username.value = 'safari.autofill';
    password.value = 'Safari-password-42!';
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      username: 'safari.autofill',
      password: 'Safari-password-42!',
    });
    fetchSpy.mockRestore();
  });

  it('places a login error between the password field and the submit button', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      detail: 'Identifiants invalides',
      error_code: 'INVALID_CREDENTIALS',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    renderAt('/o/labelscan/connexion', null);

    await user.type(screen.getByLabelText('Identifiant'), 'inconnu');
    await user.type(screen.getByLabelText('Mot de passe'), 'incorrect');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    const form = screen.getByRole('button', { name: 'Se connecter' }).closest('form')!;
    const children = Array.from(form.children);
    const passwordField = screen.getByLabelText('Mot de passe').closest('.field')!;
    const alert = await screen.findByRole('alert');
    const submit = screen.getByRole('button', { name: 'Se connecter' });
    expect(children.indexOf(alert)).toBeGreaterThan(children.indexOf(passwordField));
    expect(children.indexOf(alert)).toBeLessThan(children.indexOf(submit));
    fetchSpy.mockRestore();
  });

  it('does not expose Safari password rules for a manager password change', async () => {
    renderAt('/o/labelscan/compte', managerFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });

    expect(screen.getByLabelText('Nouveau mot de passe')).not.toHaveAttribute('passwordrules');
    expect(screen.getByLabelText('Nouveau mot de passe')).not.toHaveAttribute('minlength');
    expect(screen.getByLabelText('Confirmer le nouveau mot de passe')).not.toHaveAttribute('passwordrules');
    expect(screen.getByLabelText('Confirmer le nouveau mot de passe')).not.toHaveAttribute('minlength');
    expect(screen.queryByRole('region', { name: 'Critères du nouveau mot de passe' })).not.toBeInTheDocument();
  });

  it('accepts a one-character manager password when both entries match', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/compte', managerFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });

    await user.type(screen.getByLabelText('Mot de passe actuel'), 'a');
    await user.type(screen.getByLabelText('Nouveau mot de passe'), 'x');
    await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), 'x');

    expect(screen.getByRole('button', { name: 'Modifier le mot de passe' })).toBeEnabled();
  });

  it('keeps a Safari-generated password when revealing it and reacts to native input events', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/compte', superAdminFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });
    const current = screen.getByLabelText('Mot de passe actuel');
    const password = screen.getByLabelText('Nouveau mot de passe');
    const confirmation = screen.getByLabelText('Confirmer le nouveau mot de passe');
    const generatedPassword = 'Strong-Apple-Password-42';

    fireEvent.input(current, { target: { value: 'CurrentPassword1!' } });
    fireEvent.input(password, { target: { value: generatedPassword } });
    fireEvent.input(confirmation, { target: { value: generatedPassword } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Modifier le mot de passe' })).toBeEnabled());
    await user.click(screen.getAllByRole('button', { name: 'Afficher le mot de passe' })[1]);
    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue(generatedPassword);
    expect(screen.getByRole('button', { name: 'Masquer le mot de passe' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('submits Safari-autofilled account passwords even without input events', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    renderAt('/o/labelscan/compte', superAdminFixtureSession);
    await screen.findByRole('heading', { name: 'Mon compte' });
    const current = screen.getByLabelText('Mot de passe actuel') as HTMLInputElement;
    const password = screen.getByLabelText('Nouveau mot de passe') as HTMLInputElement;
    const confirmation = screen.getByLabelText('Confirmer le nouveau mot de passe') as HTMLInputElement;

    current.value = 'CurrentPassword1!';
    password.value = 'Strong-Safari-Password-42!';
    confirmation.value = 'Strong-Safari-Password-42!';
    await user.click(screen.getByRole('button', { name: 'Modifier le mot de passe' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/v1/me/password', expect.objectContaining({ method: 'POST' })));
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      current_password: 'CurrentPassword1!',
      new_password: 'Strong-Safari-Password-42!',
    });
    fetchSpy.mockRestore();
  });
});
