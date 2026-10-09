// The RUNTIME that write-build-html emits into video-auto.html, run in headless Chromium.
//
// The runtime is JavaScript inside a JavaScript template literal, so its source is not
// the code that ships: the literal consumes one level of backslashes. That is how the
// legibility check's colour regex shipped as /rgba?(([^)]+))/. It read every red channel
// as NaN, so the contrast check could never fire, while the source looked correct to
// anyone reading it. Every test here therefore builds a real scene with the CLI and
// asserts on what the EMITTED page does. None of them reads the source.
//
// Frames are driven the way frame-capture drives them, with fireTriggersUpTo(t) and then
// __frameSig. The capture's CSS-animation scan is mirrored too, so the dedup motion guard
// sees exactly what it sees in a real capture.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, test, before, after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXIT } from "../src/cli-support.mjs";
import {
    makeProject,
    runScript,
    footageProject,
    FOOTAGE_FRAME_COUNT,
} from "./_helpers.mjs";

const fixturesDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
);
const INERT_GSAP = fs.readFileSync(
    path.join(fixturesDir, "gsap-stub.js"),
    "utf8",
);
const TIMED_GSAP = fs.readFileSync(
    path.join(fixturesDir, "gsap-timed-stub.js"),
    "utf8",
);
const RENDER_GSAP = fs.readFileSync(
    path.join(fixturesDir, "gsap-render-stub.js"),
    "utf8",
);
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

/** Builds video-auto.html for `segments` with the real CLI and returns its path. */
function buildScene(t, segments, { project = {}, gsap = INERT_GSAP } = {}) {
    const endMs = segments.at(-1).endMs;
    const dir = makeProject(t, {
        "node_modules/gsap/dist/gsap.min.js": gsap,
        "timing.json": JSON.stringify({
            project: {
                name: "demo",
                fps: FPS,
                width: WIDTH,
                height: HEIGHT,
                noGoPatterns: [],
                ...project,
            },
            durationMs: endMs,
            contentMs: endMs,
            outroMs: 0,
            endCard: { enabled: true },
            segments,
        }),
    });
    fs.mkdirSync(path.join(dir, "evidence-pack"));
    const r = runScript("write-build-html.mjs", ["--apply"], dir);
    assert.equal(
        r.code,
        EXIT.OK,
        `the scene must build before its runtime can be tested\n${r.all}`,
    );
    return path.join(dir, "video-auto.html");
}

/** A narrative segment: kicker, title, subtitle, and any `extra` visual fields (cards). */
function narrative(id, startMs, endMs, extra = {}) {
    return {
        id,
        startMs,
        endMs,
        voiceoverText: "words",
        visual: {
            mode: "narrative",
            title: `${id} title`,
            subtitle: `${id} subtitle`,
            ...extra,
        },
    };
}

let browser;
before(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
});
after(async () => {
    await browser?.close();
});

/**
 * Opens a built scene the way frame-capture's makePage does: a viewport the size of the
 * stage, fitLayout, then the CSS-animation scan the motion guard reads (PAGE_INIT). A page
 * error fails the test at the next step. A scene that throws is not the scene under test.
 */
async function openScene(t, htmlPath) {
    const page = await browser.newPage({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
    });
    t.after(() => page.close());
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.evaluate(() => {
        window.fitLayout();
        // frame-capture.mjs PAGE_INIT: the set of elements that carry a CSS animation.
        const set = new Set();
        const scan = () =>
            document.querySelectorAll("*").forEach((el) => {
                const st = getComputedStyle(el);
                if (st.animationName && st.animationName !== "none")
                    set.add(el);
            });
        window.__sizzleAnim = { scan, els: () => Array.from(set) };
        scan();
    });
    const noErrors = () => assert.deepEqual(errors, [], "the scene threw");
    return {
        page,
        /** Seeks to `seconds` exactly as a captured frame does and returns that frame's signature. */
        async frameAt(seconds) {
            const sig = await page.evaluate(
                ([s, frameNo]) => {
                    window.fireTriggersUpTo(s);
                    window.__sizzleAnim.scan();
                    return window.__frameSig(frameNo);
                },
                [seconds, Math.round(seconds * FPS)],
            );
            noErrors();
            return sig;
        },
        async eval(fn, arg) {
            const value = await page.evaluate(fn, arg);
            noErrors();
            return value;
        },
    };
}

/** The frame footageProject's clip shows at `atMs`, by the runtime's own index rule. */
const footageFrameAt = (atMs) =>
    `frame_${String(Math.max(1, Math.min(FOOTAGE_FRAME_COUNT, Math.round((atMs / 1000) * FPS) + 1))).padStart(5, "0")}.jpg`;

/**
 * Asserts that the footage frame for `atMs` is on screen.
 *
 * `__setFootageFrame` resolves an EMPTY list when the frame it would load is already the
 * one showing (`if(el.dataset.cur===url)return`), and fireTriggersUpTo starts that same
 * load without awaiting it. So asking again returns [true] while the load is pending and
 * [] once it has finished: asserting [true] raced the image decoder and failed about one
 * run in three. probeFootageFrames in _helpers.mjs judges it the same way. Every load that
 * was started must succeed, AND the layer must end up showing the expected frame, so an
 * empty list passes only when that frame is already on screen.
 */
async function assertFootageFrameOnScreen(scene, atMs, message) {
    const { outcomes, cur } = await scene.eval(async (ms) => {
        const outcomes = await window.__setFootageFrame(ms);
        return {
            outcomes,
            cur:
                document.querySelector(".sl.on .footage-layer")?.dataset.cur ??
                null,
        };
    }, atMs);
    assert.ok(
        outcomes.every((ok) => ok === true),
        `${message}: a frame load failed — outcomes ${JSON.stringify(outcomes)}`,
    );
    assert.equal(
        cur === null ? null : cur.split("/").pop(),
        footageFrameAt(atMs),
        `${message}: the footage layer shows ${JSON.stringify(cur)}`,
    );
}

