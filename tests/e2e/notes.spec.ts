import { expect, test, type Page } from '@playwright/test';
import { cleanupE2eNotes, closeE2eDb, E2E_TITLE_PREFIX } from './db';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

function noteCard(page: Page, title: string) {
  return page.getByTestId('note-card').filter({ hasText: title });
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

  test.beforeAll(async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    expect(await health.json()).toMatchObject({ ok: true, database: 'connected' });
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
    await page.getByTestId('emergency-unlock-open').click();
    const targetText = (await page.getByTestId('emergency-target').textContent()) || '';
    expect(targetText.length).toBeGreaterThanOrEqual(20);

    const emergencyInput = page.getByTestId('emergency-input');
    for (const char of targetText) {
      await emergencyInput.type(char);
    }
    await page.getByTestId('emergency-unlock-submit').click();

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
