import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

// Real clicks and typing against the running page and the NestJS API behind
// the /api proxy. Server state is read over HTTP, never taken from page text
// alone.

// The same variables and defaults as playwright.config.ts and the apps.
const WEB_PORT = process.env.WEB_PORT ?? '3000';
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = process.env.API_URL ?? 'http://127.0.0.1:3001';
const API_PORT = new URL(API).port;

const OPENED = 'Claim opened: rear bumper damage reported.';
const FIELD_EDIT = 'Inspection: rear bumper and left tail light damaged.';
const OFFICE_EDIT = 'Customer sent photos of the damage.';

interface ApiNote {
  note_id: string;
  revision: number;
  text: string;
}

// A reused server must be this project's own: a port held by some other
// process would make every later failure look like a product bug.
test.beforeAll(async () => {
  let page: string;
  try {
    page = await (await fetch(`${WEB}/`)).text();
  } catch {
    throw new Error(`Nothing answers on port ${WEB_PORT} (${WEB}).`);
  }
  if (!page.includes('data-fid="reset"')) {
    throw new Error(
      `The page on port ${WEB_PORT} is not this simulator: no data-fid="reset".`,
    );
  }
  let count: unknown;
  try {
    const response = await fetch(`${API}/receipts/count`);
    count = ((await response.json()) as { count?: unknown }).count;
  } catch {
    throw new Error(`The API on port ${API_PORT} (${API}) does not answer.`);
  }
  if (typeof count !== 'number') {
    throw new Error(
      `The process on port ${API_PORT} is not this API: /receipts/count has no numeric count.`,
    );
  }
});

/** Opens the page and waits for the reset it makes on mount. */
async function openSimulator(page: Page): Promise<void> {
  const reset = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/reset') &&
      response.request().method() === 'POST',
  );
  await page.goto('/');
  expect((await reset).status()).toBe(204);
  await expect(server(page).getByText('No notes on the server.')).toBeVisible();
}

const fid = (page: Page, value: string): Locator =>
  page.locator(`[data-fid="${value}"]`);
const phone = (page: Page): Locator =>
  page.getByRole('region', { name: 'Field adjuster phone' });
const computer = (page: Page): Locator =>
  page.getByRole('region', { name: 'Claims office computer' });
const server = (page: Page): Locator =>
  page.getByRole('region', { name: 'Server' });
const guide = (page: Page): Locator =>
  page.getByRole('region', { name: 'Guide' });
const log = (page: Page): Locator =>
  page.getByRole('region', { name: 'What just happened' });

async function apiNotes(request: APIRequestContext): Promise<ApiNote[]> {
  const response = await request.get('/api/notes');
  expect(response.status()).toBe(200);
  return (await response.json()) as ApiNote[];
}