const lowContrast = (issues) =>
    issues.filter((i) => i.reason === "low-contrast");

/**
 * The rendered ground truth for the legibility audit: the worst WCAG ratio between each
 * element's text colour and the pixels actually under its box, with all slide text hidden,
 * over `frames` + 1 evenly spaced points of the stage's background animation. Pixels are
 * decoded through a canvas, so no image library is needed.
 */
async function renderedWorstRatios(scene, selectors, frames) {
    const { page } = scene;
    const boxes = await page.evaluate(
        (sels) =>
            sels.map((sel) => {
                const el = document.querySelector(sel);
                const r = el.getBoundingClientRect();
                return {
                    rect: [r.left, r.top, r.right, r.bottom].map(Math.round),
                    fg: getComputedStyle(el)
                        .color.match(/[\d.]+/g)
                        .slice(0, 3)
                        .map(Number),
                };
            }),
        selectors,
    );
    await page.addStyleTag({
        content:
            ".sl.on *{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important}",
    });
    const duration = await page.evaluate(() => {
        const anims = document.getElementById("stage").getAnimations();
        anims.forEach((a) => a.pause());
        return anims.length ? anims[0].effect.getTiming().duration : 0;
    });
    const worst = boxes.map(() => Infinity);
    for (let k = 0; k <= frames; k++) {
        await page.evaluate(
            (ms) =>
                document
                    .getElementById("stage")
                    .getAnimations()
                    .forEach((a) => {
                        a.currentTime = ms;
                    }),
            (duration * k) / frames,
        );
        const png = (await page.screenshot({ type: "png" })).toString("base64");
        const ratios = await page.evaluate(
            async ([data, bs]) => {
                const img = new Image();
                img.src = `data:image/png;base64,${data}`;
                await img.decode();
                const canvas = document.createElement("canvas");
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0);
                const lin = (v) =>
                    (v /= 255) <= 0.03928
                        ? v / 12.92
                        : ((v + 0.055) / 1.055) ** 2.4;
                const lum = (r, g, b) =>
                    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
                return bs.map(({ rect: [l, t, r, b], fg }) => {
                    const px = ctx.getImageData(
                        l + 2,
                        t + 2,
                        r - l - 4,
                        b - t - 4,
                    ).data;
                    const L1 = lum(...fg);
                    let w = Infinity;
                    for (let i = 0; i < px.length; i += 4) {
                        const L2 = lum(px[i], px[i + 1], px[i + 2]);
                        w = Math.min(
                            w,
                            (Math.max(L1, L2) + 0.05) /
                                (Math.min(L1, L2) + 0.05),
                        );
                    }
                    return w;
                });
            },
            [png, boxes],
        );
        ratios.forEach((w, i) => {
            worst[i] = Math.min(worst[i], w);
        });
    }
    return worst;
}

