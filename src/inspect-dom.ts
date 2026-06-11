import { makeStagehand, resolveStagehandEnv } from "./stagehand.js";

/**
 * Diagnostic helper: walks the working part of the flow (company search → card →
 * role = Agente) and then DUMPS the real DOM of the resulting "Agente" login
 * page, so we can pick exact selectors for the user/password fields and the
 * ENTRAR button (which is where the login flow currently fails).
 *
 *   pnpm inspect
 */

const STEPHY_URL = process.env.STEPHY_URL ?? "https://app.stephytracking.com/";
const COMPANY = process.env.STEPHY_COMPANY ?? "tecnoship";
const ROLE = process.env.STEPHY_ROLE ?? "Agente";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DUMP_EXPR = `(() => {
  const vis = (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    id: el.id || null,
    name: el.getAttribute('name'),
    formcontrolname: el.getAttribute('formcontrolname'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
    value: el.value ?? null,
    text: (el.innerText || el.textContent || '').trim().slice(0, 40),
    visible: vis(el),
  });
  const inputs = Array.from(document.querySelectorAll('input')).map(desc);
  const buttons = Array.from(document.querySelectorAll('button, [role=button], input[type=submit]')).map(desc);
  const selects = Array.from(document.querySelectorAll('mat-select, select, [role=combobox], [role=listbox]')).map(desc);
  return JSON.stringify({ url: location.href, inputs, buttons, selects }, null, 2);
})()`;

async function main() {
  const env = resolveStagehandEnv();
  const stagehand = makeStagehand({ env, headless: false });
  await stagehand.init();
  const page =
    stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

  // 1. Landing → search company
  console.log(`→ Abriendo ${STEPHY_URL} …`);
  await page.goto(STEPHY_URL);
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(1500);
  const box = page.locator('input[placeholder*="Search" i]').first();
  await box.click().catch(() => {});
  await box.fill(COMPANY);
  await page.keyPress("Enter");
  await sleep(2000);

  // 2. Click the company card (agent — proven reliable)
  console.log(`→ Seleccionando compañía "${COMPANY}" (agente)…`);
  await stagehand.act(`click the "${COMPANY}" company result card`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(2500);

  console.log(`   URL en login inicial: ${page.url()}`);
  console.log("\n===== DOM: login inicial (rol Consignatario) =====");
  console.log(await page.evaluate(DUMP_EXPR));

  // 3. Change role to Agente (agent)
  console.log(`\n→ Cambiando rol a "${ROLE}" (agente)…`);
  await stagehand.act('click the role dropdown that currently shows "Consignatario"');
  await sleep(1000);
  await stagehand.act(`select the "${ROLE}" option in the role dialog`);
  await sleep(500);
  await stagehand.act("click the OK button in the dialog");
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(1500);

  console.log(`   URL en login de Agente: ${page.url()}`);
  console.log("\n===== DOM: login de AGENTE (donde falla el llenado) =====");
  console.log(await page.evaluate(DUMP_EXPR));

  await stagehand.close();
  console.log("\n✓ Inspección completa.");
}

main().catch((err) => {
  console.error("Inspect failed:\n", err);
  process.exit(1);
});
