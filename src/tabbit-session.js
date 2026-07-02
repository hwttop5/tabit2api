import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import {
  CHATGPTBOX_PANEL_URL,
  MAXAI_POPUP_URL,
  OUTPUT_DIR,
  TABBIT_EXECUTABLE,
} from "./config.js";

function isVisibleElement(element) {
  const style = globalThis.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export async function launchTabbitSession(profileDir, options = {}) {
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: TABBIT_EXECUTABLE,
    headless: options.headless ?? false,
    viewport: null,
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
    args: [
      "--no-first-run",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  return context;
}

export async function openPage(context, targetUrl) {
  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

export async function inspectInteractiveElements(page) {
  return page.evaluate(() => {
    const selectors = [
      "textarea",
      "input",
      "[contenteditable='true']",
      "button",
      "[role='button']",
      "a",
    ];

    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter((element) => isVisibleElement(element))
        .slice(0, 30)
        .map((element, index) => ({
          selector,
          index,
          tagName: element.tagName,
          type: element.getAttribute("type"),
          role: element.getAttribute("role"),
          id: element.id,
          name: element.getAttribute("name"),
          placeholder: element.getAttribute("placeholder"),
          ariaLabel: element.getAttribute("aria-label"),
          text: (element.textContent || "").trim().slice(0, 160),
        })),
    );
  });
}

export async function saveProbeArtifacts(page, stem) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const screenshotPath = path.join(OUTPUT_DIR, `${stem}.png`);
  const htmlPath = path.join(OUTPUT_DIR, `${stem}.html`);
  const jsonPath = path.join(OUTPUT_DIR, `${stem}.json`);

  const summary = {
    url: page.url(),
    title: await page.title(),
    interactiveElements: await inspectInteractiveElements(page),
  };

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  return {
    htmlPath,
    jsonPath,
    screenshotPath,
    summary,
  };
}

export async function probeExtensionPages(context) {
  const targets = [
    { name: "maxai-popup", url: MAXAI_POPUP_URL },
    { name: "chatgptbox-panel", url: CHATGPTBOX_PANEL_URL },
  ];

  const results = [];
  for (const target of targets) {
    const page = await context.newPage();
    try {
      await page.goto(target.url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(4_000);
      results.push({
        name: target.name,
        ok: true,
        ...(await saveProbeArtifacts(page, target.name)),
      });
    } catch (error) {
      results.push({
        name: target.name,
        ok: false,
        url: target.url,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await page.close();
    }
  }

  return results;
}
