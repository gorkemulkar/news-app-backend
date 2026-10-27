import { chromium } from "playwright-core";

const [url, mode, shotDir] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const snapshot = () =>
  page.evaluate(() => ({
    groups: [...document.querySelectorAll(".topic-group")].map((s) => ({
      heading: s.querySelector("h2").firstChild.textContent,
      cards: s.querySelectorAll(".card").length,
    })),
    cards: document.querySelectorAll(".card").length,
    newCards: document.querySelectorAll(".card.is-new").length,
    reasons: document.querySelectorAll(".card .reason").length,
    rubricItems: document.querySelectorAll("#rubric-list li").length,
    scores: [...document.querySelectorAll(".card .score")].map((b) => Number(b.textContent.split("/")[0])),
    count: document.getElementById("result-count").textContent,
    lastRefreshed: document.getElementById("last-refreshed").textContent,
  }));
const settle = () => page.waitForFunction(() => document.getElementById("groups").getAttribute("aria-busy") === "false");

await page.goto(url);
await page.waitForSelector(".card", { timeout: 30000 });
const out = { initial: await snapshot() };
out.firstCard = await page.evaluate(() => {
  const c = document.querySelector(".card");
  const b = c.querySelector(".score");
  return {
    headline: c.querySelector(".headline a").textContent.slice(0, 80),
    href: c.querySelector(".headline a").href.slice(0, 60),
    target: c.querySelector(".headline a").target,
    source: c.querySelector(".source").textContent,
    date: c.querySelector(".date").textContent,
    badge: b.textContent,
    badgeClass: b.className,
    badgeColor: getComputedStyle(b).backgroundColor,
    summaryChars: c.querySelector(".summary").textContent.length,
  };
});
out.topicOptions = await page.$$eval("#topic option", (o) => o.map((x) => x.textContent));
if (shotDir) await page.screenshot({ path: `${shotDir}/${mode}-initial.png`, fullPage: false });

await page.selectOption("#topic", "edge-hardware");
await settle();
out.topicFilter = await snapshot();

await page.selectOption("#topic", "");
await page.selectOption("#min-score", "9");
await settle();
out.minScore9 = await snapshot();

await page.selectOption("#min-score", "");
await page.selectOption("#limit", "10");
await settle();
out.limit10 = await snapshot();

await page.selectOption("#limit", "50");
await settle();

if (mode === "refresh") {
  const before = await snapshot();
  await page.click("#refresh");
  await page.waitForTimeout(500);
  out.duringRefresh = await page.evaluate(() => ({
    disabled: document.getElementById("refresh").disabled,
    label: document.querySelector("#refresh .btn-label").textContent,
    spinnerVisible: getComputedStyle(document.querySelector(".spinner")).display !== "none",
    status: document.getElementById("status").textContent,
  }));
  await page.waitForFunction(() => !document.getElementById("refresh").disabled, null, { timeout: 240000 });
  await settle();
  out.afterRefresh = {
    status: await page.textContent("#status"),
    before: { cards: before.cards, lastRefreshed: before.lastRefreshed },
    after: await snapshot(),
  };
  if (shotDir) await page.screenshot({ path: `${shotDir}/${mode}-after-refresh.png`, fullPage: false });
}

out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
