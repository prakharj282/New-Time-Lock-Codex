import { expect, test, type Page } from '@playwright/test';
import type { Pool } from 'pg';
import { cleanupE2eNotes, closeE2eDb, E2E_TITLE_PREFIX } from './db';
import { createPgPool } from '../helpers/db';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for partner E2E tests.');
}

function noteCard(page: Page, title: string) {
  const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return page.locator(`[data-testid="note-card"][data-note-title="${escapedTitle}"]`);
}

async function readShareUrl(page: Page) {
  const shareUrl = page.getByTestId('partner-share-url');
  const value = await shareUrl.inputValue().catch(async () => (await shareUrl.textContent()) || '');
  expect(value).toMatch(/^https?:\/\/[^#]+\/partner#[A-Za-z0-9_-]{43,}$/);
  return value;
}

test.describe.serial('Accountability partner flow', () => {
  const runId = `e2e-partner-${Date.now()}`;
  const title = `${E2E_TITLE_PREFIX} ${runId} locked`;
  const body = `Partner-unlocked body created by ${runId}`;
  let pool: Pool;
  let canCleanUpPartner = false;

  test.beforeAll(async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    pool = createPgPool(testDatabaseUrl);
    await cleanupE2eNotes(pool);

    const existing = await pool.query('SELECT 1 FROM accountability_access LIMIT 1');
    expect(
      existing.rowCount,
      'The dedicated E2E database must start without partner access.'
    ).toBe(0);
    canCleanUpPartner = true;
  });

  test.afterAll(async () => {
    if (!pool) return;
    if (canCleanUpPartner) {
      await pool.query('DELETE FROM accountability_unlock_events WHERE access_id = 1');
      await pool.query('DELETE FROM accountability_sessions WHERE access_id = 1');
      await pool.query('DELETE FROM accountability_access WHERE id = 1');
    }
    await cleanupE2eNotes(pool);
    await pool.end();
    await closeE2eDb();
  });

  test('partner claims a fragment link and unlocks the note in the open owner UI', async ({ browser, page }) => {
    await page.goto('/');
    await page.getByTestId('partner-access-open').click();
    await expect(page.getByTestId('partner-access-panel')).toBeVisible();
    await expect(page.getByTestId('partner-access-status')).toContainText(
      /not set up|not configured|none|no partner/i
    );
    await page.getByTestId('partner-access-create').click();
    await expect(page.getByTestId('partner-access-status')).toContainText(/awaiting/i);
    const shareUrl = await readShareUrl(page);

    const invite = await pool.query('SELECT invite_token_hash FROM accountability_access WHERE id = 1');
    expect(invite.rowCount).toBe(1);
    expect(invite.rows[0].invite_token_hash).toBeInstanceOf(Buffer);
    await page.getByTestId('partner-access-close').click();

    await page.getByTestId('create-note').click();
    await page.getByTestId('note-title-input').fill(title);
    await page.getByTestId('note-content-input').fill(body);
    await page.getByTestId('save-note').click();
    const card = noteCard(page, title);
    await expect(card).toBeVisible();
    const noteId = await card.getAttribute('data-note-id');
    expect(noteId).toBeTruthy();

    await card.click();
    await page.getByTestId('lock-note').click();
    await page.getByTestId('emergency-length-input').fill('20');
    await page.getByTestId('lock-hours').fill('2');
    await page.getByTestId('lock-minutes').fill('0');
    await page.getByTestId('apply-lock').click();
    await noteCard(page, title).click();
    await expect(page.getByText('Note is Locked')).toBeVisible();
    await expect(page.getByTestId('note-content-input')).toHaveCount(0);

    const partnerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const partner = await partnerContext.newPage();
    try {
      await partner.goto(shareUrl);
      await expect(partner.getByTestId('partner-page')).toBeVisible();
      await expect(partner.getByTestId('partner-setup-form')).toBeVisible();
      await expect.poll(() => partner.url()).not.toContain('#');

      await partner.getByTestId('partner-setup-pin').fill('012345');
      await partner.getByTestId('partner-setup-confirm').fill('012345');
      await partner.getByTestId('partner-setup-submit').click();

      const noteList = partner.getByTestId('partner-note-list');
      await expect(noteList).toContainText(title);
      await expect(partner.getByTestId(`partner-unlock-${noteId}`)).toBeVisible();
      expect(await partner.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
        .toBe(true);

      const rateLimitContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const rateLimitedPartner = await rateLimitContext.newPage();
      try {
        await rateLimitedPartner.goto(shareUrl);
        await expect(rateLimitedPartner.getByTestId('partner-login-form')).toBeVisible();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await rateLimitedPartner.getByTestId('partner-login-pin').fill('999999');
          await rateLimitedPartner.getByTestId('partner-login-submit').click();
          await expect(rateLimitedPartner.getByTestId('partner-login-pin')).toHaveValue('');
        }
        await expect(rateLimitedPartner.getByRole('alert')).toContainText(/Too many unsuccessful attempts/i);
      } finally {
        await pool.query(
          'UPDATE accountability_access SET failed_attempts = 0, rate_limited_until = NULL WHERE id = 1',
        );
        await rateLimitContext.close();
      }

      await partner.getByTestId(`partner-unlock-${noteId}`).click();
      await expect(partner.getByTestId('partner-unlock-confirmation')).toBeVisible();
      await partner.getByTestId('partner-unlock-confirm').click();
      await expect(partner.getByTestId(`partner-unlock-${noteId}`)).toHaveCount(0);

      await expect(page.getByTestId('note-content-input')).toBeVisible({ timeout: 7_000 });
      await expect(page.getByTestId('note-content-input')).toHaveValue(body);
      await expect(page.getByText('Note is Locked')).toHaveCount(0);

      await partner.getByTestId('partner-settings-open').click();
      await partner.getByTestId('partner-current-pin').fill('012345');
      await partner.getByTestId('partner-new-pin').fill('654321');
      await partner.getByTestId('partner-new-pin-confirm').fill('654321');
      await partner.getByTestId('partner-settings-submit').click();
      await expect(partner.getByRole('heading', { name: 'Locked notes', exact: true })).toBeVisible();
      await expect(partner.getByRole('status')).toContainText(/PIN changed/i);

      await partner.getByTestId('partner-logout').click();
      await expect(partner.getByTestId('partner-login-form')).toBeVisible();
      await partner.getByTestId('partner-login-pin').fill('012345');
      await partner.getByTestId('partner-login-submit').click();
      await expect(partner.getByRole('alert')).toContainText(/PIN|accepted/i);
      await partner.getByTestId('partner-login-pin').fill('654321');
      await partner.getByTestId('partner-login-submit').click();
      await expect(partner.getByRole('heading', { name: 'Locked notes', exact: true })).toBeVisible();

      await pool.query('DELETE FROM accountability_sessions WHERE access_id = 1');
      await partner.getByTestId('partner-notes-refresh').click();
      await expect(partner.getByTestId('partner-login-form')).toBeVisible();
      await expect(partner.getByRole('status')).toContainText(/session expired/i);
      await partner.getByTestId('partner-login-pin').fill('654321');
      await partner.getByTestId('partner-login-submit').click();
      await expect(partner.getByRole('heading', { name: 'Locked notes', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Back' }).click();
      await page.getByTestId('partner-access-open').click();
      await expect(page.getByTestId('partner-access-status')).toHaveText('Active');
      await expect(page.getByTestId('partner-access-panel').getByRole('button')).toHaveCount(1);
      await expect(page.getByTestId('partner-share-url')).toHaveCount(0);
      await page.goto(shareUrl);
      await expect(page.getByTestId('partner-login-form')).toBeVisible();
      await expect(page.getByTestId('partner-note-list')).toHaveCount(0);

      await partner.reload();
      await expect(partner.getByTestId('partner-login-form')).toBeVisible();
    } finally {
      await partnerContext.close();
    }
  });

  test('invalid partner fragments render the unavailable state', async ({ page }) => {
    await page.goto('/partner#invalid-token');
    await expect(page.getByTestId('partner-link-unavailable')).toBeVisible();
    await expect.poll(() => page.url()).not.toContain('#');
  });
});
