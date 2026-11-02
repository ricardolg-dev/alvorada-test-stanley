// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServer, type FakeServer } from '../test-support/fake-server';
import { start, advance, freePlay } from '../guide/guide-run';
import { GuideBar } from './guide-bar';
import { SimulatorPage } from './simulator-page';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Each Do this step is followed by a short lockout, so a long run takes seconds.
vi.setConfig({ testTimeout: 20_000 });

let server: FakeServer;
let container: HTMLDivElement;
let root: Root;

const fid = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-fid]')].find(
    (el) => el.getAttribute('data-fid') === name,
  ) ?? null;
const must = (name: string): HTMLElement => {
  const el = fid(name);
  if (el === null) throw new Error(`no control ${name}`);
  return el;
};
const text = () => document.body.textContent;
const label = () => document.querySelector('.step-count')?.textContent ?? '';
const doStep = () => must('do-step') as HTMLButtonElement;

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<SimulatorPage />);
    await Promise.resolve();
  });
  await until(() => !doStep().disabled, 'the first step to be ready');
}

/** Presses Do this step until the bar shows `target` (a label or the end). */
async function doStepsUntil(target: string): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    if (label().startsWith(target) || text().includes(target)) return;
    const before = label();
    await until(() => !doStep().disabled, `Do this step at "${before}"`);
    await click(doStep());
    await until(
      () => label() !== before || text().includes('Scenario complete'),
      `the step after "${before}"`,
    );
  }
  throw new Error(`never reached ${target}`);
}

