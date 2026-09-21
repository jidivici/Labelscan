import { scanStepFromStatus } from '../services/scanSteps';

describe('scanStepFromStatus', () => {
  it('submitting: step 1 active and detail remains accessible', () => {
    const view = scanStepFromStatus('submitting', false);
    expect(view.steps).toEqual(['active', 'pending', 'pending']);
    expect(view.openable).toBe(true);
  });

  it('extracting (ocrDone=false): step 1 done, step 2 active as "Lecture du texte", openable', () => {
    const view = scanStepFromStatus('extracting', false);
    expect(view.steps).toEqual(['done', 'active', 'pending']);
    expect(view.activeLabel).toBe('Lecture du texte');
    expect(view.openable).toBe(true);
  });

  it('extracting (ocrDone=true): same steps, label switches to "Analyse en cours", openable', () => {
    const view = scanStepFromStatus('extracting', true);
    expect(view.steps).toEqual(['done', 'active', 'pending']);
    expect(view.activeLabel).toBe('Analyse en cours');
    expect(view.openable).toBe(true);
  });

  it('ready: all done up to step 3 active, tappable', () => {
    const view = scanStepFromStatus('ready', true);
    expect(view.steps).toEqual(['done', 'done', 'active']);
    expect(view.activeLabel).toBe('À valider');
    expect(view.openable).toBe(true);
  });

  it('recapture_required: clearly terminal for analysis but opens the recapture guidance', () => {
    const view = scanStepFromStatus('recapture_required', true);
    expect(view.steps).toEqual(['done', 'error', 'pending']);
    expect(view.activeLabel).toBe('Photo à reprendre');
    expect(view.openable).toBe(true);
  });

  it('submit_error: step 1 errored and detail remains accessible', () => {
    const view = scanStepFromStatus('submit_error', false);
    expect(view.steps).toEqual(['error', 'pending', 'pending']);
    expect(view.activeLabel).toBe('Envoi impossible');
    expect(view.openable).toBe(true);
  });

  it('extract_error: step 1 done, step 2 errored and detail remains accessible', () => {
    const view = scanStepFromStatus('extract_error', true);
    expect(view.steps).toEqual(['done', 'error', 'pending']);
    expect(view.activeLabel).toBe('Analyse impossible');
    expect(view.openable).toBe(true);
  });

  it('ocrDone has no effect outside the extracting status', () => {
    expect(scanStepFromStatus('submitting', true)).toEqual(scanStepFromStatus('submitting', false));
    expect(scanStepFromStatus('ready', false)).toEqual(scanStepFromStatus('ready', true));
    expect(scanStepFromStatus('submit_error', true)).toEqual(scanStepFromStatus('submit_error', false));
    expect(scanStepFromStatus('extract_error', false)).toEqual(scanStepFromStatus('extract_error', true));
    expect(scanStepFromStatus('recapture_required', false)).toEqual(
      scanStepFromStatus('recapture_required', true),
    );
  });
});