// ---------------------------------------------------------------------------
// C-14. The legibility audit: WCAG AA, 4.5:1 for text and 3:1 for large text.
//
// A check that cannot fire looks exactly like a check that passed, so every "is not
// flagged" assertion below is preceded, on the same page, by a pair that must be.
// ---------------------------------------------------------------------------
describe("legibility audit (C-14)", () => {
    test("_rgb_computedColourStrings_parsesEveryChannel", async (t) => {
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000)]),
        );

        const parsed = await scene.eval(() => [
            _rgb("rgb(255, 255, 255)"),
            _rgb("rgba(12, 34, 56, 0.5)"),
            _rgb("rgba(0, 0, 0, 0)"),
        ]);

        assert.deepEqual(parsed, [[255, 255, 255], [12, 34, 56], null]);
    });

    test("auditLegibility_nearBlackTitleOnBlackStage_flagsLowContrast", async (t) => {
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000)]),
        );
        await scene.frameAt(1.5);
        await scene.page.addStyleTag({
            content:
                "#stage{background:#000 !important}#intro-title{color:#1a1a1a !important}",
        });

        const issues = await scene.eval(() => window.auditLegibility());

        const title = lowContrast(issues).find((i) => i.id === "intro-title");
        assert.ok(
            title,
            `near-black text on a black stage must be flagged; got ${JSON.stringify(issues)}`,
        );
        assert.equal(title.need, 3, "a 44px title is large text, held to 3:1");
        assert.ok(
            title.ratio < 1.5,
            `and the ratio reported must be the real one (about 1.2:1), got ${title.ratio}`,
        );
    });

    test("auditLegibility_pairBetween3And4point5To1_flagsBodyTextButNotALargeTitle", async (t) => {
        const scene = await openScene(
            t,
            buildScene(
                t,
                [
                    narrative("intro", 0, 4000, {
                        items: [{ label: "Point", text: "Body copy" }],
                    }),
                ],
                {
                    project: { background: "white" },
                },
            ),
        );
        await scene.frameAt(1.5);
        // #8a8a8a is 3.2 to 3.5:1 across this stage's #FFFFFF to #F5F8FC gradient: enough for large
        // text, not enough for body text, wherever on the stage either one sits.
        await scene.page.addStyleTag({
            content:
                "#intro-title,#intro-item-0 .body{color:#8a8a8a !important}",
        });

        const issues = lowContrast(
            await scene.eval(() => window.auditLegibility()),
        );

        const body = issues.find((i) => i.id === "body");
        assert.ok(
            body,
            `18px body text at 3:1 must be flagged; got ${JSON.stringify(issues)}`,
        );
        assert.equal(body.need, 4.5);
        assert.equal(
            issues.some((i) => i.id === "intro-title"),
            false,
            "a 44px title at 3:1 meets AA for large text",
        );
    });

    test("auditLegibility_ratioJustUnderTheThreshold_reportsARatioBelowTheNeed", async (t) => {
        // #777777 on white is 4.48:1. Rounded to the nearest tenth that is 4.5, the ratio the advisory
        // says the text needs, so the advisory reads as a pass. A ratio is reported rounded down.
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000)], {
                project: { background: "white" },
            }),
        );
        await scene.frameAt(1.5);
        await scene.page.addStyleTag({
            content:
                "#stage{background:#fff !important}#intro-label{color:#777 !important}",
        });

        const label = lowContrast(
            await scene.eval(() => window.auditLegibility()),
        ).find((i) => i.id === "intro-label");

        assert.deepEqual(label, {
            id: "intro-label",
            reason: "low-contrast",
            ratio: 4.4,
            need: 4.5,
        });
    });

    // The stock kicker is #0078D4. Against the #FFFFFF this audit used to assume it is 4.5:1 and
    // passed; against the gradient actually painted where it sits it is about 4.4:1, under AA.
    // Dark title and subtitle text must still pass: compositing over the black letterbox behind
    // the stage instead of over the stage would flag them too.
    for (const [name, project] of [
        ["WhiteBackground", { background: "white" }],
        ["LightTheme", { theme: "light" }],
    ]) {
        test(`auditLegibility_${name}Defaults_measuresTheStageGradientNotTheLetterbox`, async (t) => {
            const scene = await openScene(
                t,
                buildScene(t, [narrative("intro", 0, 4000)], { project }),
            );
            await scene.frameAt(1.5);

            const probe = await scene.page.addStyleTag({
                content: "#intro-title{color:#f4f4f4 !important}",
            });
            const live = lowContrast(
                await scene.eval(() => window.auditLegibility()),
            );
            assert.ok(
                live.some((i) => i.id === "intro-title"),
                `near-white on the white stage must be flagged, or the check is dead; got ${JSON.stringify(live)}`,
            );
            await probe.evaluate((n) => n.remove());

            const stock = lowContrast(
                await scene.eval(() => window.auditLegibility()),
            );
            assert.deepEqual(
                stock.map((i) => i.id),
                ["intro-label"],
                `only the accent kicker falls under AA on this stage; got ${JSON.stringify(stock)}`,
            );
            assert.ok(
                stock[0].ratio >= 4.2 && stock[0].ratio < 4.5,
                `measured on the gradient, not on #FFFFFF; got ${stock[0].ratio}`,
            );
        });
    }

    test("auditLegibility_translucentCardOnMidnight_compositesTheCardOverTheStageColour", async (t) => {
        const items = [
            { label: "Point", text: "Body copy" },
            { label: "Another", text: "More copy" },
        ];
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000, { items })]),
        );
        await scene.frameAt(1.5);

        const probe = await scene.page.addStyleTag({
            content: "#intro-item-0 .body{color:#1d2433 !important}",
        });
        const live = lowContrast(
            await scene.eval(() => window.auditLegibility()),
        );
        assert.ok(
            live.some((i) => i.id === "body"),
            `navy text on a navy card must be flagged, or the check is dead; got ${JSON.stringify(live)}`,
        );
        await probe.evaluate((n) => n.remove());

        const stock = lowContrast(
            await scene.eval(() => window.auditLegibility()),
        );
        assert.deepEqual(
            stock,
            [],
            "a card that is 4% white over navy is navy, not white",
        );
    });

    // Every theme paints the stage with gradients and no background colour. The audit used to
    // substitute --color-bg-primary for them, so it certified ratios against a colour that
    // was not behind the text. These pin that it measures the gradient that is.
    test("auditLegibility_azureTheme_flagsAccentAndSecondaryTextOverTheGradient", async (t) => {
        // Azure declares no --color-bg-primary, so the audit measured the default navy. The
        // gradient it animates across the stage reaches #0078D4, and any stop can pass behind
        // the text. The #50E6FF kicker is 3.0:1 against it and the #8aa4c8 subtitle 1.8:1.
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000)], {
                project: { theme: "azure" },
            }),
        );
        await scene.frameAt(1.5);

        const issues = lowContrast(
            await scene.eval(() => window.auditLegibility()),
        );

        const kicker = issues.find((i) => i.id === "intro-label");
        assert.ok(
            kicker,
            `the accent kicker over the azure gradient must be flagged; got ${JSON.stringify(issues)}`,
        );
        assert.ok(
            kicker.ratio >= 2.9 && kicker.ratio <= 3.1,
            `against the brightest stop the kicker is 3.0:1; got ${kicker.ratio}`,
        );
        const subtitle = issues.find((i) => i.id === "intro-subtitle");
        assert.ok(
            subtitle,
            `the secondary-text subtitle must be flagged; got ${JSON.stringify(issues)}`,
        );
        assert.ok(
            subtitle.ratio < 2,
            `against the brightest stop the subtitle is 1.8:1; got ${subtitle.ratio}`,
        );
        assert.equal(
            issues.some((i) => i.id === "intro-title"),
            false,
            "white is 4.5:1 against #0078D4, which a 44px title passes",
        );
    });

    test("auditLegibility_gradientDippingBetweenStops_measuresTheDipNotJustTheStops", async (t) => {
        // Black on #ff0000 is 5.3:1 and on #009600 5.4:1, but halfway between them the
        // gradient is #804b00, where it is 2.9:1. The animation makes every colour of the
        // gradient reachable, so the midpoint is behind the title at some frame.
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000)], {
                project: { background: "white" },
            }),
        );
        await scene.frameAt(1.5);
        await scene.page.addStyleTag({
            content:
                "#stage{background:linear-gradient(90deg,#ff0000,#009600) !important;animation:drift 9s infinite !important}@keyframes drift{to{background-position:100% 0}}#intro-title{color:#000 !important}",
        });

        const title = lowContrast(
            await scene.eval(() => window.auditLegibility()),
        ).find((i) => i.id === "intro-title");

        assert.ok(
            title,
            "the title must be flagged at the dip between the stops",
        );
        assert.ok(
            title.ratio >= 2.8 && title.ratio <= 3.0,
            `and the ratio must be the dip's, 2.9:1; got ${title.ratio}`,
        );
    });

    test("auditLegibility_meshTheme_flagsWhatTheRenderedBlobsFailAndNothingElse", async (t) => {
        // Mesh drifts three translucent blobs over the stage, each on its own path, in one
        // animation. Every blob at its brightest at once is a colour the stage never shows, and
        // measuring against it flagged the stock kicker, label and subtitle. The rendered pixels
        // under each box, across the animation, are the ground truth: only the secondary-text card
        // copy fails AA over the blobs.
        const items = [
            { label: "Point", text: "Body copy" },
            { label: "Another", text: "More copy" },
        ];
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000, { items })], {
                project: { theme: "mesh" },
            }),
        );
        await scene.frameAt(1.5);

        const flagged = lowContrast(
            await scene.eval(() => window.auditLegibility()),
        );
        const [label, subtitle, kicker1, body1, kicker2, body2] =
            await renderedWorstRatios(
                scene,
                [
                    "#intro-label",
                    "#intro-subtitle",
                    "#intro-item-0 .kicker",
                    "#intro-item-0 .body",
                    "#intro-item-1 .kicker",
                    "#intro-item-1 .body",
                ],
                12,
            );

        assert.deepEqual(
            flagged.map((i) => i.id),
            ["body", "body"],
            `got ${JSON.stringify(flagged)}`,
        );
        [body1, body2].forEach((pixels, i) => {
            assert.ok(
                pixels < 4.5,
                `the rendered card copy fails AA, so flagging it is right; got ${pixels}`,
            );
            assert.ok(
                flagged[i].ratio <= pixels + 0.05,
                `the audit must not report better than the rendered ${pixels.toFixed(2)}:1; got ${flagged[i].ratio}`,
            );
        });
        assert.ok(
            subtitle >= 3,
            `the large subtitle passes 3:1 on every rendered frame; got ${subtitle}`,
        );
        [label, kicker1, kicker2].forEach((pixels) =>
            assert.ok(
                pixels >= 4.5,
                `accent text passes 4.5:1 on every rendered frame; got ${pixels}`,
            ),
        );
    });

    // Hit testing is not painting: elementsFromPoint skips an element whose pointer-events is none,
    // however much it paints. The first case makes nothing pointer-transparent and is the control.
    // In the others the footage, or the title itself, is pointer-transparent, which once left the
    // audit certifying white text against the black .footage-fullbleed or the stage.
    const POINTER_TRANSPARENCY = [
        ["footageBackdrop", null, async () => {}],
        [
            "pointerTransparentFootage",
            ".sl.on .footage-layer",
            (scene) =>
                scene.page.addStyleTag({
                    content: ".footage-layer{pointer-events:none}",
                }),
        ],
        // An inline !important declaration outranks any stylesheet rule the audit could add.
        [
            "footagePointerTransparentByInlineImportant",
            ".sl.on .footage-layer",
            (scene) =>
                scene.eval(() =>
                    document
                        .querySelector(".sl.on .footage-layer")
                        .style.setProperty(
                            "pointer-events",
                            "none",
                            "important",
                        ),
                ),
        ],
        [
            "titleInAPointerTransparentOverlay",
            ".sl.on .lt-title",
            (scene) =>
                scene.page.addStyleTag({
                    content: ".safe-footage{pointer-events:none}",
                }),
        ],
    ];
    for (const [name, transparent, makeTransparent] of POINTER_TRANSPARENCY) {
        test(`auditLegibility_${name}_reportsContrastUnverified`, async (t) => {
            // Footage is a sibling layer under the lower third, not an ancestor of its text, and its
            // pixels cannot be measured from the DOM. The lower third also declares a navy
            // --color-bg-primary, which the audit used to certify white text against.
            const dir = footageProject(t);
            const timingPath = path.join(dir, "timing.json");
            const timing = JSON.parse(fs.readFileSync(timingPath, "utf8"));
            timing.segments[0].visual.title = "Real footage";
            fs.writeFileSync(timingPath, JSON.stringify(timing));
            const r = runScript(
                "write-build-html.mjs",
                ["--apply", "--replace"],
                dir,
            );
            assert.equal(r.code, EXIT.OK, r.all);
            const scene = await openScene(t, path.join(dir, "video-auto.html"));
            await scene.frameAt(1);
            await assertFootageFrameOnScreen(
                scene,
                1000,
                "a footage frame must be on screen, or the backdrop is not footage",
            );
            await makeTransparent(scene);
            if (transparent) {
                const pe = await scene.eval(
                    (sel) =>
                        getComputedStyle(document.querySelector(sel))
                            .pointerEvents,
                    transparent,
                );
                assert.equal(
                    pe,
                    "none",
                    `${transparent} must be pointer-transparent, or this case tests nothing`,
                );
            }

            const { issues, before, after } = await scene.eval(() => {
                const styles = () =>
                    Array.from(document.querySelectorAll("*"), (n) => [
                        n.getAttribute("style"),
                        getComputedStyle(n).pointerEvents,
                    ]);
                const before = styles();
                const issues = window.auditLegibility();
                return { issues, before, after: styles() };
            });

            const title = issues.find((i) => i.id === "one-title");
            assert.deepEqual(
                title,
                {
                    id: "one-title",
                    reason: "contrast-unverified",
                    backdrop: "footage",
                },
                `got ${JSON.stringify(issues)}`,
            );
            assert.deepEqual(
                after,
                before,
                "the audit must leave every style attribute and pointer-events value as it found them",
            );
        });
    }

    // The footage precondition above must hold whichever way the image decoder races it, and
    // must still fail when no frame can be on screen. Both directions are pinned here, with
    // the race made deterministic, so the precondition cannot drift back to either flaky or
    // vacuous.
    test("footageFrameOnScreen_loadAlreadySettledWhenAsked_passesOnAnEmptyOutcomeList", async (t) => {
        const dir = footageProject(t);
        assert.equal(
            runScript("write-build-html.mjs", ["--apply", "--replace"], dir)
                .code,
            EXIT.OK,
        );
        const scene = await openScene(t, path.join(dir, "video-auto.html"));
        await scene.frameAt(1);
        // Wait out the load fireTriggersUpTo started, so the next request finds it on screen.
        await scene.eval(() => window.__setFootageFrame(1000));
        assert.deepEqual(
            await scene.eval(() => window.__setFootageFrame(1000)),
            [],
            "precondition: a settled frame answers with an empty outcome list — the case that raced",
        );

        await assertFootageFrameOnScreen(
            scene,
            1000,
            "a settled footage frame is on screen",
        );
    });

    test("footageFrameOnScreen_emptyOutcomeListWithNoFootageOnScreen_fails", async (t) => {
        const dir = footageProject(t);
        assert.equal(
            runScript("write-build-html.mjs", ["--apply", "--replace"], dir)
                .code,
            EXIT.OK,
        );
        const scene = await openScene(t, path.join(dir, "video-auto.html"));
        // Segment "two" has no footage, so nothing loads and the outcome list is empty.
        await scene.frameAt(3);
        assert.deepEqual(
            await scene.eval(() => window.__setFootageFrame(3000)),
            [],
            "precondition: no footage layer covers this instant",
        );

        await assert.rejects(
            assertFootageFrameOnScreen(
                scene,
                3000,
                "no footage slide is on screen",
            ),
            /no footage slide is on screen: the footage layer shows null/,
        );
    });

    test("footageFrameOnScreen_frameCannotLoad_fails", async (t) => {
        const dir = footageProject(t);
        assert.equal(
            runScript("write-build-html.mjs", ["--apply", "--replace"], dir)
                .code,
            EXIT.OK,
        );
        // Built with a valid frame set, then the frames are removed, so every image load fails.
        fs.rmSync(path.join(dir, "evidence-pack", "footage", "myclip"), {
            recursive: true,
        });
        const scene = await openScene(t, path.join(dir, "video-auto.html"));
        await scene.frameAt(1);

        await assert.rejects(
            assertFootageFrameOnScreen(
                scene,
                1000,
                "no footage frame can load",
            ),
            /no footage frame can load: a frame load failed — outcomes \[false\]/,
        );
    });

    test("auditLegibility_noSamplePointLandsOnTheText_reportsContrastUnverified", async (t) => {
        // Nine points sample what is under the text. When none lands on it, as between two glyphs set
        // far apart, the audit cannot know what is painted under it. It once measured the text's
        // nearest ancestor there instead, which skipped the white panel under these white glyphs.
        const visual = {
            mode: "diagram",
            title: "Flow",
            nodes: [{ id: "a", label: "Alpha", x: 100, y: 300 }],
            edges: [],
        };
        const scene = await openScene(
            t,
            buildScene(t, [
                {
                    id: "d",
                    startMs: 0,
                    endMs: 4000,
                    voiceoverText: "words",
                    visual,
                },
            ]),
        );
        await scene.frameAt(3.5);
        const { issues, landed } = await scene.eval(() => {
            const svg = document.querySelector(".sl.on svg");
            const ns = "http://www.w3.org/2000/svg";
            const panel = document.createElementNS(ns, "rect");
            Object.entries({
                x: 0,
                y: 360,
                width: 1600,
                height: 120,
                fill: "#fff",
            }).forEach(([k, v]) => panel.setAttribute(k, v));
            const glyphs = (id, x) => {
                const text = document.createElementNS(ns, "text");
                Object.entries({
                    id,
                    x,
                    y: 440,
                    style: "fill:#fff;color:#fff;font-size:40px",
                }).forEach(([k, v]) => text.setAttribute(k, v));
                text.textContent = "ab";
                return text;
            };
            const packed = glyphs("packed", "10");
            const spread = glyphs("spread", "10 1500");
            svg.append(panel, packed, spread);
            const r = spread.getBoundingClientRect();
            const landed = [0.15, 0.5, 0.85].flatMap((fy) =>
                [0.15, 0.5, 0.85].map((fx) =>
                    document
                        .elementsFromPoint(
                            r.left + r.width * fx,
                            r.top + r.height * fy,
                        )
                        .includes(spread),
                ),
            );
            return { issues: window.auditLegibility(), landed };
        });
        assert.ok(
            !landed.includes(true),
            "no sample point may land on the spread glyphs, or this tests nothing",
        );

        const packed = issues.find((i) => i.id === "packed");
        assert.equal(
            packed?.reason,
            "low-contrast",
            `white glyphs that are hit are measured on the white panel; got ${JSON.stringify(issues)}`,
        );
        const spread = issues.find((i) => i.id === "spread");
        assert.deepEqual(
            spread,
            {
                id: "spread",
                reason: "contrast-unverified",
                backdrop: "unsampled",
            },
            `got ${JSON.stringify(issues)}`,
        );
    });

    test("auditLegibility_imageBehindText_reportsContrastUnverified", async (t) => {
        const scene = await openScene(
            t,
            buildScene(t, [
                narrative("intro", 0, 4000, {
                    items: [{ label: "Point", text: "Body copy" }],
                }),
            ]),
        );
        await scene.frameAt(1.5);
        await scene.page.addStyleTag({
            content: "#intro-item-0{background:url(photo.png) !important}",
        });

        const issues = await scene.eval(() => window.auditLegibility());

        const body = issues.find((i) => i.id === "body");
        assert.deepEqual(
            body,
            { id: "body", reason: "contrast-unverified", backdrop: "image" },
            `got ${JSON.stringify(issues)}`,
        );
    });

    test("auditLegibility_manyTranslucentGradientLayers_reportsComplexWithoutStalling", async (t) => {
        // Every translucent layer multiplies the colours that can be behind the text. Four layers of
        // twelve stops once took the audit eleven seconds, and frame-capture runs it at every
        // segment start. Past a fixed amount of work the backdrop is reported as too complex.
        const scene = await openScene(
            t,
            buildScene(t, [
                narrative("intro", 0, 4000, {
                    items: [
                        { label: "Point", text: "Body copy across the card" },
                    ],
                }),
            ]),
        );
        await scene.frameAt(1.5);
        const stops = (k) =>
            Array.from(
                { length: 12 },
                (_, i) =>
                    `rgba(${(i * 97 + k * 31) % 256},${(i * 53 + k * 71) % 256},${(i * 29 + k * 13) % 256},0.5)`,
            ).join(",");
        const layers = [0, 1, 2, 3]
            .map((k) => `linear-gradient(${k * 45}deg,${stops(k)})`)
            .join(",");
        await scene.page.addStyleTag({
            content: `#intro-item-0{background:${layers} !important}`,
        });

        const { ms, issues } = await scene.eval(() => {
            const t0 = performance.now();
            const issues = window.auditLegibility();
            return { ms: performance.now() - t0, issues };
        });

        assert.deepEqual(
            issues.find((i) => i.id === "body"),
            { id: "body", reason: "contrast-unverified", backdrop: "complex" },
            `got ${JSON.stringify(issues)}`,
        );
        assert.ok(
            ms < 2000,
            `the audit must give up rather than stall; it took ${Math.round(ms)} ms`,
        );
    });

    test("auditLegibility_diagramEdgeLabel_measuresTheGlyphsAgainstTheirHalo", async (t) => {
        // An edge label paints a stroke halo under its glyphs (paint-order:stroke), so the halo, not
        // the stage, is what the label is read against, wherever the diagram puts it.
        const visual = {
            mode: "diagram",
            title: "Flow",
            nodes: [
                { id: "a", label: "Alpha", x: 100, y: 300 },
                { id: "b", label: "Beta", x: 900, y: 300 },
            ],
            edges: [{ id: "e1", from: "a", to: "b", label: "calls into" }],
        };
        const scene = await openScene(
            t,
            buildScene(t, [
                {
                    id: "d",
                    startMs: 0,
                    endMs: 4000,
                    voiceoverText: "words",
                    visual,
                },
            ]),
        );
        await scene.frameAt(3.5);
        const edgeLabel = (issues) =>
            issues.filter((i) => i.id === "d-edgelabel-e1");

        const probe = await scene.page.addStyleTag({
            content: ".delabel{stroke:#e0e0e0 !important}",
        });
        const live = edgeLabel(
            await scene.eval(() => window.auditLegibility()),
        );
        assert.equal(
            live[0]?.reason,
            "low-contrast",
            `white glyphs on a pale halo must be flagged, however dark the stage; got ${JSON.stringify(live)}`,
        );
        await probe.evaluate((n) => n.remove());

        assert.deepEqual(
            edgeLabel(await scene.eval(() => window.auditLegibility())),
            [],
            "white glyphs on the stock navy halo are legible, and the halo is a colour that can be measured",
        );
    });

    test("auditLegibility_whiteTextOnDefaultMidnight_raisesNoContrastAdvisory", async (t) => {
        // The control. Midnight's cyan glow is fixed, so it is measured where it is painted.
        // Taking the worst case of every stop would flag the stock secondary text on every
        // default render, and an audit that is always noisy is ignored.
        const items = [
            { label: "Point", text: "Body copy" },
            { label: "Another", text: "More copy" },
        ];
        const scene = await openScene(
            t,
            buildScene(t, [narrative("intro", 0, 4000, { items })]),
        );
        await scene.frameAt(1.5);
        const contrast = (issues) =>
            issues.filter(
                (i) =>
                    i.reason === "low-contrast" ||
                    i.reason === "contrast-unverified",
            );

        const probe = await scene.page.addStyleTag({
            content: "#intro-title{color:#1d2433 !important}",
        });
        const live = contrast(await scene.eval(() => window.auditLegibility()));
        assert.ok(
            live.some((i) => i.id === "intro-title"),
            `navy on the navy stage must be flagged, or the check is dead; got ${JSON.stringify(live)}`,
        );
        await probe.evaluate((n) => n.remove());

        assert.deepEqual(
            contrast(await scene.eval(() => window.auditLegibility())),
            [],
            "the stock midnight page raises nothing",
        );
        await scene.page.addStyleTag({
            content:
                ".sl.on .kicker,.sl.on .title,.sl.on .subtitle,.sl.on .body{color:#fff !important}",
        });
        assert.deepEqual(
            contrast(await scene.eval(() => window.auditLegibility())),
            [],
            "and neither does plain white text",
        );
    });
});