beforeEach(() => {
  server = createFakeServer();
  vi.stubGlobal('fetch', server.fetch);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('opening the page', () => {
  it('starts in the conflict scenario at step 1 after one reset', async () => {
    await mount();

    expect(label()).toBe('Step 1 of 8 · Set up');
    expect(must('scenario:conflict').getAttribute('aria-pressed')).toBe('true');
    expect(must('scenario:lost').getAttribute('aria-pressed')).toBe('false');
    expect(must('free').getAttribute('aria-pressed')).toBe('false');
    expect(text()).toContain('Create the claim note on the phone.');
    expect(text()).toContain(
      'Expected: created at r1. An online device sends it right away.',
    );
    expect(server.calls('POST /reset')).toBe(1);
  });

  it('prefills the new note text and highlights the control', async () => {
    await mount();

    const field = must('new-text:adjuster') as HTMLTextAreaElement;
    expect(field.value).toBe('Claim opened: rear bumper damage reported.');
    expect(must('create:adjuster').classList.contains('spot')).toBe(true);
    expect(must('pull:office').classList.contains('spot')).toBe(false);
  });
});

describe('following a scenario with Do this step', () => {
  it('reaches the end of the conflict scenario with 8 of 8 matching', async () => {
    await mount();

    await doStepsUntil('Scenario complete');

    expect(text()).toContain('Scenario complete. 8 of 8 steps matched.');
    expect(text()).toContain(
      'Both edits survived. The server surfaced the conflict, a person chose the text, and nothing was silently overwritten.',
    );
    // Rules, not read back from the page: r1 create, r2 office, r3 resolution.
    expect(server.notes()).toHaveLength(1);
    expect(server.notes()[0]?.revision).toBe(3);
    expect(must('next-scenario').textContent).toBe(
      'Run “Lost response and resend”',
    );
    expect(must('restart').textContent).toBe('Run this one again');
  });

  it('reaches the end of the lost-response scenario with 3 of 3 matching', async () => {
    await mount();
    await click(must('scenario:lost'));
    await until(() => label() === 'Step 1 of 3 · Lose it', 'the lost scenario');
    await until(() => !doStep().disabled, 'step 1 to be ready');

    await doStepsUntil('Scenario complete');

    expect(text()).toContain('Scenario complete. 3 of 3 steps matched.');
    expect(server.notes()).toHaveLength(1);
    expect(server.notes()[0]?.revision).toBe(1);
  });

  it('opens the receipts section and highlights Resend on the last conflict step', async () => {
    await mount();

    await doStepsUntil('Step 8 of 8');

    const resend = document.querySelector('.spot');
    expect(resend?.getAttribute('data-fid')).toMatch(/^resend:adjuster:\d+$/);
    expect(resend?.closest('details')?.open).toBe(true);
  });

  it('prefills the edit text of the selected note', async () => {
    await mount();

    await doStepsUntil('Step 4 of 8');

    const field = document.querySelector<HTMLTextAreaElement>(
      '[data-fid^="field-edit:adjuster:"]',
    );
    expect(field?.value).toBe(
      'Inspection: rear bumper and left tail light damaged.',
    );
  });

  it('shows the result of the last step against what was expected', async () => {
    await mount();

    await click(doStep());
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');

    expect(text()).toContain('Step 1: ✓ as expected · server at r1');
  });
});

/** Types into a React-controlled text box. */
async function typeInto(field: HTMLElement, value: string): Promise<void> {
  const box = field as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

const noteButtons = () =>
  [...document.querySelectorAll('[data-fid^="select:adjuster:"]')].map(
    (el) => el.getAttribute('data-fid')?.slice('select:adjuster:'.length) ?? '',
  );

/** At step 3 with a second note on the phone; returns both note ids. */
async function stepThreeWithTwoNotes(): Promise<[string, string]> {
  await mount();
  await doStepsUntil('Step 3 of 8');
  await until(() => !doStep().disabled, 'step 3 to be ready');
  const first = noteButtons()[0] ?? '';
  await click(must('new:adjuster'));
  await typeInto(must('new-text:adjuster'), 'A second claim note.');
  await click(must('create:adjuster'));
  await until(() => noteButtons().length === 2, 'the second note');
  await until(() => !doStep().disabled, 'Do this step after the second note');
  const second = noteButtons().find((id) => id !== first) ?? '';
  return [first, second];
}

describe('a screen choice the guide did not make', () => {
  it('does not report a false block when the step is shown with another note selected', async () => {
    const [first] = await stepThreeWithTwoNotes();

    await click(doStep());
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');

    // As soon as the step is shown: the guide brought the right note forward,
    // so Save edit is on screen and the step is not blocked.
    expect(must(`edit:adjuster:${first}`).classList.contains('spot')).toBe(
      true,
    );
    expect(text()).not.toContain('This step cannot run in the current state');
  });

  it('keeps the highlight on the note the step is about when another note is selected', async () => {
    const [first, second] = await stepThreeWithTwoNotes();
    await click(doStep());
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    await until(() => !doStep().disabled, 'step 4 to be ready');

    await click(must(`select:adjuster:${second}`));
    await until(() => document.querySelector('.spot') === null, 'no highlight');

    // The other note's Save edit is not the step's control and is not marked.
    expect(must(`edit:adjuster:${second}`).classList.contains('spot')).toBe(
      false,
    );
    expect(doStep().disabled).toBe(true);
    expect(text()).toContain(`Select ${first} to continue.`);
    expect(text()).not.toContain('This step cannot run in the current state');

    await click(must(`select:adjuster:${first}`));
    await until(() => !doStep().disabled, 'the step to be ready again');
    expect(must(`edit:adjuster:${first}`).classList.contains('spot')).toBe(
      true,
    );
  });

  it('never leaves Do this step enabled with nothing to press', async () => {
    const [first, second] = await stepThreeWithTwoNotes();
    await click(doStep());
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    await until(() => !doStep().disabled, 'step 4 to be ready');
    await click(must(`select:adjuster:${second}`));
    await until(() => doStep().disabled, 'Do this step to be disabled');

    // Whatever the person does, the button is off exactly when there is no
    // control to press.
    expect(fid(`edit:adjuster:${first}`)).toBeNull();
    expect(doStep().disabled).toBe(true);
  });
});

describe('activating Do this step twice', () => {
  it('runs one step for two activations 150 ms apart', async () => {
    await mount();
    await doStepsUntil('Step 3 of 8');
    await until(() => !doStep().disabled, 'step 3 to be ready');

    await click(doStep());
    await new Promise((resolve) => setTimeout(resolve, 150));
    await click(doStep());
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    // Step 4 is shown and not yet run: it would otherwise be step 5 by now.
    expect(label()).toBe('Step 4 of 8 · Diverge');
    expect(text()).not.toContain('Step 4:');
    expect(must('net:adjuster:offline').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('runs the next step once the lockout has passed', async () => {
    await mount();
    await doStepsUntil('Step 3 of 8');
    await until(() => !doStep().disabled, 'step 3 to be ready');

    await click(doStep());
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    await until(() => !doStep().disabled, 'Do this step to come back');
    await click(doStep());

    await until(() => label().startsWith('Step 5 of 8'), 'step 5');
  });
});

/** Answers the first request that matches with a 500, then behaves normally. */
function failOnce(route: string): void {
  let failed = false;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (!failed && `${method} ${input.replace('/api', '')}` === route) {
      failed = true;
      return Promise.resolve(new Response('boom', { status: 500 }));
    }
    return server.fetch(input, init);
  });
}

const READ_FAILED_TEXT =
  'The server could not be read, so this step is on hold until a read succeeds.';

describe('when the server cannot be read', () => {
  it('says why the step is on hold, then reads again and goes on', async () => {
    await mount();
    await doStepsUntil('Step 3 of 8');
    await until(() => !doStep().disabled, 'step 3 to be ready');
    failOnce('GET /notes');

    await click(doStep());
    await until(
      () => text().includes(READ_FAILED_TEXT),
      'the reason for the hold',
    );

    expect(label().startsWith('Step 3 of 8')).toBe(true);
    expect(doStep().disabled).toBe(true);
    expect(text()).toContain('Could not read the server');

    // One more read, a moment later, settles it and the step goes on.
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    expect(text()).not.toContain(READ_FAILED_TEXT);
    expect(text()).toContain('Step 3: ✓ as expected');
  });

  it('keeps reading while reads fail and goes on by itself once one works', async () => {
    await mount();
    await doStepsUntil('Step 3 of 8');
    await until(() => !doStep().disabled, 'step 3 to be ready');
    let attempts = 0;
    let failing = true;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (
        !failing ||
        (init?.method ?? 'GET') !== 'GET' ||
        !input.endsWith('/notes')
      ) {
        return server.fetch(input, init);
      }
      attempts += 1;
      return Promise.resolve(new Response('boom', { status: 500 }));
    });

    await click(doStep());
    await until(() => text().includes(READ_FAILED_TEXT), 'the hold');
    // The read behind the change, and a try every second after it.
    const deadline = Date.now() + 8000;
    while (attempts < 4 && Date.now() < deadline) await tick();
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(label().startsWith('Step 3 of 8')).toBe(true);
    expect(text()).toContain(READ_FAILED_TEXT);
    expect(doStep().disabled).toBe(true);

    failing = false;
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    expect(text()).not.toContain(READ_FAILED_TEXT);
  });

  it('drops the pending retry when a newer read has already settled the step', async () => {
    await mount();
    await doStepsUntil('Step 3 of 8');
    await until(() => !doStep().disabled, 'step 3 to be ready');
    failOnce('GET /notes');
    await click(doStep());
    await until(() => text().includes(READ_FAILED_TEXT), 'the hold');

    // Any change of a device reads the server again, and that read works.
    await click(must('net:office:offline'));
    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    const reads = server.calls('GET /notes');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400));
    });

    expect(server.calls('GET /notes')).toBe(reads);
  });

  it('reads again after a reset fails, so the guide is not left waiting', async () => {
    await mount();
    await doStepsUntil('Step 3 of 8');
    await until(() => !doStep().disabled, 'step 3 to be ready');
    server.hold('GET /notes');
    await click(doStep());
    await act(async () => {
      await server.waitFor('GET /notes');
    });
    failOnce('POST /reset');

    await click(must('reset'));
    await until(() => text().includes('Reset failed'), 'the reset to fail');
    await act(async () => {
      server.release('GET /notes');
      await Promise.resolve();
    });

    await until(() => label().startsWith('Step 4 of 8'), 'step 4');
    expect(text()).toContain('Reset failed');
  });
});

