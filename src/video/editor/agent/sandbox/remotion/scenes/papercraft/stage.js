// from github.com/xikhar/papercraft stage.js (MIT; see LICENSE)
// papercraft / stage.js — the harness of templates/popup-3d/harness.js (github.com/xikhar/papercraft, MIT, see LICENSE),
// adapted for video: drawn on a given canvas at the video's size, no input, no walking, no sound, no real-time loop.
// The video's frame drives it: seek(seconds) replays the fixed 60 Hz clock from t = 0 (restart) or steps forward, then
// renders, so the preview and the export show the same image. Use it through PaperStage (../paper.tsx).
import * as THREE from 'three';
import * as P2 from './lib/paperkit-2d.js';
import { paperTextures, paperMaterial, makeCard, crossCard, WalkField, fitShadow, hinge, paperLights, enableSoftShadows, PaperPost, PAPER_LIGHT } from './lib/paperkit-3d.js';
import { windSway } from './lib/paper-motion.js';
import LIGHTS from './lights.json';

/** Measured light sets of the example world. The prints never change: only light, shadow tint, haze and grade. Night
 *  keeps every piece readable in its own printed colours under an even pale-blue moon (warm windows and lamp pools
 *  carry the warmth), navy only far away and in the deep shadows. Their haze, vignette and shadow-tint colours are the
 *  example's distance: give your world its own (references/three-js.md section 1). */
export const MOODS = {
  golden: { key: '#ffc890', ki: 3.4, dir: [-0.85, 0.52, 0.5], fill: '#b9bcd8', fi: 0.8, sky: '#ffe6c8', skyG: '#8a7a70', si: 0.4, leak: '#8f5034',
    post: { exposure: 0.86, tint: [1.02, 0.99, 0.98], saturation: 1.0, haze: '#e6c08a' } },
  dusk: { key: '#ffb38a', ki: 3.2, dir: [-0.866, 0.45, 0.5], fill: '#6f63a8', fi: 1.3, sky: '#a898d0', skyG: '#5a4a78', si: 1.0, leak: '#6a4a8a', glow: 1.1, lamp: 6,
    post: { exposure: 1.0, tint: [1.02, 0.97, 1.0], saturation: 0.95, haze: '#c98fa0', hazeStart: 24, hazeEnd: 80, hazeAmount: 0.4, vignette: 0.12, vignetteColor: '#1a1430', shadowTint: '#1e2050' } },
  night: { key: '#c8d6ff', ki: 1.6, fill: '#7890d0', fi: 0.7, sky: '#3a56b0', skyG: '#22243a', si: 0.85, leak: '#26368a', wrap: 0.4, glow: 1.4, lamp: 4.5,
    post: { exposure: 0.95, tint: [0.98, 0.98, 1.03], saturation: 1.12, haze: '#0e1a44', hazeStart: 14, hazeEnd: 55, hazeAmount: 0.9, vignette: 0.12, vignetteColor: '#0a0c24', shadowTint: '#141c48', shadowLift: 0.04 } },
};

/**
 * createHarness(options) -> H. Options (all optional): bounds { x0, x1, z0, z1 } of the printed ground sheet in world
 * units (1 unit ~ 1 cm of card; the hero ~3.6), ground (your world's plain ground colour under and beyond the print:
 * set it), stock (the paper colour multiplied under every print and the ground; default cream; a cold world takes a
 * cooler one, ~'#eef1f6', look.md section 8b), view { pitch, dist,
 * target, fov, follow: [dx, dz] } (follow: where the walking camera looks, relative to the hero, x dist / 66: the
 * default [-9.3, -9] keeps him in the lower right, so lay walks out going up and left), testView { dist, target }
 * (?test), heroHeight, light (paperLights options + leak, softness, maxPenumbra), lens (PaperPost options), walk
 * { step, radius }, moods (light sets by name), play (true: WASD / arrows walk the hero without ?walk; ?still turns
 * it off), focus ([x, y, z]: where the lens focuses until the hero first moves, e.g. a landmark he starts in front of;
 * default the hero; it eases to him on his first step), mood ('golden' | 'dusk' | 'night' | a key of moods: the world's
 * own light; ?mood= overrides it), walkArea { x0, x1, z0, z1 } (where he may walk: the walking camera goes only as far
 * as framing him there needs, and inReach(x, z) says what any of those framings can show: fill with it), camBox
 * { x0, x1, z0, z1 } (hold the camera's target in your own box instead: a single diorama the camera barely leaves).
 * H.onStep(fn): fn(time, dt) every fixed step (fireflies, flicker, a turning wheel): animate on the harness clock.
 * H.onRestart(fn): fn() on restart(), so seeded extras replay too (paper-life: H.onRestart(() => life.reset(H.target))).
 * The hero is a page-level popup (no parent). Anywhere he stands, on the page or on a deck, he rides whatever is under
 * him as the world rises, until he first moves. The camera follows him only once he has moved.
 * H: THREE, flags { TEST, MOOD, WALK, ROAM, DIAG }, renderer, scene, camera, paper, view, target, walk (WalkField),
 * hinges, spots (your named places, for captures), printGround(draw), popup(pts, paint, opts), printed(pts, paint) (one
 * print stamped on many cards: popup's `materials`), stack, dome, cardOpts, groundAt(sx, sy), onStep, onRestart,
 * inFrame(x, z) (the overview), inReach(x, z) (anything the walking camera can show: fill with this),
 * sharpAt(x, z), lamp(x, y, z, k), glowing(group), setHero(handle, { stride, turn }), start(). The hero is a 3D paper
 * model facing +z: walking accelerates at a constant rate, the HEADING turns smoothly toward the way he goes (the whole
 * model yaws: it reads from every side), he leans forward on a springy settle and rolls into turns. stride(walked,
 * gait) is called every frame with the distance walked and the walking amount (0 standing .. 1 striding): swing the
 * limbs there. turn: 'yaw' (default) or 'flip' (a flat card that mirrors to face left / right: critters, extras).
 */
