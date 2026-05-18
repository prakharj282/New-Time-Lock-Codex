import { expect, test, type Page } from '@playwright/test';
import { cleanupE2eNotes, closeE2eDb, E2E_TITLE_PREFIX } from './db';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

function noteCard(page: Page, title: string) {
  const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return page.locator(`[data-testid="note-card"][data-note-title="${escapedTitle}"]`);
}

async function openNote(page: Page, title: string) {
  await noteCard(page, title).click();
}

async function createTextNote(page: Page, title: string, body: string) {
  await page.getByTestId('create-note').click();
  await expect(page.getByTestId('note-content-input')).toBeVisible();
  await page.getByTestId('note-title-input').fill(title);
  await page.getByTestId('note-content-input').fill(body);
  await page.getByTestId('save-note').click();
  await expect(noteCard(page, title)).toBeVisible();
}

async function emergencyUnlockCurrentNote(page: Page, minLength: number) {
  await page.getByTestId('emergency-unlock-open').click();
  const emergencyTarget = page.getByTestId('emergency-target');
  await expect.poll(async () => ((await emergencyTarget.textContent()) || '').length).toBeGreaterThanOrEqual(minLength);
  const targetText = (await emergencyTarget.textContent()) || '';

  const emergencyInput = page.getByTestId('emergency-input');
  for (const char of targetText) {
    await emergencyInput.type(char);
  }
  await page.getByTestId('emergency-unlock-submit').click();
}

function futureDateTimeLocal(minutesFromNow: number) {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-') + `T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function currentScheduleWindow() {
  const now = new Date();
  const start = new Date(now.getTime() - 60_000);
  const end = new Date(now.getTime() + 5 * 60_000);
  const fmt = (date: Date) =>
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  return {
    day: now.getDay(),
    start: fmt(start),
    end: fmt(end),
  };
}