describe('evaluating only after the response and the refresh', () => {
  it('keeps the step current while the response is held, then while the refresh is held', async () => {
    await mount();
    server.hold('POST /operations');

    await click(doStep());
    await act(async () => {
      await server.waitFor('POST /operations');
    });
    await tick();
    expect(label()).toBe('Step 1 of 8 · Set up');
    expect(text()).not.toContain('Step 1:');
    expect(doStep().disabled).toBe(true);

    server.hold('GET /notes');
    await act(async () => {
      server.release('POST /operations');
      await server.waitFor('GET /notes');
    });
    await tick();
    // The device already applied the receipt, but the server was not refreshed.
    expect(text()).toContain('Last seen at r1');
    expect(label()).toBe('Step 1 of 8 · Set up');
    expect(text()).not.toContain('Step 1:');

    await act(async () => {
      server.release('GET /notes');
      await Promise.resolve();
    });
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');
    expect(text()).toContain('Step 1: ✓ as expected');
    expect(text().match(/Step 1:/g)).toHaveLength(1);
  });
});

describe('blocked steps', () => {
  it('says why, disables Do this step, and lets go once the device is back', async () => {
    await mount();
    await click(doStep());
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');
    await until(() => !doStep().disabled, 'step 2 to be ready');

    await click(must('net:office:offline'));
    await until(() => doStep().disabled, 'Do this step to be disabled');

    expect(text()).toContain(
      'The office computer is offline, so this step is blocked. Bring it back online to continue.',
    );

    await click(must('net:office:online'));
    await until(() => !doStep().disabled, 'Do this step to be enabled');
    expect(text()).not.toContain('is offline, so this step is blocked');
  });
});

