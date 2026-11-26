// papercraft / figure.js (REDACTED) — a character seen as ONE flat card at a time, like a paper puppet: the front when he
// walks toward the camera, his back when he walks away, his profile (mirrored left / right) when he crosses. Each view
// is a printed card (body and head) with two leg cards on hip pivots; the figure always turns to face the camera, so a
// card is never seen edge-on and two faces never mix. The stage picks the view from his heading (stage.js, heroWalk).
import * as THREE from 'three';
import { makeCard } from './lib/paperkit-3d.js';

const VIEWS = ['front', 'back', 'side'];

/**
 * viewFigure(H, { front, back, side, leg, legSide, hipY, legX, legLen }) -> a node for H.popup(null, null, { node, height })
 * front / back / side: [pts, paint] (P2.drawnPiece) of the body and head, standing on y = hipY - a little (the legs hang
 * below); side faces RIGHT (+x). leg / legSide: [pts, paint] of one leg, its top at y = legLen, its foot at 0 (legSide:
 * its profile, toes to the right; default leg). hipY: where the legs hang (= legLen); legX: half the gap between the
 * two legs seen from the front. Then H.setHero(handle, { stride: node.userData.stride }).
 */
export function viewFigure(H, { front, back, side, leg, legSide = leg, legLen = 0.9, hipY = legLen, legX = 0.18, seed = 900 }) {
  const g = new THREE.Group();
  const card = ([pts, paint], parent, y = 0, z = 0) => {
    const m = makeCard(pts, { paint, paper: H.paper, thickness: 0.05, edgeWidth: 0.04, pxPerUnit: 64, seed: seed++, back: 'kraft', folds: [] });
    m.position.set(0, y, z); parent.add(m); return m;
  };
  const views = {}, hips = {};
  for (const k of VIEWS) {
    const v = new THREE.Group(); v.visible = k === 'front'; g.add(v); views[k] = v;
    // legs behind the body (z < 0), so the body's cut edge covers their tops
    hips[k] = (k === 'side' ? [0.04, -0.04] : [-legX, legX]).map((x, i) => {
      const hip = new THREE.Group(); hip.position.set(x, hipY, -0.06 - (k === 'side' ? i * 0.06 : 0)); v.add(hip);
      card(k === 'side' ? legSide : leg, hip, -legLen); return hip;
    });
    card({ front, back, side }[k], v, 0, 0);
  }
  /** rel: his heading relative to the way toward the camera (radians; 0 = he walks at the camera, PI = away from it). */
  g.userData.face = (rel) => {
    const a = Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel)));
    const k = a < Math.PI / 4 ? 'front' : a > (3 * Math.PI) / 4 ? 'back' : 'side';
    for (const n of VIEWS) views[n].visible = n === k;
    views.side.scale.x = Math.sin(rel) < 0 ? -1 : 1;   // the profile looks the way he goes
  };
  // the stride: in profile the legs swing forward and back in the card's plane; from the front or the back they lift
  // in turn; the body bobs twice a step. Rotation and small lifts only, never a scale.
  const STEP = 0.9;
  g.userData.stride = (walked, gait) => {
    const ph = (walked / STEP) * Math.PI, s = Math.sin(ph) * 0.45 * gait;
    hips.side[0].rotation.z = s; hips.side[1].rotation.z = -s;
    for (const k of ['front', 'back']) { hips[k][0].position.y = hipY + Math.max(0, Math.sin(ph)) * 0.08 * gait; hips[k][1].position.y = hipY + Math.max(0, -Math.sin(ph)) * 0.08 * gait; }
    for (const k of VIEWS) views[k].position.y = Math.abs(Math.sin(ph)) * 0.04 * gait;
  };
  return g;
}