async function apiNote(
  request: APIRequestContext,
  noteId: string,
): Promise<ApiNote> {
  const response = await request.get(`/api/notes/${noteId}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as ApiNote;
}

async function apiReceiptCount(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/receipts/count');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { count: number }).count;
}

/** The generated note id, read from the server since the device makes it up. */
async function onlyServerNote(request: APIRequestContext): Promise<ApiNote> {
  const notes = await apiNotes(request);
  expect(notes).toHaveLength(1);
  return notes[0];
}

test.describe('two devices, one server', () => {
  test('a conflict is surfaced, resolved by a person, and a resend adds no revision', async ({
    page,
    request,
  }) => {
    await openSimulator(page);
    await fid(page, 'free').click();

    // The field adjuster creates the note; the server holds it at r1.
    await fid(page, 'new-text:adjuster').fill(OPENED);
    await fid(page, 'create:adjuster').click();
    await expect(server(page).locator('.rev')).toHaveText('r1');
    const created = await onlyServerNote(request);
    expect(created).toMatchObject({ revision: 1, text: OPENED });
    const noteId = created.note_id;
    expect(await apiReceiptCount(request)).toBe(1);

    // The claims office pulls and sees the same note at r1.
    await fid(page, 'pull:office').click();
    const officeRow = fid(page, `select:office:${noteId}`);
    await expect(officeRow).toContainText('r1');
    await expect(fid(page, `select:adjuster:${noteId}`)).toContainText('r1');
    await officeRow.click();
    await expect(computer(page).locator('.note-text')).toHaveText(OPENED);

    // The field adjuster goes offline and edits: pending, nothing sent.
    await fid(page, 'net:adjuster:offline').click();
    await expect(fid(page, 'pull:adjuster')).toBeDisabled();
    await fid(page, `field-edit:adjuster:${noteId}`).fill(FIELD_EDIT);
    await fid(page, `edit:adjuster:${noteId}`).click();
    await expect(
      phone(page).getByText('pending', { exact: true }),
    ).toBeVisible();
    expect(await apiNote(request, noteId)).toMatchObject({ revision: 1 });

    // The claims office edits the same note on base r1: the server goes to r2.
    await fid(page, `field-edit:office:${noteId}`).fill(OFFICE_EDIT);
    await fid(page, `edit:office:${noteId}`).click();
    await expect(server(page).locator('.rev')).toHaveText('r2');
    expect(await apiNote(request, noteId)).toEqual({
      note_id: noteId,
      revision: 2,
      text: OFFICE_EDIT,
    });

    // Back online, the pending edit goes out on base r1 and comes back as
    // conflito with both texts; the server note is untouched.
    await fid(page, 'net:adjuster:online').click();
    await expect(
      phone(page).getByText('conflito', { exact: true }).first(),
    ).toBeVisible();
    const compare = phone(page).locator('.compare');
    await expect(compare).toContainText(OFFICE_EDIT);
    await expect(compare).toContainText(FIELD_EDIT);
    await expect(compare).toContainText('Server · r2');
    expect(await apiNote(request, noteId)).toMatchObject({
      revision: 2,
      text: OFFICE_EDIT,
    });
    const receiptsAtConflict = await apiReceiptCount(request);
    expect(receiptsAtConflict).toBe(3);

    // The person picks a text. "Keep server text" would send nothing, so the
    // adjuster's own text goes out as a new operation on base r2.
    await fid(page, `resolve:adjuster:${noteId}:mine`).click();
    await expect(server(page).locator('.rev')).toHaveText('r3');
    expect(await apiNote(request, noteId)).toEqual({
      note_id: noteId,
      revision: 3,
      text: FIELD_EDIT,
    });
    expect(await apiReceiptCount(request)).toBe(4);

    // Resending the conflito receipt returns the original answer: still a
    // conflict on r2, and no new revision or stored receipt on the server.
    await fid(page, 'receipts:adjuster').click();
    const conflictRows = phone(page)
      .locator('.receipt')
      .filter({ hasText: 'conflito' });
    await expect(conflictRows).toHaveCount(1);
    await conflictRows.getByRole('button', { name: 'Resend' }).click();
    await expect(conflictRows).toHaveCount(2);
    const resent = conflictRows.filter({ hasText: 'resent' });
    await expect(resent).toHaveCount(1);
    await expect(resent).toContainText('server r2 · proposal on base r1');
    expect(await apiNote(request, noteId)).toMatchObject({
      revision: 3,
      text: FIELD_EDIT,
    });
    expect(await apiReceiptCount(request)).toBe(4);
    await expect(server(page).locator('.rev')).toHaveText('r3');
    await expect(server(page)).toContainText('4 stored receipts');

    // Reset empties the server, both devices and the log.
    await expect(log(page).locator('.log-row').first()).toBeVisible();
    await fid(page, 'reset').click();
    await expect(
      server(page).getByText('No notes on the server.'),
    ).toBeVisible();
    await expect(server(page)).toContainText('0 stored receipts');
    expect(await apiNotes(request)).toEqual([]);
    expect(await apiReceiptCount(request)).toBe(0);
    await expect(
      phone(page).getByText('No notes on this device.'),
    ).toBeVisible();
    await expect(
      computer(page).getByText('No notes on this device.'),
    ).toBeVisible();
    await expect(log(page).getByText('Nothing sent yet.')).toBeVisible();
    await expect(log(page).locator('.log-row')).toHaveCount(0);
  });

  test('keeping the server text sends nothing and says so', async ({
    page,
    request,
  }) => {
    await openSimulator(page);
    await fid(page, 'free').click();
    await fid(page, 'new-text:adjuster').fill(OPENED);
    await fid(page, 'create:adjuster').click();
    await expect(server(page).locator('.rev')).toHaveText('r1');
    const { note_id: noteId } = await onlyServerNote(request);
    await fid(page, 'pull:office').click();
    await expect(fid(page, `select:office:${noteId}`)).toContainText('r1');

    await fid(page, 'net:adjuster:offline').click();
    await fid(page, `field-edit:adjuster:${noteId}`).fill(FIELD_EDIT);
    await fid(page, `edit:adjuster:${noteId}`).click();
    await fid(page, `field-edit:office:${noteId}`).fill(OFFICE_EDIT);
    await fid(page, `edit:office:${noteId}`).click();
    await expect(server(page).locator('.rev')).toHaveText('r2');
    await fid(page, 'net:adjuster:online').click();
    await expect(phone(page).locator('.compare')).toContainText(FIELD_EDIT);
    const receiptsAtConflict = await apiReceiptCount(request);
    expect(receiptsAtConflict).toBe(3);

    const posts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/operations')) {
        posts.push(req.url());
      }
    });
    await fid(page, `resolve:adjuster:${noteId}:server`).click();

    // The proposal is gone and nothing was sent: the server note and the
    // number of stored receipts are exactly what they were.
    await expect(phone(page).locator('.compare')).toHaveCount(0);
    await expect(phone(page)).toContainText(
      `Kept the server text of ${noteId}; nothing to send.`,
    );
    await expect(fid(page, `edit:adjuster:${noteId}`)).toBeVisible();
    expect(posts).toEqual([]);
    expect(await apiNote(request, noteId)).toEqual({
      note_id: noteId,
      revision: 2,
      text: OFFICE_EDIT,
    });
    expect(await apiReceiptCount(request)).toBe(receiptsAtConflict);
    await expect(server(page).locator('.rev')).toHaveText('r2');
    await expect(phone(page).locator('.pending-box')).toHaveCount(0);
  });

  test('a reset while a request is out leaves no note on the server', async ({
    page,
    request,
  }) => {
    await openSimulator(page);
    await page.route('**/api/operations', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    const operations = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/operations') &&
        response.request().method() === 'POST',
    );
    const reset = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/reset') &&
        response.request().method() === 'POST',
    );

    await fid(page, 'new-text:adjuster').fill(OPENED);
    await fid(page, 'create:adjuster').click();
    await page.waitForTimeout(100);
    await fid(page, 'reset').click();

    // Meanwhile nothing can be used: the chooser, Reset and Do this step are
    // off, and a real click on the office screen reaches nothing.
    await expect(fid(page, 'reset')).toBeDisabled();
    await expect(fid(page, 'do-step')).toBeDisabled();
    for (const name of ['scenario:conflict', 'scenario:lost', 'free']) {
      await expect(fid(page, name)).toBeDisabled();
    }
    await expect(page.locator('.stage')).toHaveJSProperty('inert', true);
    const offline = fid(page, 'net:office:offline');
    const box = await offline.boundingBox();
    if (box === null) throw new Error('the office toolbar has no box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(offline).toHaveAttribute('aria-pressed', 'false');

    await reset;
    await operations;
    await expect(fid(page, 'reset')).toBeEnabled();
    await expect(page.locator('.stage')).toHaveJSProperty('inert', false);

    // The note the request carried was wiped, not left behind.
    expect(await apiNotes(request)).toEqual([]);
    expect(await apiReceiptCount(request)).toBe(0);
    await expect(
      server(page).getByText('No notes on the server.'),
    ).toBeVisible();
    await expect(server(page)).toContainText('0 stored receipts');
    await expect(
      phone(page).getByText('No notes on this device.'),
    ).toBeVisible();
    await page.waitForTimeout(300);
    expect(await apiNotes(request)).toEqual([]);
  });

  test('a lost response leaves the operation waiting and Retry brings back the stored receipt', async ({
    page,
    request,
  }) => {
    await openSimulator(page);
    await fid(page, 'free').click();
    await expect(fid(page, 'retry:adjuster')).toHaveCount(0);

    await fid(page, 'lose:adjuster').check();
    await fid(page, 'new-text:adjuster').fill(OPENED);
    await fid(page, 'create:adjuster').click();

    // The server applied it once; the phone never heard back.
    await expect(fid(page, 'retry:adjuster')).toBeVisible();
    await expect(
      phone(page).getByText('waiting for receipt').first(),
    ).toBeVisible();
    const stored = await onlyServerNote(request);
    expect(stored).toMatchObject({ revision: 1, text: OPENED });
    expect(await apiReceiptCount(request)).toBe(1);

    // Retry resends the same operation and gets the stored created-at-r1.
    await fid(page, 'retry:adjuster').click();
    await expect(fid(page, 'retry:adjuster')).toHaveCount(0);
    await expect(phone(page).getByText('waiting for receipt')).toHaveCount(0);
    await fid(page, 'receipts:adjuster').click();
    const receipts = phone(page).locator('.receipt');
    await expect(receipts).toHaveCount(1);
    await expect(receipts.first()).toContainText('created');
    await expect(receipts.first()).toContainText('at r1');
    expect(await apiNote(request, stored.note_id)).toEqual(stored);
    expect(await apiReceiptCount(request)).toBe(1);
  });

  test('"Do this step" runs the Conflict scenario to its end', async ({
    page,
    request,
  }) => {
    await openSimulator(page);
    await expect(fid(page, 'scenario:conflict')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (let step = 1; step <= 8; step += 1) {
      await expect(
        guide(page).getByText(new RegExp(`^Step ${step} of 8`)),
      ).toBeVisible();
      await fid(page, 'do-step').click();
    }
    await expect(
      guide(page).getByText('Scenario complete. 8 of 8 steps matched.'),
    ).toBeVisible();
    await expect(fid(page, 'do-step')).toHaveCount(0);

    // The final server state follows from the rules: three revisions, and
    // neither person's text lost.
    const note = await onlyServerNote(request);
    expect(note.revision).toBe(3);
    expect(note.text).toContain(OFFICE_EDIT);
    expect(note.text).toContain(FIELD_EDIT);
    expect(await apiReceiptCount(request)).toBe(4);
  });

  test('"Do this step" runs the Lost response scenario to its end', async ({
    page,
    request,
  }) => {
    await openSimulator(page);
    await fid(page, 'scenario:lost').click();
    await expect(guide(page).getByText(/^Step 1 of 3/)).toBeVisible();
    for (let step = 1; step <= 3; step += 1) {
      await expect(
        guide(page).getByText(new RegExp(`^Step ${step} of 3`)),
      ).toBeVisible();
      await fid(page, 'do-step').click();
    }
    await expect(
      guide(page).getByText('Scenario complete. 3 of 3 steps matched.'),
    ).toBeVisible();

    const note = await onlyServerNote(request);
    expect(note.revision).toBe(1);
    expect(await apiReceiptCount(request)).toBe(1);
  });

  test('two quick clicks or a double click on "Do this step" run one step', async ({
    page,
  }) => {
    await openSimulator(page);
    for (let step = 1; step <= 2; step += 1) {
      await expect(
        guide(page).getByText(new RegExp(`^Step ${step} of 8`)),
      ).toBeVisible();
      await fid(page, 'do-step').click();
    }
    await expect(guide(page).getByText(/^Step 3 of 8/)).toBeVisible();
    await expect(fid(page, 'do-step')).toBeEnabled();

    // Two real mouse clicks 150 ms apart, at the spot of the button.
    const box = await fid(page, 'do-step').boundingBox();
    if (box === null) throw new Error('Do this step has no box');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    await page.mouse.click(x, y);
    await expect(guide(page).getByText(/^Step 4 of 8/)).toBeVisible();
    await page.waitForTimeout(800);
    await expect(guide(page).getByText(/^Step 4 of 8/)).toBeVisible();
    await expect(fid(page, 'net:adjuster:offline')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Step 4 is the edit on the phone: it has not run.
    await expect(phone(page).getByText('pending', { exact: true })).toHaveCount(
      0,
    );

    // A real double click on step 4 runs step 4 only.
    await expect(fid(page, 'do-step')).toBeEnabled();
    await fid(page, 'do-step').dblclick();
    await expect(guide(page).getByText(/^Step 5 of 8/)).toBeVisible();
    await page.waitForTimeout(800);
    await expect(guide(page).getByText(/^Step 5 of 8/)).toBeVisible();
  });

  test('"Do this step" still runs from the keyboard, one step per press', async ({
    page,
  }) => {
    await openSimulator(page);
    for (let step = 1; step <= 3; step += 1) {
      await expect(
        guide(page).getByText(new RegExp(`^Step ${step} of 8`)),
      ).toBeVisible();
      await expect(fid(page, 'do-step')).toBeEnabled();
      await fid(page, 'do-step').focus();
      await page.keyboard.press('Enter');
    }
    await expect(guide(page).getByText(/^Step 4 of 8/)).toBeVisible();
    await expect(fid(page, 'net:adjuster:offline')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('the guide follows the note a person selects on the phone', async ({
    page,
  }) => {
    await openSimulator(page);
    for (let step = 1; step <= 2; step += 1) {
      await expect(
        guide(page).getByText(new RegExp(`^Step ${step} of 8`)),
      ).toBeVisible();
      await fid(page, 'do-step').click();
    }
    await expect(guide(page).getByText(/^Step 3 of 8/)).toBeVisible();
    const rows = page.locator('[data-fid^="select:adjuster:"]');
    await expect(rows).toHaveCount(1);
    const first = (await rows.first().getAttribute('data-fid'))?.slice(
      'select:adjuster:'.length,
    );

    // A second note on the phone, which then shows the second note.
    await fid(page, 'new:adjuster').click();
    await fid(page, 'new-text:adjuster').fill('A second claim note.');
    await fid(page, 'create:adjuster').click();
    await expect(rows).toHaveCount(2);
    const second = (
      await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-fid')?.slice(16)),
      )
    ).find((id) => id !== first);
    expect(second).toBeTruthy();

    // Step 4 brings the first note back; its Save edit is the marked control.
    await expect(fid(page, 'do-step')).toBeEnabled();
    await fid(page, 'do-step').click();
    await expect(guide(page).getByText(/^Step 4 of 8/)).toBeVisible();
    await expect(guide(page)).not.toContainText('This step cannot run');
    await expect(fid(page, `edit:adjuster:${first}`)).toHaveClass(/spot/);
    await expect(fid(page, 'do-step')).toBeEnabled();

    // Selecting the other note must not move the mark to that note's button.
    await fid(page, `select:adjuster:${second}`).click();
    await expect(fid(page, `edit:adjuster:${second}`)).toBeVisible();
    await expect(fid(page, `edit:adjuster:${second}`)).not.toHaveClass(/spot/);
    await expect(page.locator('.spot')).toHaveCount(0);
    await expect(fid(page, 'do-step')).toBeDisabled();
    await expect(guide(page)).toContainText(`Select ${first} to continue.`);

    await fid(page, `select:adjuster:${first}`).click();
    await expect(fid(page, `edit:adjuster:${first}`)).toHaveClass(/spot/);
    await expect(fid(page, 'do-step')).toBeEnabled();
    await expect(guide(page)).not.toContainText('to continue.');
  });

  test('a failed read leaves "Do this step" off with a reason, and the next read goes on', async ({
    page,
  }) => {
    await openSimulator(page);
    for (let step = 1; step <= 2; step += 1) {
      await expect(
        guide(page).getByText(new RegExp(`^Step ${step} of 8`)),
      ).toBeVisible();
      await fid(page, 'do-step').click();
    }
    await expect(guide(page).getByText(/^Step 3 of 8/)).toBeVisible();
    await expect(fid(page, 'do-step')).toBeEnabled();

    // The one read after "Take the phone offline" answers 500, once.
    let failed = false;
    await page.route('**/api/notes', async (route) => {
      if (route.request().method() === 'GET' && !failed) {
        failed = true;
        await route.fulfill({ status: 500, body: 'unavailable' });
        return;
      }
      await route.continue();
    });
    await fid(page, 'do-step').click();

    await expect(guide(page)).toContainText(
      'The server could not be read, so this step is on hold',
    );
    await expect(fid(page, 'do-step')).toBeDisabled();
    await expect(server(page)).toContainText('Could not read the server');

    // The page reads again by itself and the guide goes on.
    await expect(guide(page).getByText(/^Step 4 of 8/)).toBeVisible();
    await expect(fid(page, 'do-step')).toBeEnabled();
    await expect(guide(page)).not.toContainText('on hold');
    await expect(server(page)).not.toContainText('Could not read the server');
    expect(failed).toBe(true);
  });

  test('a blocked step says why and disables "Do this step"', async ({
    page,
  }) => {
    await openSimulator(page);
    await expect(fid(page, 'do-step')).toBeEnabled();

    await fid(page, 'net:adjuster:offline').click();
    await expect(fid(page, 'do-step')).toBeDisabled();
    await expect(guide(page)).toContainText(
      'The phone is offline, so this step is blocked.',
    );

    await fid(page, 'net:adjuster:online').click();
    await expect(fid(page, 'do-step')).toBeEnabled();
    await expect(guide(page)).not.toContainText('so this step is blocked');
  });

  test('the page empties the server on open and on reload, and Free play leaves both devices usable', async ({
    page,
    request,
  }) => {
    const seed = async () => {
      const response = await request.post('/api/operations', {
        data: [
          {
            op_id: 'seed-0001',
            note_id: 'CLM-9001',
            base_revision: 0,
            text: 'A note seeded straight on the server.',
          },
        ],
      });
      expect(response.status()).toBe(200);
      expect(await apiNotes(request)).toHaveLength(1);
    };

    await seed();
    await openSimulator(page);
    expect(await apiNotes(request)).toEqual([]);
    expect(await apiReceiptCount(request)).toBe(0);
    await expect(fid(page, 'scenario:conflict')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(guide(page).getByText(/^Step 1 of 8/)).toBeVisible();

    await seed();
    const reset = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/reset') &&
        response.request().method() === 'POST',
    );
    await page.reload();
    await reset;
    await expect(
      server(page).getByText('No notes on the server.'),
    ).toBeVisible();
    expect(await apiNotes(request)).toEqual([]);

    // Free play: no step to follow, and both devices work by hand.
    await fid(page, 'free').click();
    await expect(fid(page, 'free')).toHaveAttribute('aria-pressed', 'true');
    await expect(fid(page, 'do-step')).toHaveCount(0);
    await fid(page, 'new-text:office').fill(OFFICE_EDIT);
    await fid(page, 'create:office').click();
    await expect(server(page).locator('.rev')).toHaveText('r1');
    const note = await onlyServerNote(request);
    expect(note.text).toBe(OFFICE_EDIT);
    await fid(page, 'pull:adjuster').click();
    await expect(fid(page, `select:adjuster:${note.note_id}`)).toContainText(
      'r1',
    );
  });
});
