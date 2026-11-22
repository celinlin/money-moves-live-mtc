import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const SHOTS = 'test-results/screens';

async function newPhone(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  return { ctx, page: await ctx.newPage() };
}

async function signUpHost(page: Page) {
  const email = `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  await page.goto('/host');
  await page.getByRole('button', { name: /Créer un compte/ }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mot de passe').fill('motdepasse-solide');
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: 'Mes quiz' })).toBeVisible();
}

async function primary(host: Page, label: RegExp) {
  const btn = host.getByTestId('primary-action');
  await expect(btn).toContainText(label);
  await expect(btn).toBeEnabled();
  await btn.click();
}

test('full live game: create quiz → join → play → reveal → leaderboard → podium → export, with refreshes', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const host = await hostCtx.newPage();
  await signUpHost(host);

  // Sample quizzes are seeded and clearly marked.
  await expect(host.getByTestId('quiz-card').filter({ hasText: 'Exemple' })).toHaveCount(2);

  // 1. Presenter creates a quiz in the editor.
  await host.getByRole('link', { name: /Nouveau quiz/ }).first().click();
  await host.getByLabel('Titre').fill('E2E Quiz');
  await host.getByLabel('Question', { exact: true }).fill('Combien font 2 + 2 ?');
  await host.getByRole('button', { name: '10 s' }).click();
  await host.getByLabel('Réponse A', { exact: true }).fill('4');
  await host.getByLabel('Réponse B', { exact: true }).fill('3');
  await host.getByLabel('Réponse C', { exact: true }).fill('5');
  await host.getByLabel('Réponse D', { exact: true }).fill('22');
  await host.getByRole('button', { name: /^Sondage$/ }).last().click(); // add a poll question
  await host.getByLabel('Question', { exact: true }).fill('Ton épargne préférée ?');
  await host.getByRole('button', { name: '10 s' }).click();
  await host.getByLabel('Réponse A', { exact: true }).fill('Livret A');
  await host.getByLabel('Réponse B', { exact: true }).fill('PEA');
  await host.getByRole('button', { name: 'Supprimer la réponse D' }).click();
  await host.getByRole('button', { name: 'Supprimer la réponse C' }).click();
  await host.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(host.getByText('enregistré', { exact: false }).first()).toBeVisible();
  await expect(host).toHaveURL(/\/host\/quizzes\/[0-9a-f-]+\/edit/);

  // 2. Start a session.
  await host.getByRole('button', { name: 'Lancer' }).click();
  await expect(host).toHaveURL(/\/host\/session\//);
  const pin = (await host.getByTestId('game-pin').innerText()).replace(/\s/g, '');
  expect(pin).toMatch(/^\d{6}$/);
  const sessionUrl = host.url();
  const sessionId = sessionUrl.split('/').pop()!;

  // Stage display in a second window (same presenter account → host controls visible).
  const stage = await hostCtx.newPage();
  await stage.setViewportSize({ width: 1600, height: 900 });
  await stage.goto(`/stage/${pin}?s=${sessionId}`);
  await expect(stage.getByText('Scanne pour rejoindre')).toBeVisible();

  // 3. Three players join from their phones (QR link → first name only).
  const names = ['Alice', 'Bea', 'Chloe'];
  const phones: { ctx: BrowserContext; page: Page }[] = [];
  for (const name of names) {
    const p = await newPhone(browser);
    await p.page.goto(`/play/${pin}`);
    await expect(p.page.getByRole('heading', { name: 'Rejoindre' })).toBeVisible();
    await p.page.getByLabel('Ton prénom').fill(name);
    await p.page.getByRole('button', { name: 'Continuer' }).click();
    await expect(p.page.getByText('Tu es dans la partie')).toBeVisible();
    phones.push(p);
  }
  // Duplicate nickname is refused.
  const dup = await newPhone(browser);
  await dup.page.goto(`/play/${pin}`);
  await dup.page.getByLabel('Ton prénom').fill('alice');
  await dup.page.getByRole('button', { name: 'Continuer' }).click();
  await expect(dup.page.getByRole('alert')).toContainText('déjà pris');
  await dup.ctx.close();

  await expect(host.getByTestId('lobby-count')).toContainText('3');
  await expect(host.getByTestId('participant-list').getByText('Chloe')).toBeVisible();
  await expect(stage.getByText(/3\s*participantes/)).toBeVisible();
  await phones[0].page.screenshot({ path: `${SHOTS}/phone-lobby.png` });
  await stage.screenshot({ path: `${SHOTS}/stage-lobby.png` });

  // 4. Launch: synchronized countdown, then question 1 everywhere.
  await primary(host, /Lancer le quiz/);
  await expect(stage.getByText('Prête ?')).toBeVisible();
  for (const p of phones) await expect(p.page.getByRole('heading', { name: 'Combien font 2 + 2 ?' })).toBeVisible({ timeout: 10_000 });
  await expect(stage.getByRole('heading', { name: 'Combien font 2 + 2 ?' })).toBeVisible();
  await phones[0].page.screenshot({ path: `${SHOTS}/phone-question.png` });

  // 5. Answers: Alice & Bea correct, Chloe wrong. Live count updates.
  await phones[0].page.getByRole('button', { name: /^A\s*4$/ }).click();
  await expect(phones[0].page.getByText('Réponse envoyée !')).toBeVisible();
  await expect(host.getByTestId('answer-count')).toContainText('1');
  await stage.screenshot({ path: `${SHOTS}/stage-question.png` });

  // Participant refresh mid-question restores "answer submitted".
  await phones[0].page.reload();
  await expect(phones[0].page.getByText('Réponse envoyée !')).toBeVisible();

  // Presenter refresh mid-question restores the exact state.
  await host.reload();
  await expect(host.getByTestId('stage-label')).toHaveText('Question en cours');
  await expect(host.getByTestId('answer-count')).toContainText('1');

  await phones[1].page.getByRole('button', { name: /^A\s*4$/ }).click();
  await phones[2].page.getByRole('button', { name: /^B\s*3$/ }).click();
  // Everyone answered → the question closes automatically.
  await expect(host.getByTestId('stage-label')).toHaveText('Réponses fermées');
  await expect(phones[2].page.getByText('Résultats dans un instant')).toBeVisible();

  // 6. Reveal (manual).
  await primary(host, /Révéler les résultats/);
  await expect(phones[0].page.getByText('Bonne réponse !')).toBeVisible();
  await expect(phones[2].page.getByText('Pas cette fois')).toBeVisible();
  await expect(phones[2].page.getByText('La bonne réponse')).toBeVisible();
  await expect(stage.getByText('67%').first()).toBeVisible();
  await expect(stage.getByText('de bonnes réponses', { exact: true })).toBeVisible();
  const pts = await phones[0].page.getByText(/^\+\d+ pts$/).innerText();
  const points = Number(pts.replace(/\D/g, ''));
  expect(points).toBeGreaterThanOrEqual(500);
  expect(points).toBeLessThanOrEqual(1000);
  await phones[0].page.screenshot({ path: `${SHOTS}/phone-correct.png` });
  await stage.screenshot({ path: `${SHOTS}/stage-reveal.png` });

  // 7. Leaderboard.
  await primary(host, /Voir le classement/);
  await expect(stage.getByRole('heading', { name: 'Classement' })).toBeVisible();
  await expect(phones[2].page.getByText('3e')).toBeVisible();
  await stage.waitForTimeout(1200);
  await stage.screenshot({ path: `${SHOTS}/stage-leaderboard.png` });

  // 8. Next question (poll). Use the stage keyboard shortcut (Space) this time.
  await stage.bringToFront();
  await stage.keyboard.press('Space');
  for (const p of phones) await expect(p.page.getByRole('heading', { name: 'Ton épargne préférée ?' })).toBeVisible();
  await phones[0].page.getByRole('button', { name: /Livret A/ }).click();
  await phones[1].page.getByRole('button', { name: /PEA/ }).click();
  // Chloe goes offline (closes her tab) and does not answer → the timer closes the question.
  await phones[2].page.close();
  await expect(host.getByTestId('stage-label')).toHaveText('Réponses fermées', { timeout: 20_000 });
  // Chloe comes back: same identity, same score, right screen.
  phones[2].page = await phones[2].ctx.newPage();
  await phones[2].page.goto(`/play/${pin}`);
  await expect(phones[2].page.getByText('Temps écoulé')).toBeVisible();

  await primary(host, /Révéler les résultats/);
  await expect(stage.getByText('50%').first()).toBeVisible();
  await expect(phones[2].page.getByText('Tu n’as pas répondu')).toBeVisible();
  await stage.screenshot({ path: `${SHOTS}/stage-poll-reveal.png` });

  // 9. Final results → podium on stage, personal results on phones.
  await primary(host, /Résultats finaux/);
  await expect(stage.getByText('gagnantes')).toBeVisible();
  await expect(phones[0].page.getByText('Résultat final')).toBeVisible();
  await stage.waitForTimeout(2500);
  await stage.screenshot({ path: `${SHOTS}/stage-podium.png` });
  await phones[0].page.screenshot({ path: `${SHOTS}/phone-final.png` });
  await primary(host, /Classement complet/);
  await expect(stage.getByRole('heading', { name: 'Classement final' })).toBeVisible();
  await primary(host, /Voir le récap/);
  await expect(stage.getByText('récap')).toBeVisible();
  await stage.screenshot({ path: `${SHOTS}/stage-recap.png` });

  // 10. Results page + CSV export.
  await host.getByRole('link', { name: /Résultats détaillés/ }).click();
  await expect(host.getByRole('heading', { name: 'E2E Quiz' })).toBeVisible();
  const [download] = await Promise.all([host.waitForEvent('download'), host.getByTestId('export-csv').click()]);
  const csvPath = await download.path();
  const csv = readFileSync(csvPath!, 'utf8');
  expect(csv).toContain('CLASSEMENT');
  expect(csv).toContain('Alice');
  expect(csv).toContain('Combien font 2 + 2 ?');

  for (const p of phones) await p.ctx.close();
  await hostCtx.close();
});
