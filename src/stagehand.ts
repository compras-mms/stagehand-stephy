import { Stagehand, AISdkClient } from "@browserbasehq/stagehand";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import dotenv from "dotenv";

// Stagehand does NOT auto-load .env — we do it here, once, for every script.
dotenv.config();

const DEFAULT_MODEL = "google/gemini-3.5-flash";

// Windows default Chrome location. Override with CHROME_PATH if yours differs,
// e.g. "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
// or a Chromium/Brave/Edge binary.
const DEFAULT_CHROME =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/** Where the browser runs: your own Chrome, or a Browserbase cloud session. */
export type StagehandEnv = "LOCAL" | "BROWSERBASE";

/**
 * Resolve which environment to use. Precedence:
 *   explicit argument → STAGEHAND_ENV env var → "LOCAL".
 */
export function resolveStagehandEnv(explicit?: StagehandEnv): StagehandEnv {
  if (explicit) return explicit;
  const fromEnv = process.env.STAGEHAND_ENV?.trim().toUpperCase();
  return fromEnv === "BROWSERBASE" ? "BROWSERBASE" : "LOCAL";
}

export interface MakeStagehandOptions {
  /**
   * Where the browser runs. Defaults to STAGEHAND_ENV (else "LOCAL").
   *   - "LOCAL"       → your installed Google Chrome on this machine.
   *   - "BROWSERBASE" → a cloud browser session on Browserbase.
   */
  env?: StagehandEnv;
  /** Show the browser window (LOCAL only). Default visible so you can watch the flow. */
  headless?: boolean;
  /** Throw early if no OpenRouter key is set. Default true. */
  requireKey?: boolean;
}

/**
 * Build a Stagehand instance wired to OpenRouter (via the Vercel AI SDK client)
 * and to either a LOCAL Chrome browser or a BROWSERBASE cloud session.
 *
 * Swap the model by setting OPENROUTER_MODEL in .env to any OpenRouter model id
 * (e.g. google/gemini-3.5-flash, openai/gpt-4o, anthropic/claude-3.5-haiku).
 * Swap the browser with STAGEHAND_ENV=LOCAL|BROWSERBASE (or the `env` option).
 */
export function makeStagehand(opts: MakeStagehandOptions = {}): Stagehand {
  const { requireKey = true } = opts;
  const env = resolveStagehandEnv(opts.env);
  // Visible by default so you can watch the flow; set HEADLESS=1 to hide it.
  const headless = opts.headless ?? process.env.HEADLESS === "1";

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (requireKey && !apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set.\n" +
        "  1. Copy .env.example to .env\n" +
        "  2. Add your key from https://openrouter.ai/keys",
    );
  }

  const modelId = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const openrouter = createOpenRouter({ apiKey: apiKey ?? "missing-key" });
  // Route every Stagehand LLM call (act / extract / observe / agent) through OpenRouter.
  const llmClient = new AISdkClient({ model: openrouter.chat(modelId) });

  if (env === "BROWSERBASE") {
    const bbApiKey = process.env.BROWSERBASE_API_KEY;
    const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!bbApiKey || !bbProjectId) {
      throw new Error(
        "Running on Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.\n" +
          "  1. Get them at https://www.browserbase.com/ (Settings → API keys / Project ID)\n" +
          "  2. Add them to .env\n" +
          "  Or set STAGEHAND_ENV=LOCAL to use your local Chrome instead.",
      );
    }

    return new Stagehand({
      env: "BROWSERBASE",
      apiKey: bbApiKey,
      projectId: bbProjectId,
      llmClient,
      browserbaseSessionCreateParams: {
        projectId: bbProjectId,
        browserSettings: { viewport: { width: 1280, height: 800 } },
      },
      verbose: 1,
    });
  }

  // Optional persistent profile — keep a DEDICATED folder for stephy so it does
  // not collide with the amazon session.
  const userDataDir = process.env.CHROME_USER_DATA_DIR?.trim();

  return new Stagehand({
    env: "LOCAL",
    llmClient,
    localBrowserLaunchOptions: {
      headless,
      executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
      viewport: { width: 1280, height: 800 },
      ...(userDataDir ? { userDataDir } : {}),
    },
    verbose: 1,
  });
}