// ---------------------------------------------------------------------------
// C-3. A slide holds for LINGER (2 s) after its narration, but never into the next
// narration. EvalLoopDemo has seven 1,416 ms seams; at each one the next slide appeared
// 584 ms late and its entry tweens played on a hidden slide.
// ---------------------------------------------------------------------------
describe("slide switches at segment seams (C-3)", () => {
    const seams = [
        narrative("a", 0, 4000),
        narrative("b", 5416, 9000), // a 1,416 ms seam, shorter than LINGER
        narrative("c", 9000, 12000), // a contiguous seam
        narrative("d", 15000, 18000), // a 3,000 ms seam, longer than LINGER
    ];
    async function slideOnAt(scene, seconds) {
        await scene.frameAt(seconds);
        return scene.eval(() => document.querySelector(".sl.on")?.id ?? null);
    }

    test("fireTriggersUpTo_seamShorterThanLinger_showsTheNextSlideAsItsNarrationStarts", async (t) => {
        const scene = await openScene(t, buildScene(t, seams));

        assert.equal(
            await slideOnAt(scene, 5.3),
            "seg-0",
            "the previous slide holds through the short gap",
        );
        assert.equal(
            await slideOnAt(scene, 5.416),
            "seg-1",
            "and gives way the moment the next narration starts",
        );
        assert.equal(
            await scene.eval(
                () => !!document.querySelector(".sl.on #b-title.show"),
            ),
            true,
            "so the title enters on a slide the viewer can see",
        );
        assert.equal(
            await slideOnAt(scene, 9.0),
            "seg-2",
            "a contiguous seam switches at the boundary, not 2 s into the next narration",
        );
    });

    // A GUARD, not a reproduction: this passes before and after the fix. It pins the behaviour
    // the cap must leave alone, a slide that lingers 2 s into a gap longer than 2 s.
    test("fireTriggersUpTo_seamLongerThanLinger_stillSwitchesTwoSecondsAfterThePreviousNarration", async (t) => {
        const scene = await openScene(t, buildScene(t, seams));

        assert.equal(await slideOnAt(scene, 13.9), "seg-2");
        assert.equal(await slideOnAt(scene, 14.0), "seg-3");
    });
});