describe('resolving a conflict from the page', () => {
  it('says the server text was kept, and not that the proposal was discarded', async () => {
    await mount();
    await doStepsUntil('Step 7 of 8');
    const keep = document.querySelector<HTMLElement>(
      '[data-fid^="resolve:adjuster:"][data-fid$=":server"]',
    );
    if (keep === null) throw new Error('no Keep server text button');
    const noteId = keep.getAttribute('data-fid')?.split(':')[2] ?? '';
    const posts = server.calls('POST /operations');

    await click(keep);

    await until(
      () =>
        text().includes(`Kept the server text of ${noteId}; nothing to send.`),
      'the message',
    );
    expect(text()).not.toContain('Discarded the proposal');
    expect(server.calls('POST /operations')).toBe(posts);
    expect(server.notes()[0]?.revision).toBe(2);
  });
});

describe('a note the server lost', () => {
  it('says the server no longer holds the note once the next read shows it', async () => {
    await mount();
    await click(doStep());
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');
    await until(() => !doStep().disabled, 'step 2 to be ready');

    // Another client empties the server; the open page cannot know yet.
    await server.fetch('/api/reset', { method: 'POST' });
    await click(doStep());

    await until(
      () =>
        text().includes(
          'The server no longer holds this note. Restart the scenario.',
        ),
      'the reason',
    );
    expect(label().startsWith('Step 2 of 8')).toBe(true);
    expect(doStep().disabled).toBe(true);
  });
});

