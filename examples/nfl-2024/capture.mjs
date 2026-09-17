// SPDX-License-Identifier: MIT

// Records the nfl-2024 walkthrough as a 60–90 s video: CSV in (the package
// page listing the three files), the model (pick `team_games`, run the
// `standings` view), the dashboard, then a Team filter that re-runs every
// tile. Playwright drives a headless Chromium and records it, the same way
// scripts/capture-recordings.mjs does for the docs.
//
// Needs a Publisher server serving the `examples` environment and, for the
// mp4/gif, ffmpeg on PATH (the raw .webm is written either way).
//
//   node examples/nfl-2024/capture.mjs                                   # server on :4000
//   PUBLISHER_BASE=http://127.0.0.1:4100 node examples/nfl-2024/capture.mjs
//   CAPTURE_TEAM="Detroit Lions" node examples/nfl-2024/capture.mjs
//
// Output: examples/nfl-2024/capture/nfl-2024-walkthrough.{webm,mp4,gif}
// (git-ignored). The run log prints a timestamp per scene so the pacing can
// be tuned by editing the `sleep`s below.
import { chromium } from "playwright";
import { mkdir, mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const BASE = process.env.PUBLISHER_BASE || "http://127.0.0.1:4000";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "capture");
const TEAM = process.env.CAPTURE_TEAM || "Philadelphia Eagles";
const VIEWPORT = { width: 1440, height: 900 };
const PKG = `${BASE}/examples/nfl-2024`;

const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scene = (name) =>
  console.log(`${String(((Date.now() - started) / 1000).toFixed(1)).padStart(5)}s  ${name}`);

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

// The Console's page body never scrolls; its main pane does, and so does any
// tall table inside it. Scroll the tallest scrollable pane directly, in steps,
// so the recording reads as someone moving down the page and a wheel event
// over a table cannot scroll the table instead.
async function glide(page, px, { steps = 16, pause = 70 } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dy) => {
      const panes = [...document.querySelectorAll("div")].filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === "auto" || s.overflowY === "scroll") && el.clientHeight > 300 && el.scrollHeight > el.clientHeight;
      });
      const pane = panes.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? document.scrollingElement;
      pane.scrollBy(0, dy);
    }, px / steps);
    await sleep(pause);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const videoDir = await mkdtemp(join(tmpdir(), "nfl-capture-"));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: videoDir, size: VIEWPORT } });
  const page = await context.newPage();

  // 1. CSV in: the package page lists the three data files with row counts.
  scene("package page");
  await page.goto(PKG, { waitUntil: "networkidle" });
  await page.getByText("data/team_week_2024.csv").first().waitFor({ timeout: 30_000 });
  await sleep(3500);
  await page.mouse.move(1000, 500);
  await glide(page, 500, { steps: 12 });
  await sleep(3500);

  // 2. The model: switch the explorer to `team_games`, open its views, add
  //    `standings` to the query and run it.
  scene("model page");
  await page.goto(`${PKG}/nfl.malloy`, { waitUntil: "networkidle" });
  const picker = page.getByRole("combobox").first();
  await picker.waitFor({ timeout: 30_000 });
  await sleep(2500);
  await picker.click();
  await sleep(800);
  await page.getByRole("option", { name: "team_games" }).click();
  await page.getByText("Views", { exact: true }).first().waitFor({ timeout: 30_000 });
  await sleep(2500);
  await page.getByText("Views", { exact: true }).first().click();
  await sleep(2000);
  scene("run standings");
  await page.getByRole("button", { name: "Add" }).first().click(); // the first bookmarked view is `standings`
  await sleep(1500);
  await page.getByRole("button", { name: /^run$/i }).click();
  await page.getByText("Philadelphia Eagles").first().waitFor({ timeout: 60_000 });
  await sleep(7000);

  // 3. Dashboards out: wait for the standings tile, then walk the page.
  scene("dashboard");
  await page.goto(`${PKG}/dashboards/season`, { waitUntil: "networkidle" });
  await page.getByText("Philadelphia Eagles").first().waitFor({ timeout: 60_000 });
  await sleep(5000);
  await page.mouse.move(1425, 500);
  await glide(page, 850, { steps: 18, pause: 90 });
  await sleep(2500);
  await glide(page, 850, { steps: 18, pause: 90 });
  await sleep(3000);
  await glide(page, -1700, { steps: 14, pause: 50 });
  await sleep(1500);

  // 4. Filter to one team and let every tile re-run.
  scene(`filter: ${TEAM}`);
  const team = page.getByRole("combobox", { name: "Team" }).first();
  await team.click();
  await sleep(700);
  await team.pressSequentially(TEAM.split(" ")[0], { delay: 110 });
  await sleep(1200);
  await page.getByRole("option", { name: TEAM }).first().click();
  await sleep(6000);
  await page.mouse.move(1425, 500);
  await glide(page, 850, { steps: 18, pause: 90 });
  await sleep(3000);
  await glide(page, 850, { steps: 18, pause: 90 });
  await sleep(6000);
  scene("done");

  await context.close();
  await browser.close();

  const [webm] = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no video recorded");
  const src = join(videoDir, webm);
  await copyFile(src, join(OUT, "nfl-2024-walkthrough.webm"));
  try {
    await ffmpeg(["-i", src, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", join(OUT, "nfl-2024-walkthrough.mp4")]);
    await ffmpeg(["-i", src, "-vf", "fps=6,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer", "-loop", "0", join(OUT, "nfl-2024-walkthrough.gif")]);
  } catch (e) {
    console.warn(`ffmpeg conversion skipped: ${e.message} (the .webm is still in ${OUT})`);
  }
  await rm(videoDir, { recursive: true, force: true });
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