// ---------------------------------------------------------------------------
// C-4. Code focus, held marks, and frame dedup.
//
// Capture reuses a frame whenever __frameSig says nothing changed. Every assertion that
// two signatures DIFFER first proves the frames are settled and that two settled frames in
// one state share a signature, so dedup is really active. An in-motion 'm' token differs
// from everything, and would make an inequality pass for the wrong reason. The fixture has
// no diagram, so no pulsePath: a `.pulsing` element on a hidden slide switches dedup off
// for the rest of a render (L-1), which is what masked this in EvalLoopDemo.
// ---------------------------------------------------------------------------
describe("code focus, held marks and frame dedup (C-4)", () => {
    // cfg: focus alpha at 5.0 s and beta at 7.0 s. The release lands at
    // 4.0 + (3000 + min(2200, 2600)) / 1000 = 9.2 s.
    const RELEASE = 9.2;
    const MARK = 2.0;
    const segments = () => [
        {
            ...narrative("intro", 0, 4000),
            triggers: [
                {
                    atMs: MARK * 1000,
                    target: "intro-title",
                    action: "emphasize",
                    payload: { hold: true },
                },
            ],
        },
        {
            id: "cfg",
            startMs: 4000,
            endMs: 14000,
            voiceoverText: "words",
            visual: {
                mode: "code",
                title: "Config",
                json: { alpha: "a", beta: "b", gamma: "c" },
                highlights: [
                    { path: "alpha", atMs: 1000 },
                    { path: "beta", atMs: 3000 },
                ],
            },
        },
    ];
    const dimState = () =>
        document.querySelectorAll(
            ".codeblock.is-dim, .j-entry.is-off, .j-entry.is-focus",
        ).length;

    test("frameSig_codeFocusReleaseWithDedupActive_changesTheSettledSignature", async (t) => {
        const scene = await openScene(t, buildScene(t, segments()));

        const focused = await scene.frameAt(RELEASE - 0.4);
        assert.doesNotMatch(
            focused,
            /^m/,
            "the focused frame must be settled, or the comparison below proves nothing",
        );
        assert.equal(
            await scene.frameAt(RELEASE - 0.3),
            focused,
            "dedup is active: two settled frames in one state share a signature",
        );
        assert.ok(
            (await scene.eval(dimState)) > 0,
            "a field is focused and the rest dimmed",
        );

        const released = await scene.frameAt(RELEASE + 0.6);
        assert.equal(await scene.eval(dimState), 0, "the release has happened");
        assert.doesNotMatch(released, /^m/);
        assert.notEqual(
            released,
            focused,
            "the released frame must not reuse the focused one",
        );
    });

    test("frameSig_heldEmphasisMark_changesTheSettledSignature", async (t) => {
        const scene = await openScene(t, buildScene(t, segments()));

        const plain = await scene.frameAt(MARK - 0.5);
        assert.doesNotMatch(plain, /^m/);
        assert.equal(
            await scene.frameAt(MARK - 0.4),
            plain,
            "dedup is active: two settled frames in one state share a signature",
        );

        const marked = await scene.frameAt(MARK + 0.6);
        assert.equal(
            await scene.eval(() =>
                document
                    .getElementById("intro-title")
                    .classList.contains("is-marked"),
            ),
            true,
            "the hold has applied its mark",
        );
        assert.doesNotMatch(marked, /^m/);
        assert.notEqual(
            marked,
            plain,
            "a held mark changes the pixels, so it must change the signature",
        );
    });

    test("frameSig_codeFocusRelease_isMotionGuardedWhileTheFieldsFadeBack", async (t) => {
        const scene = await openScene(
            t,
            buildScene(t, segments(), { gsap: TIMED_GSAP }),
        );

        assert.doesNotMatch(
            await scene.frameAt(RELEASE - 0.1),
            /^m/,
            "nothing is moving just before the release; the focus tweens ended seconds ago",
        );
        assert.match(
            await scene.frameAt(RELEASE + 0.1),
            /^m/,
            "the dimmed fields fade back over video time, and dedup must not hold a frame of that",
        );
        assert.doesNotMatch(
            await scene.frameAt(RELEASE + 0.6),
            /^m/,
            "and the fade ends, so dedup resumes",
        );
    });

    // What the fade SHOWS, with a stub that renders opacity. `.j-entry` also carries a CSS
    // opacity transition, which runs on the wall clock (C-6, not fixed here), so it is switched
    // off: the computed opacity is then exactly what the scene set for this video time.
    test("codeFocus_releaseAfterAFocusWalk_fadesTheDimmedFieldsBackWithoutAJump", async (t) => {
        const html = buildScene(t, segments(), { gsap: RENDER_GSAP });
        const open = async () => {
            const scene = await openScene(t, html);
            await scene.page.addStyleTag({
                content: "*,*::before,*::after{transition:none !important}",
            });
            return scene;
        };
        const opacities = () =>
            Object.fromEntries(
                Array.from(
                    document.querySelectorAll("#seg-1 .j-entry"),
                    (n) => [n.id, Number(getComputedStyle(n).opacity)],
                ),
            );
        const scene = await open();

        await scene.frameAt(RELEASE - 0.1);
        const before = await scene.eval(opacities);
        const dim = Math.min(...Object.values(before));
        assert.ok(
            dim < 0.5,
            `a field must be dimmed before the release, or this proves nothing; got ${JSON.stringify(before)}`,
        );

        await scene.frameAt(RELEASE);
        assert.deepEqual(
            await scene.eval(opacities),
            before,
            "the release starts from what the screen showed, with no jump",
        );

        await scene.frameAt(RELEASE + 0.2);
        const mid = await scene.eval(opacities);
        for (const [id, o] of Object.entries(before))
            assert.ok(
                mid[id] >= o,
                `${id} must not dip on its way back (${o} then ${mid[id]})`,
            );
        assert.ok(
            Object.values(mid).some((o) => o > dim && o < 1),
            `the dimmed fields are part-way back; got ${JSON.stringify(mid)}`,
        );
        const cold = await open();
        await cold.frameAt(RELEASE + 0.2);
        assert.deepEqual(
            await cold.eval(opacities),
            mid,
            "a mid-fade frame is the same whether played to or seeked to",
        );

        await scene.frameAt(RELEASE + 0.6);
        const after = await scene.eval(opacities);
        assert.ok(
            Object.values(after).every((o) => o === 1),
            `every field ends fully lit; got ${JSON.stringify(after)}`,
        );
    });

    test("fireTriggersUpTo_rewindPastACodeFocus_clearsTheDimmingItApplied", async (t) => {
        const html = buildScene(t, segments());
        const scene = await openScene(t, html);
        await scene.frameAt(RELEASE - 0.3);
        assert.ok(
            (await scene.eval(dimState)) > 0,
            "a field is focused and the rest dimmed",
        );

        // 4.5 s: the code slide is up and its block has risen, and no field is focused yet.
        const rewound = await scene.frameAt(4.5);

        assert.equal(
            await scene.eval(dimState),
            0,
            "a rewind must not keep dimming from a focus that has not happened yet",
        );
        const cold = await openScene(t, html);
        assert.equal(
            rewound,
            await cold.frameAt(4.5),
            "a rewound frame must be the frame a cold seek produces",
        );
    });

    test("fireTriggersUpTo_rewindPastAHeldMark_clearsTheMark", async (t) => {
        const html = buildScene(t, segments());
        const scene = await openScene(t, html);
        await scene.frameAt(MARK + 0.6);
        assert.equal(
            await scene.eval(
                () => document.querySelectorAll(".is-marked").length,
            ),
            1,
            "the hold has applied its mark",
        );

        const rewound = await scene.frameAt(MARK - 1);

        assert.equal(
            await scene.eval(
                () => document.querySelectorAll(".is-marked").length,
            ),
            0,
            "a rewind must not keep a mark from the future",
        );
        const cold = await openScene(t, html);
        assert.equal(
            rewound,
            await cold.frameAt(MARK - 1),
            "a rewound frame must be the frame a cold seek produces",
        );
    });
});