test.describe.serial('TimeLock Notes core flows', () => {
  const runId = `e2e-${Date.now()}`;
  const title = `${E2E_TITLE_PREFIX} ${runId} saved`;
  const body = `Body created by ${runId}`;
  const editedTitle = `${E2E_TITLE_PREFIX} ${runId} edited`;
  const editedBody = `Edited body for ${runId}`;
  const lockedTitle = `${E2E_TITLE_PREFIX} ${runId} locked title`;
  const emergencyOpenTitle = `${E2E_TITLE_PREFIX} ${runId} emergency open`;
  const scheduleTitle = `${E2E_TITLE_PREFIX} ${runId} schedule`;
  const photoTitle = `${E2E_TITLE_PREFIX} ${runId} photo`;
  const dateLockTitle = `${E2E_TITLE_PREFIX} ${runId} date lock`;
  const extendLockTitle = `${E2E_TITLE_PREFIX} ${runId} extend lock`;
  const alwaysLockTitle = `${E2E_TITLE_PREFIX} ${runId} always lock`;
  const unsavedRefreshTitle = `${E2E_TITLE_PREFIX} ${runId} unsaved refresh`;
  const invalidLockTitle = `${E2E_TITLE_PREFIX} ${runId} invalid lock`;
  const failedDeleteTitle = `${E2E_TITLE_PREFIX} ${runId} failed delete`;
  const exhaustedEmergencyTitle = `${E2E_TITLE_PREFIX} ${runId} emergency exhausted`;
  const offWindowScheduleTitle = `${E2E_TITLE_PREFIX} ${runId} schedule off window`;

  test.beforeAll(async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.status()).not.toBe(404);
    expect(health.ok()).toBeTruthy();
    expect(await health.json()).toMatchObject({ ok: true, database: 'connected' });
    const notes = await request.get('/api/notes');
    expect(notes.status()).not.toBe(404);
    expect(notes.ok()).toBeTruthy();
    await cleanupE2eNotes();
  });

  test.afterAll(async () => {
    await cleanupE2eNotes();
    await closeE2eDb();
  });

  test('API readiness is healthy', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    expect(await health.json()).toMatchObject({ ok: true, database: 'connected' });
  });

  test('shows inline save errors without leaving the editor', async ({ page }) => {
    await page.route('**/api/notes/*', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Simulated save failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.getByTestId('create-note').click();
    await page.getByTestId('note-title-input').fill(`${E2E_TITLE_PREFIX} ${runId} failed save`);
    await page.getByTestId('note-content-input').fill('This should not be saved.');
    await page.getByTestId('save-note').click();

    await expect(page.getByTestId('note-error')).toContainText('Simulated save failure');
    await expect(page.getByTestId('note-content-input')).toBeVisible();
  });

  test('shows visible load errors instead of a blank list', async ({ page }) => {
    await page.route('**/api/notes', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Simulated load failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await expect(page.getByTestId('app-error')).toContainText('Simulated load failure');
    await expect(page.getByTestId('create-note')).toBeVisible();
  });

  test('keeps unsaved note editor stable while background refresh runs', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('create-note').click();
    await page.getByTestId('note-title-input').fill(unsavedRefreshTitle);
    await page.getByTestId('note-content-input').fill('Unsaved text should stay in the editor.');

    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('note-title-input')).toHaveValue(unsavedRefreshTitle);
    await expect(page.getByTestId('note-content-input')).toHaveValue('Unsaved text should stay in the editor.');

    await page.getByTestId('save-note').click();
    await expect(noteCard(page, unsavedRefreshTitle)).toBeVisible();
  });

  test('invalid duration lock remains in lock flow without saving', async ({ page }) => {
    await page.goto('/');
    await createTextNote(page, invalidLockTitle, 'Invalid lock body');
    await openNote(page, invalidLockTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('lock-hours').fill('0');
    await page.getByTestId('lock-minutes').fill('0');

    page.once('dialog', dialog => {
      expect(dialog.message()).toContain('valid duration');
      return dialog.accept();
    });
    await page.getByTestId('apply-lock').click();

    await expect(page.getByTestId('apply-lock')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('note-content-input')).toHaveValue('Invalid lock body');
  });

  test('delete failures show inline errors and keep the note open', async ({ page }) => {
    await page.goto('/');
    await createTextNote(page, failedDeleteTitle, 'Failed delete body');
    await page.route('**/api/notes/*', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Simulated delete failure' }),
        });
        return;
      }
      await route.continue();
    });

    await openNote(page, failedDeleteTitle);
    await page.getByTestId('delete-note').click();
    await page.getByTestId('delete-confirm-input').fill('delete');
    await page.getByTestId('delete-confirm').click();

    await expect(page.getByTestId('note-error')).toContainText('Simulated delete failure');
    await expect(page.getByTestId('note-content-input')).toHaveValue('Failed delete body');
  });

  test('create, save, reload, edit, lock, emergency unlock, and delete', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-error')).toHaveCount(0);

    await createTextNote(page, title, body);
    await page.reload();
    await expect(noteCard(page, title)).toBeVisible();

    await openNote(page, title);
    await expect(page.getByTestId('note-content-input')).toHaveValue(body);
    await page.getByTestId('note-title-input').fill(editedTitle);
    await page.getByTestId('note-content-input').fill(editedBody);
    await page.getByTestId('save-note').click();

    await expect(noteCard(page, editedTitle)).toBeVisible();
    await page.reload();
    await openNote(page, editedTitle);
    await expect(page.getByTestId('note-content-input')).toHaveValue(editedBody);

    await page.getByTestId('lock-note').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('lock-hours').fill('2');
    await page.getByTestId('lock-minutes').fill('0');
    await page.getByTestId('apply-lock').click();

    await expect(noteCard(page, editedTitle)).toBeVisible();
    await openNote(page, editedTitle);
    await expect(page.getByText('Note is Locked')).toBeVisible();
    await expect(page.getByTestId('note-content-input')).toHaveCount(0);

    await page.getByTestId('note-title-input').fill(lockedTitle);
    await page.getByTestId('save-title').click();
    await expect(page.getByTestId('save-title')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(noteCard(page, lockedTitle)).toBeVisible();

    await openNote(page, lockedTitle);
    await emergencyUnlockCurrentNote(page, 20);

    await expect(noteCard(page, lockedTitle)).toBeVisible();
    await openNote(page, lockedTitle);
    await expect(page.getByTestId('note-content-input')).toHaveValue(editedBody);

    await page.getByTestId('delete-note').click();
    await page.getByTestId('delete-confirm-input').fill('delete');
    await page.getByTestId('delete-confirm').click();
    await expect(noteCard(page, lockedTitle)).toHaveCount(0);

    await page.reload();
    await expect(noteCard(page, lockedTitle)).toHaveCount(0);
  });

  test('date/time lock, extend lock, always lock, and extend emergency length', async ({ page }) => {
    await page.goto('/');

    await createTextNote(page, dateLockTitle, 'Date lock body');
    await openNote(page, dateLockTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('lock-mode-datetime').click();
    await page.getByTestId('lock-datetime').fill(futureDateTimeLocal(90));
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('apply-lock').click();
    await expect(noteCard(page, dateLockTitle)).toBeVisible();
    await openNote(page, dateLockTitle);
    await expect(page.getByText('Note is Locked')).toBeVisible();
    await emergencyUnlockCurrentNote(page, 20);
    await expect(noteCard(page, dateLockTitle)).toBeVisible();

    await createTextNote(page, extendLockTitle, 'Extend lock body');
    await openNote(page, extendLockTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('lock-hours').fill('1');
    await page.getByTestId('lock-minutes').fill('0');
    await page.getByTestId('apply-lock').click();
    await openNote(page, extendLockTitle);
    await expect(page.getByText('Note is Locked')).toBeVisible();
    await page.getByTestId('extend-lock-open').click();
    await page.getByTestId('extend-hours').fill('0');
    await page.getByTestId('extend-minutes').fill('30');
    await page.getByTestId('extend-lock-submit').click();
    await expect(page.getByText('Note is Locked')).toBeVisible();
    await emergencyUnlockCurrentNote(page, 20);
    await expect(noteCard(page, extendLockTitle)).toBeVisible();

    await createTextNote(page, alwaysLockTitle, 'Always lock body');
    await openNote(page, alwaysLockTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('lock-mode-always').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('hide-typos-toggle').click();
    await page.getByTestId('apply-lock').click();
    await openNote(page, alwaysLockTitle);
    await expect(page.getByText('Always Locked')).toBeVisible();
    await page.getByTestId('extend-gibberish-open').click();
    await page.getByTestId('extend-gibberish-length').fill('25');
    await page.getByTestId('extend-gibberish-submit').click();
    await expect(page.getByText('Always Locked')).toBeVisible();
    await emergencyUnlockCurrentNote(page, 25);
    await expect(noteCard(page, alwaysLockTitle)).toBeVisible();
    await openNote(page, alwaysLockTitle);
    await expect(page.getByTestId('note-content-input')).toHaveValue('Always lock body');
  });

  test('emergency open unlocks a locked note when quota is available', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('create-note').click();
    await page.getByTestId('note-title-input').fill(emergencyOpenTitle);
    await page.getByTestId('note-content-input').fill('Emergency open body');
    await page.getByTestId('emergency-open-toggle').click();
    await page.getByTestId('emergency-open-per-week').selectOption('1');
    await page.getByTestId('save-note').click();
    await expect(noteCard(page, emergencyOpenTitle)).toBeVisible();

    await openNote(page, emergencyOpenTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('lock-hours').fill('2');
    await page.getByTestId('lock-minutes').fill('0');
    await page.getByTestId('apply-lock').click();

    await openNote(page, emergencyOpenTitle);
    await expect(page.getByText('Note is Locked')).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await page.getByTestId('emergency-open').click();
    await expect(noteCard(page, emergencyOpenTitle)).toBeVisible();

    await openNote(page, emergencyOpenTitle);
    await expect(page.getByTestId('note-content-input')).toHaveValue('Emergency open body');
  });

  test('emergency open quota exhaustion hides the emergency button after relock', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('create-note').click();
    await page.getByTestId('note-title-input').fill(exhaustedEmergencyTitle);
    await page.getByTestId('note-content-input').fill('Emergency exhausted body');
    await page.getByTestId('emergency-open-toggle').click();
    await page.getByTestId('emergency-open-per-week').selectOption('1');
    await page.getByTestId('save-note').click();
    await expect(noteCard(page, exhaustedEmergencyTitle)).toBeVisible();

    await openNote(page, exhaustedEmergencyTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('lock-hours').fill('2');
    await page.getByTestId('lock-minutes').fill('0');
    await page.getByTestId('apply-lock').click();

    await openNote(page, exhaustedEmergencyTitle);
    page.once('dialog', dialog => dialog.accept());
    await page.getByTestId('emergency-open').click();
    await expect(noteCard(page, exhaustedEmergencyTitle)).toBeVisible();

    await openNote(page, exhaustedEmergencyTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('lock-hours').fill('2');
    await page.getByTestId('lock-minutes').fill('0');
    await page.getByTestId('apply-lock').click();

    await openNote(page, exhaustedEmergencyTitle);
    await expect(page.getByText('Note is Locked')).toBeVisible();
    await expect(page.getByTestId('emergency-open')).toHaveCount(0);
  });

  test('off-window schedule with multiple slots saves without locking content', async ({ page }) => {
    const tomorrow = (new Date().getDay() + 1) % 7;

    await page.goto('/');
    await createTextNote(page, offWindowScheduleTitle, 'Off-window schedule body');
    await openNote(page, offWindowScheduleTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('lock-mode-schedule').click();
    await page.getByTestId(`schedule-day-${tomorrow}`).click();
    await page.getByTestId(`schedule-slot-start-${tomorrow}-0`).fill('09:00');
    await page.getByTestId(`schedule-slot-end-${tomorrow}-0`).fill('10:00');
    await page.getByTestId('schedule-add-slot').click();
    await page.getByTestId(`schedule-slot-start-${tomorrow}-1`).fill('15:00');
    await page.getByTestId(`schedule-slot-end-${tomorrow}-1`).fill('16:00');
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('apply-lock').click();

    await expect(noteCard(page, offWindowScheduleTitle)).toBeVisible();
    await openNote(page, offWindowScheduleTitle);
    await expect(page.getByTestId('note-content-input')).toHaveValue('Off-window schedule body');
    await expect(page.getByText('Schedule Locked')).toHaveCount(0);
  });

  test('schedule lock saves and applies the current lock window', async ({ page }) => {
    const window = currentScheduleWindow();

    await page.goto('/');
    await createTextNote(page, scheduleTitle, 'Scheduled body');
    await openNote(page, scheduleTitle);
    await page.getByTestId('lock-note').click();
    await page.getByTestId('lock-mode-schedule').click();
    await page.getByTestId(`schedule-day-${window.day}`).click();
    await page.getByTestId(`schedule-slot-start-${window.day}-0`).fill(window.start);
    await page.getByTestId(`schedule-slot-end-${window.day}-0`).fill(window.end);
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('apply-lock').click();

    await expect(noteCard(page, scheduleTitle)).toBeVisible();
    await openNote(page, scheduleTitle);
    await expect(page.getByText('Schedule Locked')).toBeVisible();
    await expect(page.getByTestId('note-content-input')).toHaveCount(0);
  });

  test('photo note saves, reloads, thumbnails unlocked, and hides when locked', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('create-note').click();
    await page.getByTestId('note-title-input').fill(photoTitle);
    await page.getByTestId('photo-input').setInputFiles({
      name: 'tiny.png',
      mimeType: 'image/png',
      buffer: tinyPng,
    });
    await expect(page.getByTestId('photo-note-image')).toBeVisible();
    await page.getByTestId('save-note').click();

    await expect(noteCard(page, photoTitle)).toBeVisible();
    await page.reload();
    await expect(noteCard(page, photoTitle).locator('img')).toBeVisible();

    await openNote(page, photoTitle);
    await expect(page.getByTestId('photo-note-image')).toBeVisible();
    await page.getByTestId('lock-note').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('lock-hours').fill('2');
    await page.getByTestId('lock-minutes').fill('0');
    await page.getByTestId('apply-lock').click();

    await openNote(page, photoTitle);
    await expect(page.getByText('Note is Locked')).toBeVisible();
    await expect(page.getByTestId('photo-note-image')).toHaveCount(0);
  });
});