describe('choosing a scenario, Reset and Free play', () => {
  it('resets the server and both devices when a scenario is chosen', async () => {
    await mount();
    await click(doStep());
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');
    expect(server.notes()).toHaveLength(1);

    await click(must('scenario:lost'));
    await until(() => label().startsWith('Step 1 of 3'), 'the lost scenario');

    expect(server.notes()).toHaveLength(0);
    expect(server.calls('POST /reset')).toBe(2);
    expect(text()).toContain('No notes on this device.');
  });

  it('keeps notes, outboxes and the server in Free play', async () => {
    await mount();
    await click(doStep());
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');

    await click(must('free'));
    await tick();

    expect(must('free').getAttribute('aria-pressed')).toBe('true');
    expect(server.calls('POST /reset')).toBe(1);
    expect(server.notes()).toHaveLength(1);
    expect(text()).toContain('Free play: use both devices however you like.');
    expect(document.querySelector('.spot')).toBeNull();
    // Both devices stay usable.
    await click(must('pull:office'));
    await until(
      () => document.querySelector('[data-fid^="select:office:"]') !== null,
      'the office to show the note',
    );
  });

  it('only resets in Free play and stays there', async () => {
    await mount();
    await click(doStep());
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');
    await click(must('free'));

    await click(must('reset'));
    await until(() => server.notes().length === 0, 'the server to empty');
    await tick();

    expect(must('free').getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('No notes on this device.');
  });

  it('restarts the current scenario on Reset', async () => {
    await mount();
    await click(doStep());
    await until(() => label().startsWith('Step 2 of 8'), 'step 2');

    await click(must('reset'));
    await until(() => label().startsWith('Step 1 of 8'), 'step 1 again');

    expect(server.notes()).toHaveLength(0);
    expect(text()).not.toContain('Step 1: ✓');
  });

  it('closes the receipts section on Reset', async () => {
    await mount();
    await doStepsUntil('Step 8 of 8');
    expect(document.querySelectorAll('details[open]').length).toBeGreaterThan(
      0,
    );

    await click(must('reset'));
    await until(() => label().startsWith('Step 1 of 8'), 'step 1 again');

    expect(document.querySelectorAll('details[open]')).toHaveLength(0);
  });
});

const isOff = (name: string) => (must(name) as HTMLButtonElement).disabled;
const inertStage = () =>
  document.querySelector('.stage')?.hasAttribute('inert') ?? false;

async function startReset(): Promise<void> {
  server.hold('POST /reset');
  await click(must('reset'));
  await act(async () => {
    await server.waitFor('POST /reset');
  });
}

async function endReset(): Promise<void> {
  await act(async () => {
    server.release('POST /reset');
    await Promise.resolve();
  });
  await until(() => !isOff('reset'), 'the reset to settle');
}

describe('while a reset is under way', () => {
  it('turns the stage inert and disables the chooser, Reset and Do this step', async () => {
    await mount();
    expect(inertStage()).toBe(false);

    await startReset();

    expect(inertStage()).toBe(true);
    for (const name of [
      'reset',
      'scenario:conflict',
      'scenario:lost',
      'free',
    ]) {
      expect(isOff(name)).toBe(true);
    }
    expect(isOff('do-step')).toBe(true);
    expect(isOff('restart')).toBe(true);

    await endReset();
    expect(inertStage()).toBe(false);
    await until(() => !isOff('do-step'), 'Do this step to come back');
  });

  it('is under way from mount until the first reset settles', async () => {
    server.hold('POST /reset');
    await act(async () => {
      root.render(<SimulatorPage />);
      await Promise.resolve();
    });
    await act(async () => {
      await server.waitFor('POST /reset');
    });

    expect(inertStage()).toBe(true);
    expect(isOff('reset')).toBe(true);
    expect(isOff('scenario:lost')).toBe(true);
    expect(isOff('do-step')).toBe(true);

    await endReset();
    expect(inertStage()).toBe(false);
  });

  it('sends one reset for a second call made meanwhile', async () => {
    await mount();
    await startReset();

    await click(must('reset'));
    await click(must('restart'));
    await click(must('scenario:lost'));
    await endReset();
    await tick();

    // One from opening the page and one for the click.
    expect(server.calls('POST /reset')).toBe(2);
    expect(label()).toBe('Step 1 of 8 · Set up');
  });

  it('does not let Free play replace the scenario being started', async () => {
    await mount();
    server.hold('POST /reset');
    await click(must('scenario:lost'));
    await act(async () => {
      await server.waitFor('POST /reset');
    });

    expect(isOff('free')).toBe(true);
    await click(must('free'));
    await endReset();
    await until(() => label().startsWith('Step 1 of 3'), 'the lost scenario');

    const pressed = ['scenario:conflict', 'scenario:lost', 'free'].filter(
      (name) => must(name).getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toEqual(['scenario:lost']);
  });

  it('lets a request already sent land before it empties the server', async () => {
    await mount();
    server.hold('POST /operations');
    await click(must('create:adjuster'));
    await act(async () => {
      await server.waitFor('POST /operations');
    });

    await click(must('reset'));
    await tick();
    // The server is not emptied while the request is out.
    expect(server.calls('POST /reset')).toBe(1);
    expect(isOff('reset')).toBe(true);

    await act(async () => {
      server.release('POST /operations');
      await Promise.resolve();
    });
    await until(
      () => server.calls('POST /reset') === 2,
      'the reset to be sent',
    );
    await until(() => !isOff('reset'), 'the reset to settle');
    await tick();

    expect(server.notes()).toEqual([]);
    expect(text()).toContain('No notes on the server.');
    expect(text()).toContain('No notes on this device.');
    expect(text()).toContain('0 stored receipts');
  });
});

describe('GuideBar markup', () => {
  const noop = () => undefined;
  const props = {
    working: false,
    resetting: false,
    onChoose: noop,
    onFree: noop,
    onRestart: noop,
    onDoStep: noop,
  };

  it('shows the generic reason text it is given and disables Do this step', () => {
    const html = renderToStaticMarkup(
      <GuideBar
        {...props}
        run={start('conflict')}
        blocked="This step cannot run in the current state. Restart the scenario to continue."
      />,
    );
    expect(html).toContain(
      'This step cannot run in the current state. Restart the scenario to continue.',
    );
    expect(html).toMatch(/<button[^>]*data-fid="do-step"[^>]*disabled/);
  });

  it('disables the chooser, Do this step and Restart while resetting', () => {
    const html = renderToStaticMarkup(
      <GuideBar {...props} resetting run={start('conflict')} blocked={null} />,
    );
    for (const name of [
      'scenario:conflict',
      'scenario:lost',
      'free',
      'do-step',
      'restart',
    ]) {
      expect(html).toMatch(
        new RegExp(`<button[^>]*data-fid="${name}"[^>]*disabled`),
      );
    }
  });

  it('shows one progress cell per step, marking matched, different and current', () => {
    const run = {
      ...start('lost'),
      index: 2,
      results: [
        { n: 1, title: 'a', expected: 'b', got: 'c', ok: true },
        { n: 2, title: 'a', expected: 'b', got: 'c', ok: false },
      ],
    };
    const html = renderToStaticMarkup(
      <GuideBar {...props} run={run} blocked={null} />,
    );
    expect(html).toContain(
      '<div class="progress" aria-hidden="true"><span class="done"></span><span class="miss"></span><span class="now"></span></div>',
    );
    expect(html).toContain('Step 3 of 3 · Resend');
    expect(html).toContain('different from expected');
  });

  it('in Free play shows no progress and no step', () => {
    const html = renderToStaticMarkup(
      <GuideBar {...props} run={freePlay()} blocked={null} />,
    );
    expect(html).not.toContain('class="progress"');
    expect(html).not.toContain('data-fid="do-step"');
    expect(advance(freePlay(), {} as never)).toEqual(freePlay());
  });
});

describe('notes whose ids match members of Object', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    'opens and saves a note with the id %s',
    async (noteId) => {
      await mount();
      await click(must('free'));
      await server.fetch('/api/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          {
            op_id: 'seed',
            note_id: noteId,
            base_revision: 0,
            text: 'server text',
          },
        ]),
      });
      await click(must('pull:adjuster'));
      await until(
        () => fid(`select:adjuster:${noteId}`) !== null,
        'the pulled note',
      );
      await click(must(`select:adjuster:${noteId}`));
      const field = must(`field-edit:adjuster:${noteId}`);
      expect((field as HTMLTextAreaElement).value).toBe('server text');
      await click(must(`edit:adjuster:${noteId}`));
      await until(
        () => server.notes().some((note) => note.revision === 2),
        'the saved edit',
      );
      expect(server.notes()).toEqual([
        { note_id: noteId, revision: 2, text: 'server text' },
      ]);
    },
  );
});