// ---------------------------------------------------------------------------
// C-5 / P-1. A code block is capped at a max-height with overflow:hidden. Content past the
// cap is cut off, and auditLayout checked only the safe area, which still fits because the
// block is capped. The clip was silent.
// ---------------------------------------------------------------------------
describe("code blocks never clip silently (C-5 / P-1)", () => {
    test("auditLayout_codeblockTallerThanItsPanel_reportsTheClippedBlock", async (t) => {
        const rows = Array.from({ length: 60 }, (_, i) => `row ${i}`);
        const scene = await openScene(
            t,
            buildScene(t, [
                {
                    id: "tall",
                    startMs: 0,
                    endMs: 4000,
                    voiceoverText: "words",
                    visual: { mode: "code", title: "Tall", json: { rows } },
                },
                {
                    id: "fits",
                    startMs: 4000,
                    endMs: 8000,
                    voiceoverText: "words",
                    visual: { mode: "code", title: "Fits", json: { id: "x" } },
                },
            ]),
        );

        const clip = await scene.eval(() => {
            const cb = document.querySelector("#seg-0 .codeblock");
            const safe = document.querySelector("#seg-0 .safe");
            return {
                hiddenPx: cb.scrollHeight - cb.clientHeight,
                safeOverflows: safe.scrollHeight > safe.clientHeight + 2,
            };
        });
        assert.ok(
            clip.hiddenPx > 100,
            `the fixture must really clip (${clip.hiddenPx}px hidden), or this proves nothing`,
        );
        assert.equal(
            clip.safeOverflows,
            false,
            "while the safe area fits, which is all the audit used to check",
        );

        const issues = await scene.eval(() => window.auditLayout());

        assert.deepEqual(
            issues.map((i) => [i.id, i.seg, i.reason]),
            [["seg-0", "tall", "codeblock-clipped"]],
            `the clipped block, and only that block, must be reported; got ${JSON.stringify(issues)}`,
        );
    });
});
