import { makeStagehand } from "./stagehand.js";

/**
 * No-LLM smoke test. Verifies the LOCAL Chrome + Stagehand wiring works
 * WITHOUT spending any OpenRouter credits — it only launches the browser,
 * navigates, and reads the page title via plain CDP (no act/extract/observe).
 *
 * Run this first to confirm your setup before adding an API key:
 *   pnpm smoke
 */
async function main() {
  // requireKey: false — this test never calls the LLM, so no key is needed.
  const stagehand = makeStagehand({ requireKey: false });

  await stagehand.init();
  console.log("✓ Chrome launched and Stagehand connected.");

  try {
    const page =
      stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

    await page.goto("https://example.com");
    const title = await page.title();

    console.log(`✓ Navigated to ${page.url()}`);
    console.log(`✓ Page title: "${title}"`);
    console.log("\nLocal browser stack is working. Add an OpenRouter key and run `pnpm login`.");
  } finally {
    await stagehand.close();
  }
}

main().catch((err) => {
  console.error("Smoke test failed:\n", err);
  process.exit(1);
});
