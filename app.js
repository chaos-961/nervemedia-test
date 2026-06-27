/* =====================================================================
   Nerve Media — app.js
   Two independent systems, in order:

   1. CORE  — environment profile, fixed public theme,
              reveal observers, hero intro, and the nerve background
              (seeded network → pre-baked compositor layers + pulses).
              Runs on BOTH the public page and the admin shell.
   2. FX    — normalized section progress, springs, pins, and scrubs
               driven by the shared coordinator on every viewport.
              Skipped entirely for admin-body and reduced motion.

   Performance invariants (do not regress):
   - Per-frame work happens only during active scroll; both loops idle.
   - No layout reads inside a frame tick — geometry is cached by
     measureGeom() and re-read only on load/fonts/resize.
   - Mobile never runs a background canvas rAF loop: the network is baked
     into offscreen layers and slid by the compositor via a --scroll transform.
   - On compact viewports --scroll is written to the .nerve-field element,
     not :root, so a scroll frame invalidates one subtree, not the page.
   ===================================================================== */

(function () {
  /* ----------------------------------------------------------------
     1.1 Environment & device profile
     ---------------------------------------------------------------- */
  const root = document.documentElement;
  const body = document.body;
  const year = document.getElementById("currentYear");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const compactViewport = window.matchMedia("(max-width: 760px)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  // Low-spec: thin the network density even on wide screens.
  const lowSpec =
    saveData ||
    (typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4) ||
    (typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency <= 4);
  const lowPowerMotion = compactViewport || coarsePointer || saveData;
  const simpleTitleMotion = saveData;
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  if (year) {
    year.textContent = new Date().getFullYear();
  }

  let scrollTicking = false;
  const motionClients = new Set();
  let motionMeasureVersion = 0;
  let scrollProgress = 0;
  let scrollVelocity = 0;
  let themeIsLight = false;
  let themeMetaChannel = -1;
  let lastScrollY = window.scrollY;
  let requestNerveDraw = () => {};
  let wakeNerveDraw = () => {};
  let fieldContainer = null; // assigned in the background section
  const themeVarCache = {};
  let docMaxScroll = 1;
  let themeGeomTimer = 0;
  let requestMotionMeasure = () => {};
  const heroMotionImage = document.querySelector(".hero-visual img");
  let heroMotionResumeTimer = 0;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const isCompactCanvas = () => window.innerWidth <= 760 || coarsePointer;

  const setThemeVar = (name, value) => {
    if (themeVarCache[name] === value) return;
    themeVarCache[name] = value;
    root.style.setProperty(name, value);
  };

  // --scroll feeds the grid parallax (desktop, on :root) and the nerve-field
  // layer parallax (compact, on the field element). Writing it on :root on a
  // phone invalidated computed style for the whole document every scroll
  // frame — scoping the write to its one mobile consumer removes that.
  let scrollVarEl = null;
  let scrollVarValue = "";
  const setScrollVar = (value) => {
    const target = fieldContainer && isCompactCanvas() ? fieldContainer : root;
    if (scrollVarEl === target && scrollVarValue === value) return;
    if (scrollVarEl && scrollVarEl !== target) {
      scrollVarEl.style.removeProperty("--scroll");
    }
    scrollVarEl = target;
    scrollVarValue = value;
    target.style.setProperty("--scroll", value);
  };

  /* ----------------------------------------------------------------
     1.2 Theme controller — public stays dark. Admin keeps its own fixed
     tones (login dark / pricing light).
     ---------------------------------------------------------------- */
  const measureThemeGeom = () => {
    docMaxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    motionMeasureVersion += 1;
  };

  const updateThemeMeta = (channel) => {
    if (!themeMeta || (Math.abs(channel - themeMetaChannel) < 8 && channel !== 0 && channel !== 255)) return;
    themeMetaChannel = channel;
    const hex = channel.toString(16).padStart(2, "0");
    themeMeta.setAttribute("content", `#${hex}${hex}${hex}`);
  };

  const setThemeFromScroll = () => {
    const adminTone = body.classList.contains("admin-body")
      ? body.classList.contains("is-pricing-open")
        ? "light"
        : "dark"
      : "";

    if (adminTone) {
      const textIsDark = adminTone === "light";
      const foreground = textIsDark ? "0, 0, 0" : "255, 255, 255";
      const inverse = textIsDark ? "255, 255, 255" : "0, 0, 0";
      const bg = textIsDark ? "245, 245, 240" : "0, 0, 0";

      themeIsLight = textIsDark;
      window.__themeLuma = textIsDark ? 0.96 : 0;
      setThemeVar("--theme-luma", textIsDark ? "0.96" : "0");
      setThemeVar("--theme-bg-rgb", bg);
      setThemeVar("--theme-fg-rgb", foreground);
      setThemeVar("--theme-inverse-rgb", inverse);
      // Admin keeps a calm, readable shell: the network is dimmed well back
      // behind the login form (and the light pricing view) so it reads as
      // atmosphere, not interference.
      setThemeVar("--theme-grid-opacity", textIsDark ? "0.08" : "0.12");
      setThemeVar("--theme-ambient-opacity", textIsDark ? "0.18" : "0.14");
      setThemeVar("--theme-field-opacity", textIsDark ? "0.2" : "0.5");
      setThemeVar("--theme-canvas-opacity", textIsDark ? "0.24" : "0.3");
      setThemeVar("--theme-grain-opacity", textIsDark ? "0.025" : "0.035");
      root.dataset.themeTone = adminTone;
      body.classList.toggle("is-light", textIsDark);
      updateThemeMeta(textIsDark ? 245 : 0);
      return;
    }

    themeIsLight = false;
    window.__themeLuma = 0;
    setThemeVar("--theme-luma", "0");
    setThemeVar("--theme-bg-channel", "0");
    setThemeVar("--theme-fg-channel", "255");
    setThemeVar("--theme-inverse-channel", "0");
    setThemeVar("--theme-grid-opacity", "0.18");
    setThemeVar("--theme-ambient-opacity", "0.18");
    setThemeVar("--theme-field-opacity", "0.66");
    setThemeVar("--theme-canvas-opacity", "0.54");
    setThemeVar("--theme-grain-opacity", "0.045");
    root.dataset.themeTone = "dark";
    body.classList.remove("is-light");
    updateThemeMeta(0);
  };

  /* ----------------------------------------------------------------
     1.3 Scroll spine — one passive listener feeding theme + canvas.
     ---------------------------------------------------------------- */
  const updateScroll = (time = performance.now()) => {
    const scrollY = window.scrollY;
    const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const progress = clamp(scrollY / docMaxScroll, 0, 1);
    const scrollDelta = scrollY - lastScrollY;
    lastScrollY = scrollY;
    scrollProgress = progress;
    scrollVelocity = scrollVelocity * 0.68 + scrollDelta * 0.32;
    // Quantized (~0.2px of grid travel per step) and cached, so the write —
    // and the style invalidation it causes — only happens when it matters.
    setScrollVar((Math.round(progress * 250) / 250).toFixed(3));
    setThemeFromScroll();
    wakeNerveDraw(lowPowerMotion ? 450 : 260);
    if (lowPowerMotion && heroMotionImage) {
      if (heroMotionImage.style.animationPlayState !== "paused") {
        heroMotionImage.style.animationPlayState = "paused";
      }
      window.clearTimeout(heroMotionResumeTimer);
      heroMotionResumeTimer = window.setTimeout(() => {
        heroMotionImage.style.animationPlayState = "";
      }, 140);
    }
    scrollTicking = false;

    let keepRunning = false;
    const frameState = {
      time,
      scrollY,
      viewportHeight,
      viewportWidth: window.innerWidth,
      deltaY: scrollDelta,
      velocity: scrollVelocity,
      pageProgress: progress,
      measureVersion: motionMeasureVersion,
    };
    motionClients.forEach((client) => {
      keepRunning = client.update(frameState) || keepRunning;
    });
    if (keepRunning) requestScrollUpdate();
  };

  const requestScrollUpdate = () => {
    if (scrollTicking) return;
    scrollTicking = true;
    window.requestAnimationFrame(updateScroll);
  };

  window.__nerveMotion = {
    subscribe: (update, measure) => {
      const client = { update, measure };
      motionClients.add(client);
      if (measure) measure();
      requestScrollUpdate();
      return () => motionClients.delete(client);
    },
    wake: requestScrollUpdate,
    remeasure: () => requestMotionMeasure(),
    snapshot: () => ({
      clients: motionClients.size,
      framePending: scrollTicking,
      measureVersion: motionMeasureVersion,
      scrollProgress,
      scrollVelocity,
    }),
  };

  /* ----------------------------------------------------------------
     1.4 Reveals — fire as soon as a sliver enters the viewport (a tall
     block at 18% visibility used to reveal long after the reader
     reached it), and stagger items that arrive in the same batch.
     ---------------------------------------------------------------- */
  const revealItems = Array.from(document.querySelectorAll("[data-reveal]"));
  const revealObserver = new IntersectionObserver(
    (entries) => {
      const incoming = entries.filter((entry) => entry.isIntersecting);
      incoming.forEach((entry, order) => {
        entry.target.style.setProperty("--reveal-delay", `${Math.min(order * 70, 280)}ms`);
        entry.target.classList.add("is-visible");
      });
      entries
        .filter((entry) => !entry.isIntersecting)
        .forEach((entry) => {
          entry.target.style.setProperty("--reveal-delay", "0ms");
          entry.target.classList.remove("is-visible");
        });
    },
    { threshold: 0.04, rootMargin: "0px 0px -4% 0px" }
  );

  revealItems.forEach((item) => revealObserver.observe(item));

  const heroSection = document.querySelector(".hero");
  if (heroSection) {
    const heroObserver = new IntersectionObserver(
      ([entry]) => body.classList.toggle("is-hero-visible", entry.isIntersecting),
      { rootMargin: "80px 0px" }
    );
    heroObserver.observe(heroSection);
  }

  const remeasureTheme = () => {
    measureThemeGeom();
    motionClients.forEach((client) => {
      if (client.measure) client.measure();
    });
    requestScrollUpdate();
  };
  requestMotionMeasure = remeasureTheme;

  measureThemeGeom();
  updateScroll();
  window.addEventListener("scroll", requestScrollUpdate, { passive: true });
  window.addEventListener(
    "resize",
    () => {
      window.clearTimeout(themeGeomTimer);
      themeGeomTimer = window.setTimeout(remeasureTheme, 150);
      requestScrollUpdate();
    },
    { passive: true }
  );
  window.addEventListener("load", remeasureTheme);
  window.addEventListener("orientationchange", remeasureTheme, { passive: true });
  window.addEventListener("pageshow", remeasureTheme);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      window.clearTimeout(themeGeomTimer);
      themeGeomTimer = window.setTimeout(remeasureTheme, 120);
    });
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(remeasureTheme);
  }
  if (typeof ResizeObserver === "function") {
    const motionResizeObserver = new ResizeObserver(() => {
      window.clearTimeout(themeGeomTimer);
      themeGeomTimer = window.setTimeout(remeasureTheme, 120);
    });
    motionResizeObserver.observe(document.body);
  }

  /* ----------------------------------------------------------------
     1.5 Hero intro — split title.
     Desktop and compact: per-character rise. Save-Data keeps the two
     words intact as the low-bandwidth fallback.
     Screen readers always get the clean .sr-only heading instead.
     ---------------------------------------------------------------- */
  const heroTitle = document.querySelector(".hero h1");
  if (!reducedMotion) {
    const splitTargets = Array.from(document.querySelectorAll("[data-split]"));
    if (simpleTitleMotion) {
      splitTargets.forEach((target, index) => {
        target.style.animationDelay = `${0.16 + index * 0.14}s`;
      });
      if (heroTitle) heroTitle.setAttribute("data-animate", "words");
    } else {
      let charIndex = 0;
      splitTargets.forEach((target) => {
        const text = target.textContent;
        target.textContent = "";
        text.split("").forEach((letter) => {
          const span = document.createElement("span");
          span.className = "char";
          span.textContent = letter;
          span.style.animationDelay = `${0.18 + charIndex * 0.045}s`;
          target.appendChild(span);
          charIndex += 1;
        });
      });
      if (heroTitle) heroTitle.setAttribute("data-animate", "chars");
    }
  }

  /* ----------------------------------------------------------------
     1.5b Boot — loading screen.
     The #loader overlay (public page only) covers first paint and is
     dismissed when the hero image + fonts are ready: never sooner than
     500ms (so it doesn't blink on a warm cache) and never later than
     2.8s (so it can't hold the page hostage on a slow network).
     body.is-ready gates the hero entrance choreography in CSS, so the
     title/copy/CTA rise exactly as the loader wipes away. The title's
     entrance attribute is cleared on a timer from ready (not from
     eval) as a bfcache/visibility safety net.
     ---------------------------------------------------------------- */
  const loader = document.getElementById("loader");
  const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  fontsReady.then(() => body.classList.add("fonts-ready"));
  let bootDone = false;
  const markReady = () => {
    if (bootDone) return;
    bootDone = true;
    body.classList.add("is-ready");
    if (loader) {
      loader.classList.add("is-done");
      window.setTimeout(() => loader.remove(), 1000);
    }
    if (heroTitle) {
      window.setTimeout(() => heroTitle.removeAttribute("data-animate"), 2600);
    }
  };

  if (!loader || reducedMotion) {
    markReady();
  } else {
    const heroImage = document.querySelector(".hero-visual img");
    const imageReady =
      heroImage && !heroImage.complete
        ? new Promise((resolve) => {
            heroImage.addEventListener("load", resolve, { once: true });
            heroImage.addEventListener("error", resolve, { once: true });
          })
        : Promise.resolve();
    const minHold = new Promise((resolve) => window.setTimeout(resolve, 500));
    const failSafe = new Promise((resolve) => window.setTimeout(resolve, 2800));
    Promise.race([Promise.all([imageReady, fontsReady, minHold]), failSafe]).then(markReady);
  }

  /* ----------------------------------------------------------------
     1.6 Nerve background.
     The network is pre-baked into a few depth-bucketed offscreen layers
     (plus a source-glow sprite). Those layers are presented as
     compositor-promoted DOM elements and slid with `transform` each
     frame — no per-frame canvas repaint at all. Only the live pulses
     are rasterized (on the small overlay canvas). Mobile has no draw
     loop whatsoever: a CSS transform multiplies --scroll instead.
     ---------------------------------------------------------------- */
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let resizeTimer = 0;
  let animationFrame = 0;
  let frameTimer = 0;
  let lastFrameTime = 0;
  let activeUntil = performance.now() + 1400;
  let drawCount = 0;
  let lastFrameGap = 0;
  let canvasIdleFrames = 0;
  let paths = [];
  let stars = [];
  let source = { x: 0, y: 0 };
  let networkWidth = 0;
  let networkHeight = 0;
  let networkMode = "";
  let networkBuilds = 0;
  let networkSignature = "";
  let randomValue = Math.random;
  let canvasThemeMix = 0;
  let backgroundStarted = false;
  const LAYER_DEPTHS = [0.3, 0.6, 0.88]; // far → near, paint order
  let layerStore = [];
  let layerChannel = -1;
  let layerBaseHeight = 0;
  let pulsePaths = [];
  let sourceSprite = null;

  const canvas = document.getElementById("nerveCanvas");
  window.__nerveDebug = {
    snapshot: () => ({
      width,
      height,
      pixelRatio,
      backingWidth: canvas ? canvas.width : 0,
      backingHeight: canvas ? canvas.height : 0,
      pathCount: paths.length,
      starCount: stars.length,
      networkBuilds,
      networkSignature,
      networkWidth,
      networkHeight,
      networkMode,
      scrollProgress,
      reducedMotion,
      lowPower: lowPowerMotion,
      lowSpec,
      ready: bootDone,
      renderer: "none",
      canvasReady: false,
    }),
    finishBoot: markReady,
  };

  if (!canvas || canvas.tagName !== "CANVAS" || typeof canvas.getContext !== "function") {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  // The baked depth layers + source glow live inside this fixed field as
  // their own compositor-promoted elements; parallax/drift is applied as a
  // `transform` (GPU-composited, no repaint). #nerveCanvas above it is a
  // small overlay used ONLY for the live pulses.
  fieldContainer = document.createElement("div");
  fieldContainer.className = "nerve-field";
  fieldContainer.setAttribute("aria-hidden", "true");
  canvas.parentNode.insertBefore(fieldContainer, canvas);
  let layerEls = [];
  let sourceAttached = false;

  const makeRandom = (seed) => {
    let value = seed >>> 0;
    return () => {
      value += 0x6d2b79f5;
      let next = value;
      next = Math.imul(next ^ (next >>> 15), next | 1);
      next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
      return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
    };
  };
  const randomBetween = (min, max) => min + randomValue() * (max - min);
  const choose = (items) => items[Math.floor(randomValue() * items.length)];

  const makeJaggedPath = (start, end, steps, jag, bias = 0) => {
    const points = [];
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const ease = 1 - Math.pow(1 - t, 1.28);
      const taper = Math.sin(t * Math.PI);
      const x = start.x + (end.x - start.x) * ease + randomBetween(-jag.x, jag.x) * taper;
      const y = start.y + (end.y - start.y) * t + randomBetween(-jag.y, jag.y) * taper + bias * taper;
      points.push({ x, y });
    }
    points[0] = start;
    points[points.length - 1] = end;
    return points;
  };

  const addStar = (point, depth, power, seed = randomValue()) => {
    const rays = Math.round(randomBetween(6, 11));
    stars.push({
      x: point.x,
      y: point.y,
      depth,
      power,
      seed,
      rays,
      rayLengths: Array.from({ length: rays }, () => randomBetween(0.8, 2.05)),
      radius: randomBetween(7, 18) * power,
    });
  };

  const addPath = (points, kind, depth, lineWidth, seed = randomValue()) => {
    paths.push({
      points,
      shifted: points.map(() => ({ x: 0, y: 0 })),
      kind,
      depth,
      lineWidth,
      seed,
    });
  };

  let canvasReady = true;

  const writeProofState = () => {
    root.dataset.nervePixelRatio = pixelRatio.toFixed(2);
    root.dataset.nerveBacking = canvas ? `${canvas.width}x${canvas.height}` : "0x0";
    root.dataset.nervePaths = String(paths.length);
    root.dataset.nerveStars = String(stars.length);
    root.dataset.nerveBuilds = String(networkBuilds);
    root.dataset.nerveSignature = networkSignature;
    root.dataset.nerveMode = networkMode;
    root.dataset.nerveCanvasReady = String(canvasReady);
  };

  const getPalette = () => {
    const adminCanvas = body.classList.contains("admin-body");
    const lightTarget = adminCanvas ? body.classList.contains("is-pricing-open") : themeIsLight;
    if (isCompactCanvas()) {
      // Discrete on compact: the page theme snaps there too, and a stable
      // channel means the pre-rendered layers only redraw once per flip.
      canvasThemeMix = lightTarget ? 1 : 0;
    } else {
      canvasThemeMix += ((lightTarget ? 1 : 0) - canvasThemeMix) * 0.16;
    }
    const channel = Math.round(255 * (1 - canvasThemeMix));
    return {
      rgb: `${channel}, ${channel}, ${channel}`,
      baseScale: adminCanvas ? 1.55 + canvasThemeMix * 0.65 : 0.92 + canvasThemeMix * 0.58,
      haloScale: (adminCanvas ? 0.95 - canvasThemeMix * 0.25 : 0.55 - canvasThemeMix * 0.1) * (1 - canvasThemeMix),
      starScale: adminCanvas ? 1.05 - canvasThemeMix * 0.1 : 0.78 - canvasThemeMix * 0.08,
      sourceScale: adminCanvas ? 0.16 - canvasThemeMix * 0.07 : 0.12 - canvasThemeMix * 0.05,
      pulseScale: 1 - canvasThemeMix * 0.28,
      coreScale: 0.96 - canvasThemeMix * 0.24,
      compositeOp: "source-over",
    };
  };

  const wakeCanvas = (duration = 420) => {
    // Mobile/touch: no animation loop — just make sure the layers are baked;
    // the CSS `--scroll` transform carries the parallax on the compositor.
    if (isCompactCanvas()) {
      ensureLayers();
      return;
    }
    activeUntil = Math.max(activeUntil, performance.now() + duration);
    requestNerveDraw();
  };
  wakeNerveDraw = wakeCanvas;

  const pointAtPath = (points, t) => {
    const target = clamp(t, 0, 1) * (points.length - 1);
    const index = Math.min(points.length - 2, Math.floor(target));
    const localT = target - index;
    const start = points[index];
    const end = points[index + 1];
    return {
      x: start.x + (end.x - start.x) * localT,
      y: start.y + (end.y - start.y) * localT,
    };
  };

  const drawPolyline = (points, ctx = context) => {
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.stroke();
  };

  const drawPulse = (points, t, length, alpha, lineWidth, palette) => {
    const startT = clamp(t - length * 0.5, 0, 1);
    const endT = clamp(t + length * 0.5, 0, 1);
    if (endT <= startT) return;

    const start = pointAtPath(points, startT);
    const end = pointAtPath(points, endT);
    const gradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
    gradient.addColorStop(0, `rgba(${palette.rgb}, 0)`);
    gradient.addColorStop(0.45, `rgba(${palette.rgb}, ${alpha})`);
    gradient.addColorStop(0.55, `rgba(${palette.rgb}, ${palette.pulseScale})`);
    gradient.addColorStop(1, `rgba(${palette.rgb}, 0)`);

    context.strokeStyle = gradient;
    context.lineWidth = lineWidth;
    context.beginPath();

    const steps = 8;
    for (let step = 0; step <= steps; step += 1) {
      const point = pointAtPath(points, startT + ((endT - startT) * step) / steps);
      if (step === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    }
    context.stroke();
  };

  /* --- Layer baking (stars + paths + source glow → offscreen canvases) --- */
  const repIndex = (depth) => (depth >= 0.75 ? 2 : depth >= 0.45 ? 1 : 0);

  const renderStarToLayer = (ctx, star, palette) => {
    const radius = star.radius;
    const gradient = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, radius * 2.2);
    gradient.addColorStop(0, `rgba(${palette.rgb}, ${0.7 * star.power * palette.starScale})`);
    gradient.addColorStop(0.18, `rgba(${palette.rgb}, ${0.28 * star.power * palette.starScale})`);
    gradient.addColorStop(1, `rgba(${palette.rgb}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(star.x, star.y, radius * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${palette.rgb}, ${0.36 * palette.starScale})`;
    ctx.lineWidth = Math.max(0.7, star.power);
    ctx.beginPath();
    for (let ray = 0; ray < Math.min(star.rays, 6); ray += 1) {
      const angle = (Math.PI * 2 * ray) / star.rays + star.seed * Math.PI;
      const rayLength = radius * star.rayLengths[ray] * 0.72;
      ctx.moveTo(star.x - Math.cos(angle) * radius * 0.18, star.y - Math.sin(angle) * radius * 0.18);
      ctx.lineTo(star.x + Math.cos(angle) * rayLength, star.y + Math.sin(angle) * rayLength);
    }
    ctx.stroke();

    ctx.fillStyle = `rgba(${palette.rgb}, ${palette.coreScale})`;
    ctx.beginPath();
    ctx.arc(star.x, star.y, Math.max(1.1, radius * 0.16), 0, Math.PI * 2);
    ctx.fill();
  };

  const renderLayers = (palette, channelKey) => {
    layerBaseHeight = height;
    layerChannel = channelKey === undefined ? Math.round(255 * (1 - canvasThemeMix)) : channelKey;
    const contexts = [];

    layerStore = LAYER_DEPTHS.map((rep, index) => {
      // Tall enough for the full scroll drift of this depth, plus margin so
      // mobile URL-bar viewport changes don't force a mid-scroll re-render.
      const layerHeight = Math.ceil(height * (1.38 + rep * 0.24));
      const layer = document.createElement("canvas");
      layer.width = Math.max(1, Math.floor(width * pixelRatio));
      layer.height = Math.max(1, Math.floor(layerHeight * pixelRatio));
      const ctx = layer.getContext("2d");
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      contexts.push(ctx);
      return { canvas: layer, rep, layerHeight, seed: index * 7.31 + 1.7, offsetX: 0, offsetY: 0 };
    });

    paths.forEach((path) => {
      const ctx = contexts[repIndex(path.depth)];
      const baseAlpha = path.kind === "primary" ? 0.72 : path.kind === "branch" ? 0.42 : 0.22;
      if (palette.haloScale > 0.01 && (path.kind === "primary" || path.kind === "branch")) {
        const haloAlpha = path.kind === "primary" ? 0.18 : 0.07;
        ctx.strokeStyle = `rgba(${palette.rgb}, ${haloAlpha * palette.haloScale})`;
        ctx.lineWidth = path.lineWidth * 1.6;
        drawPolyline(path.points, ctx);
      }
      ctx.strokeStyle = `rgba(${palette.rgb}, ${baseAlpha * palette.baseScale})`;
      ctx.lineWidth = path.lineWidth;
      drawPolyline(path.points, ctx);
    });

    stars.forEach((star) => renderStarToLayer(contexts[repIndex(star.depth)], star, palette));

    // The source glow is a radially symmetric gradient — bake it small once
    // and blit it scaled, instead of filling a near-viewport-size gradient
    // arc every frame.
    const spriteSize = 256;
    if (!sourceSprite) sourceSprite = document.createElement("canvas");
    sourceSprite.width = spriteSize;
    sourceSprite.height = spriteSize;
    const spriteCtx = sourceSprite.getContext("2d");
    spriteCtx.clearRect(0, 0, spriteSize, spriteSize);
    const glow = spriteCtx.createRadialGradient(
      spriteSize / 2,
      spriteSize / 2,
      0,
      spriteSize / 2,
      spriteSize / 2,
      spriteSize / 2
    );
    glow.addColorStop(0, `rgba(${palette.rgb}, ${Math.max(0, palette.sourceScale)})`);
    glow.addColorStop(0.26, `rgba(${palette.rgb}, ${Math.max(0, palette.sourceScale * 0.58)})`);
    glow.addColorStop(1, `rgba(${palette.rgb}, 0)`);
    spriteCtx.fillStyle = glow;
    spriteCtx.fillRect(0, 0, spriteSize, spriteSize);

    attachField();
  };

  // Present the freshly-baked layers as compositor-promoted DOM canvases.
  // The source glow sprite is attached once (it's reused and repainted in
  // place); the depth layers are recreated on every re-bake, so the old ones
  // are swapped out here.
  const attachField = () => {
    if (!sourceAttached && sourceSprite) {
      sourceSprite.className = "nerve-source";
      fieldContainer.insertBefore(sourceSprite, fieldContainer.firstChild);
      sourceAttached = true;
    }
    layerEls.forEach((el) => el.remove());
    layerEls = layerStore.map((layer) => {
      const el = layer.canvas;
      el.className = "nerve-layer";
      el.style.width = `${width}px`;
      el.style.height = `${layer.layerHeight}px`;
      fieldContainer.appendChild(el); // far → near (paint order)
      return el;
    });
  };

  // --- Mobile: no rAF loop at all ---
  // On compact/touch the parallax is expressed once as a CSS transform that
  // multiplies the shared `--scroll` variable (updated by the scroll handler
  // on the field element itself). The compositor then slides the cached layer
  // textures with zero per-frame JavaScript and zero repaint — the cheapest
  // possible "animation". The ambient wobble / pulses / smooth tint-crossover
  // are desktop-only luxuries.
  const positionFieldCSS = () => {
    layerStore.forEach((layer, index) => {
      const el = layerEls[index];
      if (!el) return;
      const driftPx = height * (0.1 + layer.rep * 0.24) * 1.3;
      el.style.opacity = "1";
      el.style.transform = `translate3d(0, calc(var(--scroll, 0) * ${(-driftPx).toFixed(1)}px), 0)`;
    });
    if (sourceAttached) {
      const radius = Math.max(width, height) * 0.09;
      const scale = (radius * 2) / 256;
      const driftPx = height * 0.08 * 1.3;
      sourceSprite.style.transform =
        `translate3d(${(source.x - radius).toFixed(1)}px, calc(${(source.y - radius).toFixed(1)}px - var(--scroll, 0) * ${driftPx.toFixed(1)}px), 0) scale(${scale.toFixed(4)})`;
    }
  };

  // Bake (only when the theme channel flips or the viewport height drifts) and
  // pin the CSS parallax. Called from the scroll handler on mobile instead of
  // scheduling a draw frame.
  const ensureLayers = () => {
    if (!paths.length) return; // background not built yet (deferred start)
    const palette = getPalette(); // snaps canvasThemeMix on compact
    const channel = Math.round(255 * (1 - canvasThemeMix));
    const stale =
      !layerStore.length ||
      channel !== layerChannel ||
      Math.abs(height - layerBaseHeight) > layerBaseHeight * 0.24;
    if (stale) {
      renderLayers(palette, channel); // → attachField (new layer elements)
      positionFieldCSS();
    }
  };

  const buildNetwork = () => {
    const compact = isCompactCanvas();
    const primaryCount = compact ? 14 : lowSpec ? 16 : 20;
    const branchPerPrimary = compact ? 3 : lowSpec ? 3 : 4;
    const microPerPrimary = compact ? 1 : 2;
    // Full height spread — nerves fan from top to bottom like the reference
    const seed = Math.round(width * 17 + height * 3 + (compact ? 1009 : 2003));
    randomValue = makeRandom(seed);
    networkWidth = width;
    networkHeight = height;
    networkMode = compact ? "compact" : "desktop";
    networkBuilds += 1;
    const originY = height * 0.5;
    const verticalSpan = height * (compact ? 3.35 : 3.6);

    paths = [];
    stars = [];
    source = { x: width * (compact ? 1.28 : 1.38), y: originY };

    for (let index = 0; index < primaryCount; index += 1) {
      const spread = (index / Math.max(1, primaryCount - 1) - 0.5) * verticalSpan;
      const endpoint = {
        x: compact ? randomBetween(-width * 0.24, width * 0.86) : randomBetween(-width * 0.22, width * 0.58),
        y: originY + spread + randomBetween(-height * 0.08, height * 0.08),
      };
      const start = {
        x: width * (compact ? randomBetween(0.96, 1.42) : randomBetween(1.12, 1.52)),
        y: originY + spread * randomBetween(0.08, 0.28) + randomBetween(-height * 0.18, height * 0.18),
      };
      const primary = makeJaggedPath(
        start,
        endpoint,
        Math.round(randomBetween(compact ? 6 : 9, compact ? 10 : 14)),
        { x: width * (compact ? 0.028 : 0.038), y: height * (compact ? 0.022 : 0.032) },
        randomBetween(-height * 0.06, height * 0.06)
      );
      // Thinner, finer primaries so the network recedes behind content
      const depth = randomBetween(0.82, 1);
      addPath(primary, "primary", depth, randomBetween(compact ? 1.2 : 1.3, compact ? 2.1 : 2.5), randomValue());
      addStar(choose(primary.slice(1, 3)), depth, randomBetween(compact ? 0.82 : 0.9, compact ? 1.35 : 1.6));
      if (!compact || index % 2 === 0) {
        addStar(choose(primary.slice(3, -2)), depth * 0.85, randomBetween(compact ? 0.42 : 0.5, compact ? 0.86 : 1.0));
      }

      for (let branch = 0; branch < branchPerPrimary; branch += 1) {
        // More branching near the source (right side) — higher anchorIndex = closer to start
        const anchorBias = randomValue() > 0.35 ? randomBetween(0.48, 0.94) : randomBetween(0.1, 0.55);
        const anchorIndex = Math.floor(anchorBias * (primary.length - 2)) + 1;
        const anchor = primary[Math.min(anchorIndex, primary.length - 2)];
        const side = randomValue() > 0.5 ? 1 : -1;
        const branchLength = randomBetween(width * 0.1, width * (compact ? 0.31 : 0.34)) * depth;
        const branchEnd = {
          x: anchor.x - branchLength * randomBetween(0.3, 0.9),
          y: anchor.y + side * branchLength * randomBetween(0.2, 0.7),
        };
        const branchPath = makeJaggedPath(
          anchor,
          branchEnd,
          Math.round(randomBetween(4, compact ? 8 : 9)),
          { x: width * 0.022, y: height * 0.02 }
        );
        const branchDepth = depth * randomBetween(0.52, 0.82);
        addPath(branchPath, "branch", branchDepth, randomBetween(0.68, compact ? 1.55 : 1.6), randomValue());

        // Stars at every branch junction
        addStar(anchor, branchDepth, randomBetween(0.5, compact ? 0.95 : 1.1));

        const twigCount = 2;
        for (let twig = 0; twig < twigCount; twig += 1) {
          const twigAnchor = choose(branchPath.slice(1, -1));
          const twigLength = branchLength * randomBetween(0.18, 0.42);
          const twigSide = randomValue() > 0.5 ? 1 : -1;
          const twigPath = makeJaggedPath(
            twigAnchor,
            {
              x: twigAnchor.x - twigLength * randomBetween(0.3, 0.85),
              y: twigAnchor.y + twigSide * twigLength * randomBetween(0.15, 0.55),
            },
            Math.round(randomBetween(3, 6)),
            { x: width * 0.014, y: height * 0.013 }
          );
          addPath(twigPath, "twig", branchDepth * 0.72, randomBetween(0.32, compact ? 0.74 : 0.82), randomValue());
          if (randomValue() > 0.38) {
            addStar(twigAnchor, branchDepth * 0.6, randomBetween(0.28, compact ? 0.5 : 0.7));
          }
        }
      }

      for (let micro = 0; micro < microPerPrimary; micro += 1) {
        const anchor = choose(primary.slice(1, -1));
        const length = randomBetween(width * 0.05, width * (compact ? 0.12 : 0.2));
        addPath(
          makeJaggedPath(
            anchor,
            {
              x: anchor.x + randomBetween(-length, length * 0.3),
              y: anchor.y + randomBetween(-length * 0.5, length * 0.5),
            },
            Math.round(randomBetween(3, 5)),
            { x: width * 0.01, y: height * 0.01 }
          ),
          "micro",
          depth * randomBetween(0.32, 0.58),
          randomBetween(0.18, compact ? 0.4 : 0.58),
          randomValue()
        );
      }
    }

    stars = stars
      .sort((a, b) => b.power - a.power)
      .slice(0, compact ? 30 : 42);
    // Live pulses ride the main trunks; everything else is baked into layers.
    // Compact keeps a sparse set (every 3rd primary); desktop lights more of
    // the denser network for a little extra life without re-stroking paths.
    pulsePaths = paths
      .filter((path) => path.kind === "primary")
      .filter((_, index) => index % (compact ? 3 : 2) === 0);
    layerChannel = -1;
    layerStore = [];
    networkSignature = `${networkMode}:${paths.length}:${stars.length}:${Math.round(source.x)}:${Math.round(source.y)}:${paths
      .slice(0, 8)
      .map((path) => `${path.kind}:${Math.round(path.points[0].x)},${Math.round(path.points[0].y)}`)
      .join("|")}`;
    writeProofState();
  };

  const draw = (time = performance.now(), force = false) => {
    animationFrame = 0;
    if (document.hidden && !force) {
      return;
    }
    if (!paths.length) {
      return; // background not built yet (deferred start)
    }

    const compact = isCompactCanvas();
    // Compact is driven entirely by CSS (no draw loop). If a frame was still
    // queued when the layout crossed into compact, bail to the CSS path.
    if (compact) {
      ensureLayers();
      return;
    }
    const active = !reducedMotion;
    // Responsive cadence while scrolling, calmer ambient cadence at rest.
    const recentlyActive = time < activeUntil || Math.abs(scrollVelocity) > 0.2;
    const frameGap = recentlyActive ? 50 : 84;
    lastFrameGap = frameGap;

    if (active && !force && time - lastFrameTime < frameGap) {
      requestNerveDraw(Math.max(16, frameGap - (time - lastFrameTime)));
      return;
    }

    lastFrameTime = time;
    drawCount += 1;

    const palette = getPalette();

    // The static network renders from pre-baked depth layers; each frame is a
    // few transform writes (parallax drift + velocity offset) with a handful
    // of live pulses stroked on the small overlay canvas.
    const channel = Math.round(255 * (1 - canvasThemeMix));
    // Desktop tint follows the page theme smoothly; quantize the re-bake
    // trigger so the layers don't re-render every frame through the crossover.
    const channelKey = Math.round(channel / 16) * 16;
    if (
      !layerStore.length ||
      channelKey !== layerChannel ||
      Math.abs(height - layerBaseHeight) > layerBaseHeight * 0.24
    ) {
      renderLayers(palette, channelKey);
    }

    const velocity = clamp(scrollVelocity, -150, 150);
    // The pulse overlay is the only surface we rasterize each frame now.
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";

    // Source glow — slide + scale the cached 256px sprite (compositor only).
    const sourcePulse = reducedMotion ? 1 : 0.94 + Math.sin(time * 0.002) * 0.06;
    const sourceX = source.x + Math.sin(time * 0.0008) * width * 0.006;
    const sourceY =
      source.y +
      Math.cos(time * 0.0007) * height * 0.018 -
      scrollProgress * height * 0.08 * 1.15;
    const sourceRadius = Math.max(width, height) * 0.13 * sourcePulse;
    if (sourceAttached) {
      const scale = (sourceRadius * 2) / 256;
      sourceSprite.style.transform = `translate3d(${(sourceX - sourceRadius).toFixed(2)}px, ${(sourceY - sourceRadius).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
    }

    // Depth layers — parallax drift + velocity offset + faint ambient wobble,
    // applied as a transform on the cached layer textures (GPU-composited).
    layerStore.forEach((layer, index) => {
      const drift = height * (0.1 + layer.rep * 0.24) * scrollProgress * 1.15;
      const ox =
        velocity * 0.014 * layer.rep +
        (reducedMotion ? 0 : Math.sin(time * 0.00042 + layer.seed * 9) * width * 0.003 * layer.rep);
      const oy = -drift + velocity * 0.018 * layer.rep;
      layer.offsetX = ox;
      layer.offsetY = oy;
      const el = layerEls[index];
      if (el) {
        el.style.transform = `translate3d(${ox.toFixed(2)}px, ${oy.toFixed(2)}px, 0)`;
        el.style.opacity = reducedMotion ? "1" : (0.9 + Math.sin(time * 0.0026 + layer.seed * 30) * 0.1).toFixed(3);
      }
    });

    if (active) {
      pulsePaths.forEach((path) => {
        const layer = layerStore[repIndex(path.depth)];
        const t = (time * 0.00012 * (1.2 + path.seed) + path.seed + scrollProgress * 0.69) % 1;
        context.save();
        context.translate(layer.offsetX, layer.offsetY);
        drawPulse(path.points, t, 0.12, 0.4, path.lineWidth + 0.8, palette);
        context.restore();
      });
    }

    scrollVelocity *= 0.72;

    // Ambient pulses keep running for a short grace period after the reader
    // stops, then the loop sleeps — re-woken by scroll / resize /
    // visibilitychange / pageshow via wakeCanvas(), so nothing is lost.
    const stillBusy = time < activeUntil || Math.abs(scrollVelocity) > 0.25;
    canvasIdleFrames = stillBusy ? 0 : canvasIdleFrames + 1;
    if (canvasIdleFrames < 90) {
      requestNerveDraw();
    }
  };

  requestNerveDraw = (delay = 0) => {
    if (animationFrame || frameTimer) return;

    if (delay > 0) {
      frameTimer = window.setTimeout(() => {
        frameTimer = 0;
        requestNerveDraw();
      }, delay);
      return;
    }

    animationFrame = window.requestAnimationFrame(draw);
  };

  const resize = (forceRebuild = false) => {
    const compact = isCompactCanvas();
    const nextWidth = window.innerWidth;
    const nextHeight = window.innerHeight;
    // DPR is capped at 1 on every device: the network is atmosphere behind
    // content, and a full-screen retina backing store is pure fill-rate cost.
    const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 1);
    const widthChanged = Math.abs(nextWidth - width) > 1;
    const pixelRatioChanged = Math.abs(nextPixelRatio - pixelRatio) > 0.01;
    const modeChanged = networkMode !== "" && networkMode !== (compact ? "compact" : "desktop");
    const shouldRebuild = forceRebuild || paths.length === 0 || widthChanged || pixelRatioChanged || modeChanged;

    pixelRatio = nextPixelRatio;
    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (shouldRebuild) {
      buildNetwork();
    }
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    if (frameTimer) {
      window.clearTimeout(frameTimer);
      frameTimer = 0;
    }
    writeProofState();
    if (compact) {
      // No draw loop on mobile — clear the (now-unused) pulse overlay in case
      // we just switched down from desktop, then pin the CSS parallax.
      context.clearRect(0, 0, width, height);
      ensureLayers();
      positionFieldCSS();
    } else {
      requestNerveDraw();
    }
  };

  const requestResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 140);
  };

  /* ----------------------------------------------------------------
     1.7 Deferred start + debug surface.
     The network build + first bake cost tens of milliseconds on a
     phone. Nothing above the fold depends on them (the CSS
     .background-field gradient covers the gap), so they wait for the
     browser's first idle slice instead of blocking first paint.
     ---------------------------------------------------------------- */
  const startBackground = () => {
    if (backgroundStarted) return;
    backgroundStarted = true;
    resize(true);
    window.addEventListener("resize", requestResize, { passive: true });
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(startBackground, { timeout: 600 });
  } else {
    window.setTimeout(startBackground, 80);
  }

  window.addEventListener("pageshow", () => wakeCanvas(260));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) wakeCanvas(520);
  });

  window.__nerveDebug = {
    snapshot: () => ({
      width,
      height,
      pixelRatio,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      pathCount: paths.length,
      starCount: stars.length,
      networkBuilds,
      networkSignature,
      networkWidth,
      networkHeight,
      networkMode,
      scrollProgress,
      drawCount,
      frameGap: lastFrameGap,
      layerCount: layerStore.length,
      active: performance.now() < activeUntil,
      reducedMotion,
      lowPower: lowPowerMotion,
      lowSpec,
      backgroundStarted,
      ready: bootDone,
      renderer: "canvas2d-prebaked-layers",
      themeIsLight,
      fx: () => (window.__nerveFx ? window.__nerveFx.snapshot() : null),
      canvasReady: true,
    }),
    // Dismiss the boot loader immediately (hidden-tab testing).
    finishBoot: markReady,
    // Force one frame even in a hidden/preview tab (rAF never fires there).
    renderOnce: () => {
      startBackground();
      activeUntil = performance.now() + 600;
      lastFrameTime = 0;
      draw(performance.now(), true);
    },
    // Run the scroll spine (theme + --scroll) synchronously — same story.
    syncScroll: () => {
      updateScroll();
    },
  };
})();

/* =====================================================================
   2. FX — scroll-motion coordinator.
   One rAF tick turns scroll position + velocity into CSS variables and
   class state; everything visual lives in CSS scoped under body.fx.

   Every layout shares section progress and choreography. Wide screens add
   a subtle velocity spring; compact screens keep the same progress mapping
   with compositor-safe transforms and no settle loop.

   Skipped entirely for reduced motion and the admin shell.
   ===================================================================== */
(function () {
  const root = document.documentElement;
  const body = document.body;
  if (body.classList.contains("admin-body")) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  body.classList.add("fx");

  try {
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const svgNS = "http://www.w3.org/2000/svg";

    const main = document.querySelector("main");
    const hero = document.querySelector(".hero");
    const heroTitle = document.querySelector(".hero h1");
    const manifesto = document.querySelector(".manifesto");
    const phrases = Array.from(document.querySelectorAll(".manifesto .phrase"));
    const polarizeEl = document.querySelector("[data-polarize]");
    const contactPanel = document.querySelector(".contact-panel");
    const messageCard = document.querySelector(".message-card");
    const whatsappButton = document.querySelector(".whatsapp-button");
    const siteFooter = document.querySelector(".site-footer");
    const wideLayout = window.matchMedia("(min-width: 961px)");
    const compactMotion = window.matchMedia("(max-width: 960px)");
    const motion = window.__nerveMotion;
    if (!main) return;
    if (!motion) return;

    /* --------------------------------------------------------------
       2.1 Hero — split-portal drift directions (consumed by CSS).
       -------------------------------------------------------------- */
    const splitWords = heroTitle ? Array.from(heroTitle.querySelectorAll("[data-split]")) : [];
    splitWords.forEach((word, index) => word.style.setProperty("--dir", index === 0 ? "-1" : "1"));

    /* --------------------------------------------------------------
       2.2 Manifesto — split copy into polarizer words.
       Every layout scrubs the same word-state band. State updates are
       bucketed so compact devices avoid redundant class churn.
       -------------------------------------------------------------- */
    const pwords = [];
    if (polarizeEl) {
      const words = polarizeEl.textContent.trim().split(/\s+/);
      polarizeEl.textContent = "";
      words.forEach((word, index) => {
        const span = document.createElement("span");
        span.className = "pword is-pending";
        span.dataset.state = "is-pending";
        span.style.setProperty("--wi", String(index));
        span.textContent = word;
        polarizeEl.appendChild(span);
        if (index < words.length - 1) polarizeEl.appendChild(document.createTextNode(" "));
        pwords.push(span);
      });
    }

    const makeFrameSvg = (className) => {
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", className);
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", "0.75");
      rect.setAttribute("y", "0.75");
      rect.setAttribute("width", "98.5");
      rect.setAttribute("height", "98.5");
      rect.setAttribute("pathLength", "100");
      svg.appendChild(rect);
      return svg;
    };

    /* --------------------------------------------------------------
       2.3 Contact — replayable copy entrance + card transmission.
       The number scramble is one cancellable rAF pass, not intervals.
       -------------------------------------------------------------- */
    let transmissionDone = false;
    let transmissionRaf = 0;
    let transmissionTimer = 0;
    let transmissionAckTimer = 0;
    let transmissionRun = 0;
    if (messageCard) {
      messageCard.setAttribute("aria-label", `Send the brief on WhatsApp, ${messageCard.querySelector("strong") ? messageCard.querySelector("strong").textContent.trim() : ""}`);
      messageCard.appendChild(makeFrameSvg("card-trace"));
      const strong = messageCard.querySelector("strong");
      if (strong) {
        const chars = strong.textContent.trim().split("");
        strong.textContent = "";
        chars.forEach((ch) => {
          if (ch === " ") {
            strong.appendChild(document.createTextNode(" "));
            return;
          }
          const span = document.createElement("span");
          const isDigit = /\d/.test(ch);
          span.className = isDigit ? "tx-char tx-digit" : "tx-char is-locked";
          span.dataset.final = ch;
          span.textContent = isDigit ? "0" : ch;
          strong.appendChild(span);
        });
      }
    }

    const runTransmission = () => {
      if (!messageCard) return;
      const run = ++transmissionRun;
      transmissionDone = true;
      const digits = Array.from(messageCard.querySelectorAll(".tx-digit"));
      const finish = () => {
        if (run !== transmissionRun) return;
        digits.forEach((span) => {
          span.textContent = span.dataset.final;
          span.classList.add("is-locked");
        });
        if (whatsappButton) {
          window.clearTimeout(transmissionAckTimer);
          whatsappButton.classList.add("is-ack");
          transmissionAckTimer = window.setTimeout(() => {
            whatsappButton.classList.remove("is-ack");
            transmissionAckTimer = 0;
          }, 2600);
        }
      };
      if (!digits.length) {
        finish();
        return;
      }
      const duration = 1280;
      const start = performance.now();
      let lastShuffle = 0;
      const step = (now) => {
        if (run !== transmissionRun) return;
        const progress = clamp((now - start) / duration, 0, 1);
        const lockCount = Math.floor(progress * digits.length);
        const shuffle = now - lastShuffle > 52;
        if (shuffle) lastShuffle = now;
        digits.forEach((span, index) => {
          if (index < lockCount) {
            if (!span.classList.contains("is-locked")) {
              span.textContent = span.dataset.final;
              span.classList.add("is-locked");
            }
          } else if (shuffle) {
            span.textContent = String(Math.floor(Math.random() * 10));
          }
        });
        if (progress < 1) {
          transmissionRaf = window.requestAnimationFrame(step);
        } else {
          transmissionRaf = 0;
          finish();
        }
      };
      transmissionRaf = window.requestAnimationFrame(step);
    };

    const resetTransmission = () => {
      transmissionRun += 1;
      transmissionDone = false;
      window.clearTimeout(transmissionTimer);
      transmissionTimer = 0;
      window.clearTimeout(transmissionAckTimer);
      transmissionAckTimer = 0;
      if (transmissionRaf) {
        window.cancelAnimationFrame(transmissionRaf);
        transmissionRaf = 0;
      }
      if (whatsappButton) whatsappButton.classList.remove("is-ack");
      if (!messageCard) return;
      messageCard.classList.remove("is-built");
      messageCard.querySelectorAll(".tx-digit").forEach((span) => {
        span.textContent = "0";
        span.classList.remove("is-locked");
      });
    };

    let contactActive = false;
    const setContactActive = (active) => {
      if (!contactPanel || !messageCard || active === contactActive) return;
      contactActive = active;
      contactPanel.classList.toggle("is-contact-live", active);
      if (active) {
        messageCard.classList.add("is-built");
        transmissionTimer = window.setTimeout(runTransmission, 700);
      } else {
        resetTransmission();
      }
    };

    /* --------------------------------------------------------------
       2.5 Services - one scroll-linked reel across all layouts.
       Compact uses the same continuous transform with lighter row content.
       -------------------------------------------------------------- */
    const servicesSection = document.querySelector(".services");
    const servicesPinEl = document.querySelector("[data-services-pin]");
    const servicesDisplay = document.querySelector("[data-services-display]");
    const servicesCount = document.querySelector("[data-services-count]");
    const servicesList = document.querySelector("[data-services-list]");
    const serviceItems = servicesList ? Array.from(servicesList.querySelectorAll("[data-service-item]")) : [];
    if (servicesSection) servicesSection.classList.add("is-pinned");

    let servicesActive = -1;
    let servicesProgress = 0;
    let polarizerBandKey = -1;
    const elementVarCache = new WeakMap();

    const setElementVar = (element, name, value) => {
      if (!element) return;
      let cache = elementVarCache.get(element);
      if (!cache) {
        cache = {};
        elementVarCache.set(element, cache);
      }
      if (cache[name] === value) return;
      cache[name] = value;
      element.style.setProperty(name, value);
    };

    const updateServices = (scrollY, vh) => {
      if (!servicesSection || !servicesPinEl || !servicesDisplay || !serviceItems.length) return;

      const top = servicesPinTop - scrollY;
      const span = Math.max(1, svcPinHeight - vh);
      const progress = clamp(-top / span, 0, 1);
      const wordProgress = progress * (serviceItems.length - 1);
      const active = Math.min(serviceItems.length - 1, Math.round(wordProgress));
      servicesProgress = wordProgress;
      setElementVar(servicesSection, "--section-p", progress.toFixed(3));
      setElementVar(servicesDisplay, "--service-p", wordProgress.toFixed(3));
      setElementVar(servicesDisplay, "--service-index", String(active));

      if (active !== servicesActive) {
        servicesActive = active;
        serviceItems.forEach((item, index) => {
          item.classList.toggle("is-active", index === active);
          item.classList.toggle("is-before", index < active);
          item.classList.toggle("is-after", index > active);
        });
      }

      if (servicesCount && active >= 0) {
        const nextCount = String(active + 1).padStart(2, "0");
        if (servicesCount.textContent === nextCount) return;
        servicesCount.textContent = nextCount;
        servicesCount.animate(
          [
            { opacity: 0.2, transform: "translateY(28%)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 300, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        );
      }
    };

    /* --------------------------------------------------------------
       2.6 Cached layout geometry.
       The pinned controllers used to read offsetLeft/Top/Width/Height
       every scroll frame, right after writing styles in the same
       frame — forcing a synchronous reflow each time. This geometry
       only changes on resize / breakpoint cross, so measure it once
       and reuse it during scroll.
       -------------------------------------------------------------- */
    let svcPinHeight = 0;
    let servicesPinTop = 0;
    let heroHeight = 1;
    let heroTop = 0;
    let fxMaxScroll = 1;
    let manifestoTop = 0;
    let manifestoHeight = 0;
    let polarizeTop = 0;
    let contactTop = 0;
    let contactHeight = 0;
    let phraseTravel = 72;
    let phraseTops = phrases.map(() => 0);

    const measureElement = (element) => {
      if (!element) return { top: 0, height: 0 };
      const rect = element.getBoundingClientRect();
      return { top: rect.top + window.scrollY, height: rect.height };
    };

    const sectionProgress = (top, height, scrollY, viewportHeight, power = 1) => {
      const startLine = viewportHeight * 0.9;
      const endLine = viewportHeight * 0.16;
      const distance = Math.max(1, height + startLine - endLine);
      return clamp(((scrollY + startLine - top) / distance) * power, 0, 1);
    };

    const measureGeom = () => {
      servicesActive = -1;
      const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      fxMaxScroll = Math.max(1, root.scrollHeight - viewportHeight);
      if (servicesPinEl) {
        const servicesGeom = measureElement(servicesPinEl);
        svcPinHeight = servicesGeom.height;
        servicesPinTop = servicesGeom.top;
      }
      if (hero) {
        const heroGeom = measureElement(hero);
        heroTop = heroGeom.top;
        heroHeight = heroGeom.height;
      }
      if (manifesto) {
        const manifestoGeom = measureElement(manifesto);
        manifestoTop = manifestoGeom.top;
        manifestoHeight = manifestoGeom.height;
      }
      phraseTops = phrases.map((phrase) => measureElement(phrase).top);
      if (polarizeEl) polarizeTop = measureElement(polarizeEl).top;
      if (contactPanel) {
        const contactGeom = measureElement(contactPanel);
        contactTop = contactGeom.top;
        contactHeight = contactGeom.height;
      }
      phraseTravel = compactMotion.matches
        ? clamp(window.innerWidth * 0.13, 42, 62)
        : clamp(window.innerWidth * 0.063, 32, 84);
      layoutDirty = true;
    };

    /* --------------------------------------------------------------
       2.7 Shared progress tick. Wide layouts add a small velocity spring;
       compact layouts use the same section progress without that spring.
       -------------------------------------------------------------- */
    let velocity = 0;
    let servo = 0;
    let servoVel = 0;
    let lastTime = performance.now();
    let layoutDirty = true;

    // --hero-p is consumed only inside .hero, so it lives on the hero
    // element — writing it there invalidates one subtree, not the document.
    const setHeroP = (value) => {
      setElementVar(hero, "--hero-p", value);
    };

    let lastMeasureVersion = -1;
    const tick = (frameState = {}) => {
      const time = frameState.time || performance.now();
      const dt = clamp((time - lastTime) / 16.67, 0.25, 3);
      lastTime = time;
      const scrollY = frameState.scrollY === undefined ? window.scrollY : frameState.scrollY;
      const vh =
        frameState.viewportHeight ||
        (window.visualViewport ? window.visualViewport.height : window.innerHeight);
      const dy = frameState.deltaY || 0;
      const compact = compactMotion.matches;
      if (frameState.measureVersion !== undefined && frameState.measureVersion !== lastMeasureVersion) {
        lastMeasureVersion = frameState.measureVersion;
        layoutDirty = true;
      }
      const updateLayout = layoutDirty || dy !== 0;
      layoutDirty = false;

      const motionPower = compact ? 1.3 : 1.15;
      const keep = Math.pow(compact ? 0.76 : 0.82, dt);
      velocity = compact ? dy : velocity * keep + dy * (1 - keep);

      const pageProgress = clamp(scrollY / fxMaxScroll, 0, 1);
      const endP = clamp((pageProgress - 0.92) / 0.08, 0, 1);
      const damp = 1 - endP * 0.85;
      const servoLimit = compact ? 13 : 18;
      const servoTarget = clamp(velocity * 0.16 * motionPower, -servoLimit, servoLimit) * damp;
      if (compact) {
        servo = servoTarget;
        servoVel = 0;
      } else {
        servoVel += (servoTarget - servo) * 0.16 * dt;
        servoVel *= Math.pow(0.86, dt);
        servo += servoVel * dt;
      }

      setElementVar(hero, "--servo", servo.toFixed(2));
      setElementVar(siteFooter, "--servo", servo.toFixed(2));
      setElementVar(siteFooter, "--endp", endP.toFixed(3));

      if (updateLayout) {
        if (hero) {
          const heroP = clamp((scrollY - heroTop) / Math.max(1, (heroHeight * 0.85) / motionPower), 0, 1);
          setHeroP(heroP.toFixed(3));
          setElementVar(hero, "--section-p", heroP.toFixed(3));
        }

        updateServices(scrollY, vh);

        if (manifesto) {
          const manifestoP = sectionProgress(manifestoTop, manifestoHeight, scrollY, vh, motionPower);
          setElementVar(manifesto, "--section-p", manifestoP.toFixed(3));
          phrases.forEach((phrase, index) => {
            const raw = clamp(
              (scrollY + vh * 0.92 - phraseTops[index]) / Math.max(1, (vh * 0.42) / motionPower),
              0,
              1
            );
            const eased = raw * (2 - raw);
            const dir = phrase.dataset.dir === "right" ? 1 : -1;
            setElementVar(phrase, "--po", eased.toFixed(3));
            setElementVar(phrase, "--px", `${((1 - eased) * dir * phraseTravel).toFixed(1)}px`);
          });
          if (polarizeEl && pwords.length) {
            const sp = clamp(
              (scrollY + vh * 0.94 - polarizeTop) / Math.max(1, (vh * 0.52) / motionPower),
              0,
              1
            );
            const band = sp * (pwords.length + 4) - 2;
            const bandKey = Math.round(band * 3);
            if (bandKey !== polarizerBandKey) {
              polarizerBandKey = bandKey;
              pwords.forEach((word, index) => {
                const state =
                  index < band - 1.4 ? "is-locked" : Math.abs(index - band) <= 1.4 ? "is-live" : "is-pending";
                if (word.dataset.state === state) return;
                word.dataset.state = state;
                word.classList.remove("is-locked", "is-live", "is-pending");
                word.classList.add(state);
              });
            }
          }
        }

        if (contactPanel) {
          const contactP = sectionProgress(contactTop, contactHeight, scrollY, vh, motionPower);
          const contactBottom = contactTop + contactHeight;
          const contactEntering =
            scrollY + vh * 0.88 >= contactTop &&
            scrollY + vh * 0.12 <= contactBottom;
          const contactNearby =
            scrollY + vh * 0.98 >= contactTop &&
            scrollY <= contactBottom;
          setElementVar(contactPanel, "--section-p", contactP.toFixed(3));
          if (contactActive ? !contactNearby : contactEntering) {
            setContactActive(!contactActive);
          }
        }
      }

      const busy =
        Math.abs(velocity) > 0.05 ||
        Math.abs(servo) > 0.1 ||
        Math.abs(servoVel) > 0.05;
      return !compact && busy;
    };

    motion.subscribe(tick, measureGeom);

    /* --------------------------------------------------------------
       2.8 Debug surface (window.__nerveFx) — also lets a hidden tab
       pump the tick manually, since rAF never fires there.
       -------------------------------------------------------------- */
    window.__nerveFx = {
      pump: () =>
        tick({
          time: performance.now(),
          scrollY: window.scrollY,
          viewportHeight: window.visualViewport ? window.visualViewport.height : window.innerHeight,
          deltaY: 0,
          measureVersion: lastMeasureVersion,
        }),
      remeasure: () => motion.remeasure(),
      snapshot: () => ({
        compact: compactMotion.matches,
        wide: wideLayout.matches,
        rafActive: motion.snapshot().framePending,
        velocity,
        servo,
        servicesActive,
        servicesProgress,
        transmissionDone,
        pwordCount: pwords.length,
        contactActive,
      }),
    };
  } catch (error) {
    body.classList.remove("fx");
    throw error;
  }
})();