export function createStage({ canvas, width = 1920, height = 1080, ss = 1, test = false, bounds = { x0: -64, x1: 64, z0: -62, z1: 38 }, ground = '#d9d2c2', view: view0 = {}, testView = { dist: 38, target: [3, 1.5, -6] },
  heroHeight = 3.6, light = {}, lens = {}, walk: walkOpts = { step: 0.75, radius: 0.6 }, moods = MOODS, focus = null, mood = null, stock = '#f7f0e2', walkArea = null, camBox = null } = {}) {
  const flags = { TEST: test, MOOD: mood || 'day', WALK: false, ROAM: false, DIAG: null };

  // ---- renderer, camera, paper -----------------------------------------------------------------------------------
  // preserveDrawingBuffer: the export grabs the canvas after the render; ss = 2 supersamples (smoother cut edges, 4x the work)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(ss);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;     // the PCSS patch reads raw depth
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(ground);
  const view = { yaw: 0, pitch: 47, dist: 66, fov: 26, ...view0 };
  view.tyaw = view.yaw; view.tpitch = view.pitch;
  const target = new THREE.Vector3(...(view0.target || [2, 1.5, -6]));
  if (flags.TEST) { view.dist = testView.dist; target.set(...testView.target); }   // close enough to judge edges, fibre, shadows, blur
  const camera = new THREE.PerspectiveCamera(view.fov, width / height, 5, 600);
  // the paper stock under every print and the ground: warm cream by default; a cold world (snow, ice, a pale station)
  // takes a cooler stock (~'#eef1f6'), or the multiplied cream warms its whites to beige
  const paper = paperTextures(renderer, { color: stock, seed: 4, unitsPerTile: 5, fibres: 1.5, mottle: 0.08, normalStrength: 3 });
  function placeCamera(yawDeg, pitchDeg) {
    const yaw = THREE.MathUtils.degToRad(yawDeg), pit = THREE.MathUtils.degToRad(pitchDeg);
    camera.position.set(target.x + Math.sin(yaw) * Math.cos(pit) * view.dist, target.y + Math.sin(pit) * view.dist, target.z + Math.cos(yaw) * Math.cos(pit) * view.dist);
    camera.lookAt(target);
  }
  placeCamera(view.yaw, view.pitch); camera.updateMatrixWorld();
  const _v = new THREE.Vector3();
  /** Is (x, z) in the frame (with margin m, at height y)? Fill only where the camera can see. */
  /** The point on the page (y = 0) under screen position (sx, sy) in -1..1 (sy = 1 the top edge), in the overview
   *  camera: e.g. groundAt(0, 0.95) is where the far edge of the frame meets the page (place backdrops just inside it). */
  const _ray = new THREE.Raycaster(), _pl = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const groundAt = (sx, sy) => { camera.updateMatrixWorld(); _ray.setFromCamera({ x: sx, y: sy }, camera); const p = new THREE.Vector3(); return _ray.ray.intersectPlane(_pl, p) ? p : null; };
  const inFrame = (x, z, m = 0.12, y = 1) => { _v.set(x, y, z).project(camera); return Math.abs(_v.x) < 1 + 2 * m && _v.y > -1 - m && _v.y < 1 + m; };
  /** Inside the lens's sharp-to-mid band at the starting view (the far top rows and the big near cards are blurred). */
  const sharpAt = (x, z, y = 1) => { _v.set(x, y, z).project(camera); return _v.y > -0.95 && _v.y < 0.7; };
  // walkArea { x0, x1, z0, z1 }: where the hero may walk. The walking camera then goes only as far as framing him there
  // needs (its target is held inside), and inReach(x, z) says whether ANY of those framings can show (x, z): fill with
  // it, not inFrame, or the walk finds bare page past the overview. camBox { x0, x1, z0, z1 }: hold the camera's target
  // in a box of your own instead (a single diorama: a few units round the overview target, the hero walking inside the
  // frame). Without either, inReach is inFrame and nothing is held.
  const FOLLOW = view.follow || [-9.3, -9];
  const reachR = (camBox || walkArea) && (() => { const kd = view.dist / 66;
    const R = camBox || { x0: walkArea.x0 + FOLLOW[0] * kd, x1: walkArea.x1 + FOLLOW[0] * kd, z0: walkArea.z0 + FOLLOW[1] * kd, z1: walkArea.z1 + FOLLOW[1] * kd };
    return { x0: Math.min(R.x0, target.x), x1: Math.max(R.x1, target.x), z0: Math.min(R.z0, target.z), z1: Math.max(R.z1, target.z) }; })();
  const inReach = (x, z, m = 0.12, y = 1) => {
    if (!reachR) return inFrame(x, z, m, y);
    const nx = Math.max(1, Math.ceil((reachR.x1 - reachR.x0) / 6)), nz = Math.max(1, Math.ceil((reachR.z1 - reachR.z0) / 6));
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++)   // the frame moved to each camera target the walk allows
      if (inFrame(x - (reachR.x0 + (reachR.x1 - reachR.x0) * i / nx - target.x), z - (reachR.z0 + (reachR.z1 - reachR.z0) * j / nz - target.z), m, y)) return true;
    return false;
  };

  // ---- the printed ground: one continuous sheet, far bigger than the frame ----------------------------------------
  /**
   * printGround(draw, { ppu }): draw(t) paints the ground sheet with the tools t = { g (2D context, pixel units), W, H,
   * ppu, X(x), Z(z) (world -> sheet px), rnd, washes(colours) (three scales of watercolour blotches with wet edges),
   * torn(pts, fill, fringe) (a torn-paper region: never an airbrushed band), band(fx, half, z0, z1) (a ribbon along
   * x = fx(z) as a polygon for torn), ribbon(fx, w, colour, z0, z1, wobble), bandOf(pts, half) and line(pts, w, colour)
   * (the same along any polyline, e.g. P2.pathLine(ctrl).pts: across the view too), drifts(fn, { n, inside }) (marks gathered
   * in drifts: fn(px, py) at clustered sheet positions) }. Then the paper is multiplied in and the sheet laid down.
   */
  function printGround(draw, { ppu = 22, seed = 20 } = {}) {
    const G = bounds, W = (G.x1 - G.x0) * ppu, H = (G.z1 - G.z0) * ppu, rnd = P2.rng(seed);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const X = (x) => (x - G.x0) * ppu, Z = (z) => (z - G.z0) * ppu;
    g.fillStyle = ground; g.fillRect(0, 0, W, H);
    const washes = (cols, { scales = [[60, 180, 460, 0.3], [200, 50, 150, 0.2], [700, 10, 34, 0.12]] } = {}) => {
      for (const [n, r0, r1, a] of scales) for (let i = 0; i < n; i++) {
        const x = rnd() * W, y = rnd() * H, r = r0 + rnd() * (r1 - r0), col = cols[Math.floor(rnd() * cols.length)];
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, P2.rgba(col, a * 0.6)); gr.addColorStop(0.78, P2.rgba(col, a)); gr.addColorStop(0.9, P2.rgba(P2.shade(col, -0.15), a * 1.2)); gr.addColorStop(1, P2.rgba(col, 0));
        g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    };
    const torn = (pts, fill, fringe = 'rgba(255,248,230,0.7)') => {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length], L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / 0.18));
        for (let k = 0; k < n; k++) { const t = k / n, j = (rnd() - 0.5) * 0.12 + Math.sin((x0 + z0 + t * L) * 1.7) * 0.05; out.push([x0 + (x1 - x0) * t + j, z0 + (z1 - z0) * t + j]); }
      }
      g.beginPath(); out.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)))); g.closePath();
      g.fillStyle = fill; g.fill(); g.strokeStyle = fringe; g.lineWidth = 0.15 * ppu; g.stroke();   // the torn paper's white fibrous edge, ~2-4 px on screen
    };
    const band = (fx, half, z0 = G.z0, z1 = G.z1) => {
      const L = [], R = [];
      for (let z = z0; z <= z1; z += 0.4) { const w = half(z), dx = fx(z + 0.2) - fx(z - 0.2), n = Math.hypot(dx, 0.4); L.push([fx(z) - w * 0.4 / n, z + w * dx / n]); R.push([fx(z) + w * 0.4 / n, z - w * dx / n]); }
      return [...L, ...R.reverse()];
    };
    const ribbon = (fx, w, col, z0 = G.z0, z1 = G.z1, wob = 0) => {
      g.strokeStyle = col; g.lineWidth = w * ppu; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath();
      for (let z = z0; z <= z1; z += 0.5) (z === z0 ? g.moveTo : g.lineTo).call(g, X(fx(z) + wob * (Math.sin(z * 1.1 + w) * 0.6 + Math.sin(z * 2.7) * 0.4)), Z(z));
      g.stroke();
    };
    // bandOf(pts, half): a polygon around a polyline [[x, z], ...] (e.g. P2.pathLine(ctrl).pts) for torn(): paths and
    // rivers that run in any direction, across the view too; line(pts, w, colour): a stroke along one
    const bandOf = (pts, half) => {
      const Lf = [], Rt = [];
      pts.forEach(([x, z], i) => {
        const [ax, az] = pts[Math.max(0, i - 1)], [bx, bz] = pts[Math.min(pts.length - 1, i + 1)], tx = bx - ax, tz = bz - az, n = Math.hypot(tx, tz) || 1;
        const w = typeof half === 'function' ? half(i / Math.max(1, pts.length - 1)) : half;
        Lf.push([x - tz / n * w, z + tx / n * w]); Rt.push([x + tz / n * w, z - tx / n * w]);
      });
      return [...Lf, ...Rt.reverse()];
    };
    // water(pts, opts): ANY water body printed into the page (references/structures.md, printed): a pond or a lake (a
    // closed outline), a river or a canal (bandOf(line, half)), a sea edge (a big outline past the frame), a pool or a
    // fountain basin (edge 'cut': a crisp built lip), a frozen pond (marks 'cracks'). Layers: a rim (pale torn bank or
    // the lip), the water, a deeper middle, marks (ripples along `flow`, or cracks), an optional foam line just inside
    // the shore. rimPts / deepPts override the rim and the deep part (a river: bandOf(line, half * 1.2) / half * 0.5).
    // Returns inside(x, z) for walk.block.
    // only when the brief has water; colors and rim are YOURS (the defaults are a plain grey-blue placeholder)
    const water = (pts, { colors = ['#8fa7ad', '#6d8a92'], rim = '#e8e2d4', rimPts = null, deepPts = null, edge = 'torn', inset = 0.62,
      marks = 'ripples', markColor = 'rgba(250,244,228,0.8)', flow = 0, foam = null, density = 1 } = {}) => {
      let cxw = 0, czw = 0; for (const [x, z] of pts) { cxw += x / pts.length; czw += z / pts.length; }
      const about = (k) => pts.map(([x, z]) => [cxw + (x - cxw) * k, czw + (z - czw) * k]);
      const inside = (x, z, poly = pts) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
      const fill = (poly, col) => {
        if (edge === 'torn') { torn(poly, col); return; }
        g.fillStyle = col; g.beginPath(); poly.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)))); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(40,28,18,0.35)'; g.lineWidth = 0.06 * ppu; g.stroke();   // a cut edge: a thin dark lip
      };
      if (rim) fill(rimPts || about(1.07), rim);
      fill(pts, colors[0]);
      if (colors[1]) fill(deepPts || about(inset), P2.rgba(colors[1], 0.55));
      let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (const [x, z] of pts) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
      const area = (bx1 - bx0) * (bz1 - bz0), N = Math.round(area * 0.35 * density);
      g.lineCap = 'round';
      for (let k = 0; k < N && marks !== 'none'; k++) {
        const x = bx0 + rnd() * (bx1 - bx0), z = bz0 + rnd() * (bz1 - bz0);
        if (!inside(x, z) || (rim && !inside(x, z, about(0.9)) && !rimPts)) continue;
        g.strokeStyle = markColor; g.lineWidth = (marks === 'cracks' ? 0.05 : 0.11) * ppu; g.beginPath();
        if (marks === 'cracks') { let px = x, pz = z; g.moveTo(X(px), Z(pz)); for (let s = 0; s < 4; s++) { px += (rnd() - 0.5) * 1.6; pz += (rnd() - 0.5) * 1.6; g.lineTo(X(px), Z(pz)); } }
        else { const a = flow + (rnd() - 0.5) * 0.5, l = 0.5 + rnd() * 1.1; g.moveTo(X(x - Math.cos(a) * l / 2), Z(z - Math.sin(a) * l / 2)); g.lineTo(X(x + Math.cos(a) * l / 2), Z(z + Math.sin(a) * l / 2)); }
        g.stroke();
      }
      if (foam) {   // a broken pale line just inside the shore (a sea, a lake in wind)
        g.strokeStyle = foam; g.lineWidth = 0.14 * ppu; g.setLineDash([0.9 * ppu, 0.6 * ppu]); g.beginPath();
        about(0.96).forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)))); g.closePath(); g.stroke(); g.setLineDash([]);
      }
      return (x, z) => inside(x, z);
    };
    const line = (pts, w, col) => { g.strokeStyle = col; g.lineWidth = w * ppu; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z)))); g.stroke(); };
    const drifts = (fn, { n = 9000, inside = 0.5, outside = 0.005, threshold = 0.68 } = {}) => {   // sparse and clustered: an even sprinkle reads as a stamp
      const mask = P2.tileNoise(256, 9, rnd), at = (x, y) => mask[(Math.floor(y / H * 256) & 255) * 256 + (Math.floor(x / W * 256) & 255)];
      for (let k = 0; k < n; k++) { const x = rnd() * W, y = rnd() * H; if (rnd() > (at(x, y) > threshold ? inside : outside)) continue; fn(x, y); }
    };
    draw({ g, W, H, ppu, X, Z, rnd, washes, torn, band, ribbon, bandOf, line, drifts, water });
    g.globalCompositeOperation = 'multiply'; g.fillStyle = g.createPattern(paper.sheet, 'repeat'); g.fillRect(0, 0, W, H); // the paper shows through
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mat = paperMaterial({ map: tex, normalMap: paper.normalMap.clone(), normalScale: 0.9 });
    mat.normalMap.repeat.set((G.x1 - G.x0) / 5, (G.z1 - G.z0) / 5); mat.normalMap.needsUpdate = true;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(G.x1 - G.x0, G.z1 - G.z0), mat);
    sheet.rotation.x = -Math.PI / 2; sheet.position.set((G.x0 + G.x1) / 2, 0, (G.z0 + G.z1) / 2); sheet.receiveShadow = true;
    const farMap = paper.map.clone(); farMap.repeat.set(160, 160); farMap.needsUpdate = true; // plain card beyond the print
    const beyond = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), paperMaterial({ color: ground, map: farMap }));
    beyond.rotation.x = -Math.PI / 2; beyond.position.y = -0.02; beyond.receiveShadow = true;
    scene.add(sheet, beyond);
    return sheet;
  }

  // ---- placement: every piece is a printed card (or a construction) on a hinge -------------------------------------
  const hinges = [], walk = new WalkField(walkOpts), spots = {}, lamps = [], glowers = [];
  if (walkArea) walk.block((x, z) => x < walkArea.x0 || x > walkArea.x1 || z < walkArea.z0 || z > walkArea.z1);   // she stays where the world is built
  const Z_NEAR = bounds.z1 - 13;     // the nearest z the fill reaches: the top of the flat stack (order runs from here)
  const lean = P2.rng(7);            // its own stream: an edit in the scene never reshuffles the leans
  const turn = P2.rng(11);           // and the turns of pieces placed without a yaw
  let seedN = 1;
  // Pieces placed without a yaw turn as the source game turns them: a single card faces the camera (+-14 deg, seeded);
  // a slotted cross turns its main plane ~24 deg off facing the camera (the other plane ~66 deg off, either side), so
  // the front print reads in full, the cross shows its depth and neither plane is ever edge-on. Measured against the
  // line from the overview camera to the piece (perspective turns the view up to ~20 deg toward the frame edges).
  // A half cross turns like a full one (its half must never point straight at or away from the camera: edge-on it
  // reads as a spike); a quarter cross (L or V) turns its opening toward the camera (the apex away, as the source
  // game's dune folds do).
  const DEG = Math.PI / 180;
  const autoYaw = (x, z, kind, angle = 90) => {
    const phi = Math.atan2(camera.position.x - x, camera.position.z - z);
    if (!kind) return phi + (turn() - 0.5) * 2 * 14 * DEG;
    if (kind === 'quarter') return phi - (90 - angle / 2) * DEG + (turn() - 0.5) * 2 * 10 * DEG;
    return phi + (turn() < 0.5 ? -1 : 1) * (24 + (turn() - 0.5) * 16) * DEG;   // full, half-front
  };
  // popup's cross option: true / 'full' (+), 'half' (T: the half behind), 'half-front' (T: a buttress toward the viewer),
  // 'quarter' (L; angle > 90 opens it into a V-fold)
  const CROSS = { full: {}, half: { halves: 'back', second: { scale: 0.8 } }, 'half-front': { halves: 'front' }, quarter: { main: 'right', halves: 'front' } };
  /**
   * popup(pts, paint, opts) puts a printed card (or opts.node: a cross, a box fold, a construction) on a hinge.
   * opts: x, z, yaw (omit it: a card faces the camera +-14 deg, a cross stands with its main plane ~24 deg off the view,
   * as the source game turns them; a node or a piece on a deck keeps 0), cross (slotted planes of pts, mechanisms.md
   * section 5: true / 'full' a + (trees, palms, cacti, tents, posts), 'half' a T with the half behind (a boulder, an
   * igloo, a shrine), 'half-front' a T with a buttress toward the viewer, 'quarter' an L, and with angle > 90 a V-fold
   * (dunes, drifts, ridges, outcrops); second: { pts, paint, ymax } gives the second plane its own side view and print,
   * ymax cuts it low), angle (deg the halves open to, 90), sway (wind, 0-1), scale, node, height (of a node, for its spring),
   * edge (cut-edge width), holes (outlines cut through the card: a door, windows, gaps), self (a construction that moves
   * its own parts on a flat-0 hinge: bridge, ramp; stairs rise as one piece without it), level (no hand-placed lean: walkable boxes), effects (force full prints: 1, flat: 0),
   * solid (footprint radius for the walk field, in card units: it is multiplied by scale; ~0.3-0.45 for a prop),
   * parent (a deck frame to stand on). On a parent, x and z are in the DECK's frame (x across, z toward its front),
   * yaw is relative to the deck (subtract the deck's yaw to face the camera), pass `order` yourself (the default comes
   * from z), give a solid its world position (wx, wz) and its height (base), and the piece always prints in full.
   * order: rise order (default from depth). res: print resolution x (1 = 40 px a unit; 0.6-0.75 for big pieces seen
   * only at the follow distance or repeated by the dozen: a forest, a crowd, a far ring; the print time goes with
   * res squared). materials: a print made once with printed(pts, paint) and stamped on many cards (same pts, no new
   * print: a forest of 60 from 6 prints; vary scale and turn, and keep ~3 identical in view). sight: whether the
   * walking lens eases round it when it hides the hero (default: constructions yes; cards and crosses, the trees,
   * bushes and props, no). Returns the hinge handle.
   */
  function popup(pts, paint, { x = 0, z = 0, yaw = null, cross = false, second = null, angle = 90, sway = 0, scale = 1, node = null, height = 0, edge = 0.08, self = false, parent = null, order = null, solid = 0, level = false, wx = x, wz = z, base = 0, effects = null, holes = null, res = 1, materials = null, sight = null } = {}) {
    const box = pts ? P2.bbox(pts) : { h: height };
    // pieces the lens blurs (the far rows, the big near cards) print flat and coarse: the build is ~2x faster and nothing
    // visible changes; a roaming camera (?walk, ?roam) prints everything fully
    const sharp = effects ?? (parent || flags.TEST || flags.ROAM || sharpAt(x, z) ? 1 : 0);
    const opts = { paint, paper, seed: seedN++, thickness: 0.08, edgeWidth: edge / scale, pxPerUnit: (sharp ? 40 : 28) * res / scale, effects: sharp, materials };
    const kind = cross === true ? 'full' : cross || null;
    if (kind && !CROSS[kind]) throw new Error(`popup: cross must be true, 'full', 'half', 'half-front' or 'quarter' (got ${cross})`);
    if (yaw === null) yaw = node || parent ? 0 : autoYaw(x, z, kind, angle);
    const card = node || (kind ? crossCard(pts, { ...opts, ...CROSS[kind], angle, second: { ...(CROSS[kind].second || {}), ...(second || {}) } }) : makeCard(pts, { ...opts, holes }));
    card.scale.setScalar(scale);
    const size = Math.min(1, (box.h * scale) / 12); // 0 = a tab, 1 = a page-sized flap: bigger cards rise slower
    // cards fold back (away from the camera), so a nearer card lies ON TOP of the flat stack: its fold line sits a hair
    // higher, it rises first and folds down last. rest: nothing stands plumb.
    const h = hinge(card, { at: new THREE.Vector3(x, parent ? 0.01 : 0.02 + (z - bounds.z0) * 0.0006, z), yaw, open: 0, size,
      ...(self ? { flat: 0, rest: 0 } : { rest: level ? 0 : (lean() - 0.5) * 0.07 }) });
    h.order = order ?? (Z_NEAR - z) / 5 + lean() * 0.4; h.swayAmp = sway; h.size = size; h.x = x; h.z = z; h.jit = lean() * 0.035; h.id = hinges.length;
    h.sight = sight ?? !!node;   // constructions the lens looks past (not cards and crosses: trees, bushes, props)
    hinges.push(h); (parent || scene).add(h.group);
    if (solid) walk.solid(wx, wz, solid * scale, { base });
    return h;
  }
  /**
   * stack(x, z, layers, opts): parallel cards each on its OWN hinge (references/structures.md, layered): nested sails
   * (hills, dunes, drifts, banks: the back one tallest, each nearer one lower and lighter), the slices of a dome, a
   * relief, a crowd. layers: [{ pts, paint, d, dx, yaw, scale }] back to front: d = how far toward the camera along the
   * stack's normal (in units), dx = sideways, yaw = a small extra turn. opts: yaw (the stack's; omitted: it faces the
   * camera +-14 deg) + popup options for every layer (sway, scale, solid...). Returns the hinge handles.
   */
  function stack(x, z, layers, { yaw = null, ...o } = {}) {
    const y0 = yaw ?? autoYaw(x, z, null), nx = Math.sin(y0), nz = Math.cos(y0);   // the stack's normal (toward the camera)
    return layers.map((L) => popup(L.pts, L.paint, { ...o, x: x + nx * (L.d || 0) + nz * (L.dx || 0), z: z + nz * (L.d || 0) - nx * (L.dx || 0), yaw: y0 + (L.yaw || 0), scale: (o.scale ?? 1) * (L.scale ?? 1) }));
  }
  /** dome(x, z, { r, h, n, paint }): a dome, an igloo, a yurt roof, a round hill, a cap as n parallel slices (a stack):
   *  each slice the dome's section at its depth; paint: one print, or [paint, ...] back to front. */
  function dome(x, z, { r = 3, h = r, n = 5, paint = null, ...o } = {}) {
    const layers = [];
    for (let i = 0; i < n; i++) {
      const d = -r + (2 * i + 1) * r / n, k = Math.sqrt(Math.max(0, 1 - (d / r) ** 2)), w = r * k, hh = h * k, pts = [];
      for (let s = 0; s <= 16; s++) { const a = Math.PI * s / 16; pts.push([-Math.cos(a) * w, Math.sin(a) * hh]); }
      layers.push({ pts, paint: Array.isArray(paint) ? paint[i % paint.length] : paint, d });
    }
    return stack(x, z, layers, o);
  }
  /** printed(pts, paint, { res, cross, holes }): print once, stamp many (popup's `materials`): the print of a card cut
   *  to pts, at full quality (res as popup's). cross: true for a print that crosses will use (both faces printed). */
  const printed = (pts, paint, { res = 1, cross = false, holes = null } = {}) =>
    makeCard(pts, { paint, paper, seed: seedN++, thickness: 0.08, edgeWidth: 0.08, pxPerUnit: 40 * res, effects: 1, back: cross ? 'mirror' : 'kraft', holes }).material;
  /** Settings for a card you make yourself (layeredCard, a construction) so it prints like popup's own (res as popup's). */
  const cardOpts = (x, z, scale = 1, parent = null, res = 1) => { const sharp = parent || flags.TEST || flags.ROAM || sharpAt(x, z) ? 1 : 0; return { paper, thickness: 0.08, edgeWidth: 0.08 / scale, pxPerUnit: (sharp ? 40 : 28) * res / scale, effects: sharp, seed: seedN++ * 31 }; };
  /** A practical light (lamp, lit door, brazier): a warm pool at dusk and night, k = relative power. */
  const lamp = (x, y, z, k = 1, dist = 10) => lamps.push([x, y, z, k, dist]);
  /** A group whose printed panes glow (P.glow): dim by day, lit at dusk and night. */
  const glowing = (group) => { glowers.push(group); group.traverse((o) => o.userData.setGlow?.(0.35)); };

  const H = { THREE, P2, flags, renderer, scene, camera, paper, view, target, walk, hinges, spots, bounds, heroHeight, groundAt, stack, dome,
    printGround, popup, printed, cardOpts, inFrame, inReach, walkArea, sharpAt, lamp, glowing, hero: null, stepHooks: [], onStep: (fn) => H.stepHooks.push(fn), restartHooks: [], onRestart: (fn) => H.restartHooks.push(fn), setHero: (h, { stride = null } = {}) => { H.hero = h; H.heroStride = stride; }, heroWalk, start };

  // ---- a hero to follow: a scripted walk the video's clock drives ---------------------------------------------------
  /**
   * heroWalk(points, { follow, lead, smooth }): the hero (setHero) walks through points [{ at, x, z }] (seconds of the
   * scene, ground units), at an even pace between two times, and stands still before the first, after the last, and
   * between two points at the same place. He turns to face the way he goes, his limbs swing (setHero's stride) and his
   * feet stay on whatever is under him (the page or a built deck). follow (default true): the camera follows him, its
   * target held at his place + lead [dx, dz] (default [0, -1.5]: he sits a little below the middle), on a calm critically
   * damped glide (smooth s, default 0.6); the lens focuses on him.
   */
  let route = null, routeFollow = true, routeLead = [0, -1.5], routeSmooth = 0.6;
  function heroWalk(points, { follow = true, lead = [0, -1.5], smooth = 0.6 } = {}) {
    route = [...points].sort((a, b) => a.at - b.at); routeFollow = follow; routeLead = lead; routeSmooth = smooth;
  }
  /** Where the route puts him at time t: { x, z, dx, dz, moving, dist } (dist: the distance walked so far). */
  function routeAt(t) {
    let dist = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i], b = route[i + 1], dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      if (t < b.at) {
        const f = t <= a.at ? 0 : (t - a.at) / Math.max(1e-6, b.at - a.at);
        return { x: a.x + dx * f, z: a.z + dz * f, dx, dz, moving: t > a.at && len > 1e-4, dist: dist + len * f };
      }
      dist += len;
    }
    const e = route[route.length - 1];
    return { x: e.x, z: e.z, dx: 0, dz: 0, moving: false, dist };
  }

  // ---- start: light, lens, choreography and the video clock ------------------------------------------------------
  function start() {
    const hero = H.hero;   // optional in a video: the lens then focuses on `focus`, or on the view's target
    // mood: one of the four measured sets (MOODS), or a preset of lights.json (overcast, mist, snow-bright, aquatic, hard-noon,
    // soft-spring…): its colours on the day set's intensities, under what light / lens give
    const LP = !moods[flags.MOOD] && LIGHTS[flags.MOOD];
    if (flags.MOOD !== 'day' && !moods[flags.MOOD] && !LP) console.warn(`papercraft: no mood "${flags.MOOD}" (day, golden, dusk, night or ${Object.keys(LIGHTS).filter((k) => !k.startsWith('_')).join(', ')})`);
    const L = { target: new THREE.Vector3(-1, 0, -12), keyDir: [-0.8, 0.95, 0.55], key: '#ffdcb2', keyIntensity: 3.0, fill: '#f2dcc2', fillIntensity: 0.8,
      fillDir: [0.45, 0.5, 1.0], sky: '#fff0da', ground: '#b39a78', skyIntensity: 0.42, shadowExtent: 50, distance: 100, mapSize: 4096, leak: '#a0602c', softness: 0.26, maxPenumbra: 1.4, ...(LP ? { key: LP.key, fill: LP.fill, leak: LP.leak } : {}), ...light };
    // key from the side, ~55 deg off the camera axis and ~45 deg up: faces stay lit, shadows fall sideways where the
    // camera sees them (a key from behind the camera hides every shadow)
    const lights = paperLights(scene, L);
    PAPER_LIGHT.leak.value.set(L.leak);      // the world's shadow colour (light.leak), never grey. shortcut: one value for every paper scene on the page
    enableSoftShadows(lights.key, { softness: L.softness, maxPenumbra: L.maxPenumbra });
    const post = new PaperPost(renderer, scene, camera, { haze: '#d8bf8e', hazeStart: 34, hazeEnd: 95, hazeAmount: 0.3, focusBand: 0.3, ramp: 0.3, maxBlur: 18,
      tint: [1.03, 0.985, 0.98], saturation: 0.96, greenDesat: 0.3, exposure: 0.82, contrast: 1.18, vignette: 0.03, ...(LP ? { haze: LP.haze } : {}), ...lens });
    const M = moods[flags.MOOD];
    if (M) {
      lights.key.color.set(M.key); lights.key.intensity = M.ki; lights.fill.color.set(M.fill); lights.fill.intensity = M.fi;
      if (M.dir) lights.key.position.copy(lights.key.target.position).addScaledVector(new THREE.Vector3(...M.dir).normalize(), L.distance);
      lights.sky.color.set(M.sky); lights.sky.groundColor.set(M.skyG); lights.sky.intensity = M.si;
      PAPER_LIGHT.leak.value.set(M.leak); if (M.wrap) PAPER_LIGHT.wrap.value = M.wrap;
      if (M.glow) for (const gr of glowers) gr.traverse((o) => o.userData.setGlow?.(M.glow));
      if (M.lamp) for (const [x, y, z, k, d] of lamps) { const P = new THREE.PointLight('#ffb070', M.lamp * k, d, 1.0); P.position.set(x, y, z); scene.add(P); } // before the first render: the light count is fixed
      Object.assign(post.o, M.post); post.apply();
    }

    // choreography: the nearest card lies on top of the flat stack, so it rises first; closing is the exact reverse.
    // H.riseAt (s): when the first card starts to rise (the flat print shows before it)
    function setOpen(open) {
      const maxOrder = Math.max(...hinges.map((h) => h.order));
      for (const h of hinges) {
        const k = open ? h.order : maxOrder - h.order;
        h.set(open ? 1 : 0, (H.riseAt ?? 0.1) + k * (open ? 0.09 : 0.045) + h.jit);   // fixed per-piece jitter: replays are identical
      }
    }
    let time = 0, steps = 0;
    const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    let heading = 0, gait = 0; const tVel = new THREE.Vector3(), heroAt = new THREE.Vector3();
    function placeHero(t, dt) {   // the scripted walk: place, heading, gait, stride, then the camera after him
      const p = routeAt(t), s = walk.surface(p.x, p.z);
      heroAt.set(p.x, s && s.y < 10 ? s.y : 0, p.z);
      if (p.moving) heading = dt ? heading + wrapA(Math.atan2(p.dx, p.dz) - heading) * (1 - Math.exp(-dt * 8)) : Math.atan2(p.dx, p.dz);
      gait = dt ? gait + ((p.moving ? 1 : 0) - gait) * (1 - Math.exp(-dt * 10)) : (p.moving ? 1 : 0);
      hero.group.position.set(heroAt.x, heroAt.y + 0.02, heroAt.z);
      faceHero();
      H.heroStride?.(p.dist, gait);
      if (!routeFollow) return;
      const gx = heroAt.x + routeLead[0], gy = 1.5 + heroAt.y * 0.5, gz = heroAt.z + routeLead[1];
      if (!dt) { target.set(gx, gy, gz); tVel.set(0, 0, 0); return; }
      const om = 2 / routeSmooth, e = Math.exp(-om * dt);
      for (const [ax, g] of [['x', gx], ['y', gy], ['z', gz]]) { const d = target[ax] - g, tmp = (tVel[ax] + om * d) * dt; tVel[ax] = (tVel[ax] - om * tmp) * e; target[ax] = g + (d + tmp) * e; }
    }
    // a figure of views (figure.js) turns to the camera and shows the view his heading asks for; a 3D doll turns itself
    function faceHero() {
      const face = hero.pivot.children[0]?.userData.face;
      if (!face) { hero.group.rotation.y = heading; return; }
      const toCam = Math.atan2(camera.position.x - hero.group.position.x, camera.position.z - hero.group.position.z);
      hero.group.rotation.y = toCam; face(heading - toCam);
    }
    function step(dt) {
      time += dt;
      for (const h of hinges) {
        h.update(dt);
        h.sway = h.swayAmp ? windSway(time, h.x, h.z, { amp: 1.6 * h.swayAmp, heroHeight }) : 0; // about the fold line
      }
      if (hero) hero.pivot.rotation.y = Math.sin(time * 0.7) * 0.05;
      if (hero && !route) faceHero();
      if (hero && route) placeHero(time, dt);
      for (const fn of H.stepHooks) fn(time, dt);
      view.yaw += (view.tyaw - view.yaw) * (1 - Math.exp(-dt * 6));
      view.pitch += (view.tpitch - view.pitch) * (1 - Math.exp(-dt * 6));
      placeCamera(view.yaw + Math.sin(time * 0.21) * 0.5, view.pitch + Math.sin(time * 0.17) * 0.3);   // the gentle drift of a hand-held macro
    }
    function render() {
      if (focus) post.focus.set(...focus);
      else if (hero && route) post.focus.set(heroAt.x, 1.8 + heroAt.y, heroAt.z);
      else if (hero) { const kd = view.dist / 66; post.focus.set(hero.group.position.x - 3 * kd, 1.8 + hero.group.position.y, hero.group.position.z - 4 * kd); }
      else post.focus.copy(target);
      post.render(time);
    }
    function restart() { // everything flat, t = 0: the same replay every time
      time = 0; steps = 0; for (const h of hinges) h.reset(0);
      view.yaw = view.tyaw; view.pitch = view.tpitch;
      if (hero && route) { heading = 0; placeHero(0, 0); placeCamera(view.yaw, view.pitch); }
      for (const fn of H.restartHooks) fn();
      setOpen(true);
    }
    const HZ = 60;
    /** The image at `t` seconds of the clip: steps the fixed 60 Hz clock there (from t = 0 when going back), then renders. */
    function seek(t) {
      const k = Math.max(0, Math.round(t * HZ));
      if (k < steps) restart();
      for (; steps < k; steps++) step(1 / HZ);
      render();
    }
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); post.setSize(width, height);
    restart();
    Object.assign(H, { seek, restart, setOpen, render, post, lights,
      dispose() { renderer.dispose(); renderer.forceContextLoss(); } });
  }
  return H;
}
