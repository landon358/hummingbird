import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
const DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.setClearColor(0x000000, 0);

const ui = id => document.getElementById(id);

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
scrollTo({ top: 0, behavior: 'instant' });
/* ---------- modes: logo -> launch -> flight on a fresh visit, enter -> flight after a page change, exit before leaving ---------- */
const store = { get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }, del(k) { try { sessionStorage.removeItem(k); } catch (e) {} } };
const navType = (performance.getEntriesByType('navigation')[0] || {}).type || 'navigate';
let mode = store.get('hb_transit') === '1' && navType === 'navigate' ? 'enter' : 'flight';
store.del('hb_transit');
const enterAngle = parseFloat(store.get('hb_dir') || '0') || 0;   // direction the bird left the previous page, radians
if (mode !== 'enter') document.documentElement.classList.remove('transit');
const params = { cell: 7, flap: 54, shim: 2, idle: 0, raw: false, glyphs: ' * _<>,  ./O#SF +' };

/* ---------- scene pass: bird rendered to a texture ---------- */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(22, 1, .1, 50);
camera.position.set(0, .05, 4.2);

const birdMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: { uBodyInv: { value: new THREE.Matrix3() } },
  vertexShader: `
    uniform mat3 uBodyInv;
    varying vec3 vN; varying vec3 vV; varying float vDorsal;
    void main(){
      vN = normalize(normalMatrix * normal);
      vec3 nb = uBodyInv * normalize(mat3(modelMatrix) * normal);
      vDorsal = nb.y;
      vec4 mv = modelViewMatrix * vec4(position,1.);
      vV = -mv.xyz;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vN; varying vec3 vV; varying float vDorsal;
    void main(){
      vec3 n = normalize(vN);
      float dorsal = vDorsal;
      if(!gl_FrontFacing){ n = -n; dorsal = -dorsal; }
      dorsal = smoothstep(-.3, .45, dorsal);
      vec3 L = normalize(vec3(-.45,.75,.55));
      float diff = max(dot(n,L),0.);
      float fill = max(dot(n,normalize(vec3(.6,-.2,.4))),0.)*.25;
      float rim = pow(1. - max(dot(n, normalize(vV)),0.), 2.);
      float shade = .1 + diff*.72 + fill + rim*.3;
      gl_FragColor = vec4(clamp(shade,0.,1.), n.x*.5+.5, n.y*.5+.5, .2 + .8*dorsal);
    }`
});

const sceneRT = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
const trailRT = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });

/* ---------- mouse trail pass ---------- */
const TRAIL = 40;
const trailPts = Array.from({ length: TRAIL }, () => new THREE.Vector2(-9, -9));
const trailStr = new Array(TRAIL).fill(0);
const trailMat = new THREE.ShaderMaterial({
  uniforms: { uPts: { value: trailPts }, uStr: { value: trailStr }, uAspect: { value: 1 }, uRadius: { value: .085 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
  fragmentShader: `
    #define TRAIL ${TRAIL}
    uniform vec2 uPts[TRAIL]; uniform float uStr[TRAIL]; uniform float uAspect; uniform float uRadius;
    varying vec2 vUv;
    void main(){
      float t = 0.;
      for(int i=0;i<TRAIL;i++){
        float k = 1. - float(i)/float(TRAIL);
        vec2 d = vUv - uPts[i]; d.x *= uAspect;
        float r = uRadius * (.35 + .65*k);
        t += (1. - smoothstep(r*.45, r, length(d))) * uStr[i] * k * .35;
      }
      gl_FragColor = vec4(vec3(clamp(t,0.,1.)),1.);
    }`
});

/* ---------- glyph atlas, built at exact cell resolution ---------- */
let cellOverride = 0;
const atlasCanvas = document.createElement('canvas');
const atlasTex = new THREE.CanvasTexture(atlasCanvas);
atlasTex.minFilter = atlasTex.magFilter = THREE.NearestFilter;
atlasTex.generateMipmaps = false;
function buildAtlas() {
  const px = Math.round((cellOverride || params.cell) * DPR);
  if (atlasCanvas.width !== px * 16) { atlasCanvas.width = atlasCanvas.height = px * 16; atlasTex.dispose(); }
  const c = atlasCanvas.getContext('2d');
  c.clearRect(0, 0, px * 16, px * 16);
  c.fillStyle = '#fff';
  c.font = `600 ${Math.round(px * 1.02)}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  [...params.glyphs].forEach((ch, i) => c.fillText(ch, (i % 16) * px + px / 2, Math.floor(i / 16) * px + px / 2 + px * .04));
  atlasTex.needsUpdate = true;
  asciiMat.uniforms.uCount.value = [...params.glyphs].length;
  asciiMat.uniforms.uCell.value = px;
}

/* ---------- ascii pass ---------- */
const asciiMat = new THREE.ShaderMaterial({
  uniforms: {
    tScene: { value: sceneRT.texture }, tTrail: { value: trailRT.texture }, tGlyphs: { value: atlasTex },
    uRes: { value: new THREE.Vector2() }, uCell: { value: 7 }, uCount: { value: 11 },
    uTime: { value: 0 }, uShimmer: { value: 1 }, uIdle: { value: .15 }, uRaw: { value: 0 }, uBg: { value: new THREE.Vector3(.035, .035, .043) }, uBase: { value: new THREE.Vector3(.88, .9, .86) },
    uRip: { value: Array.from({ length: 4 }, () => new THREE.Vector3(0, 0, -99)) }, uAspectR: { value: 1 },
    uBandC: { value: -9 }, uBandH: { value: .5 }, uBandTilt: { value: .18 },
    uBandBg: { value: new THREE.Vector3(.043, .071, .184) }, uBandFg: { value: new THREE.Vector3(.56, .80, .93) }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
  fragmentShader: `
    uniform sampler2D tScene, tTrail, tGlyphs;
    uniform vec3 uBg, uBase;
    uniform vec2 uRes; uniform float uCell, uCount, uTime, uShimmer, uIdle, uRaw, uAspectR;
    uniform vec3 uRip[4];
    uniform float uBandC, uBandH, uBandTilt;
    uniform vec3 uBandBg, uBandFg;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

    vec3 iridescent(float t){
      t = fract(t) * 5.;
      vec3 c0=vec3(.10,.85,.52), c1=vec3(.08,.70,.90), c2=vec3(.50,.36,1.), c3=vec3(1.,.22,.62), c4=vec3(1.,.58,.22);
      float f = smoothstep(0.,1.,fract(t));
      if(t<1.) return mix(c0,c1,f);
      if(t<2.) return mix(c1,c2,f);
      if(t<3.) return mix(c2,c3,f);
      if(t<4.) return mix(c3,c4,f);
      return mix(c4,c0,f);
    }
    vec3 emerald(float t){
      t = fract(t) * 4.;
      vec3 c0=vec3(.02,.55,.28), c1=vec3(.15,.95,.45), c2=vec3(.72,.95,.25), c3=vec3(.05,.80,.70);
      float f = smoothstep(0.,1.,fract(t));
      if(t<1.) return mix(c0,c1,f);
      if(t<2.) return mix(c1,c2,f);
      if(t<3.) return mix(c2,c3,f);
      return mix(c3,c0,f);
    }
    float M(vec4 s){ return step(.01, s.a); }

    // a strip of colour the page scrolls through; the bird takes it on as it passes
    float bandAt(vec2 uv){
      float y = uv.y + (uv.x - .5) * uBandTilt;
      return 1. - smoothstep(.45, 1., abs(y - uBandC) / max(uBandH, .001));
    }

    void main(){
      float band = bandAt(vUv);
      vec3 bg = mix(uBg, uBandBg, band * .92);
      if(uRaw > .5){ vec4 s = texture2D(tScene, vUv); gl_FragColor = vec4(mix(bg, s.rgb, M(s)),1.); return; }

      vec2 frag  = vUv * uRes;
      vec2 grid  = uRes / uCell;
      vec2 cell  = floor(frag / uCell);
      vec2 local = fract(frag / uCell);
      vec2 cuv   = (cell + .5) / grid;

      float tr = texture2D(tTrail, cuv).r;

      float rip = 0.;
      for(int i=0;i<4;i++){
        float age = uTime - uRip[i].z;
        if(age < 0. || age > 1.5) continue;
        vec2 dv = cuv - uRip[i].xy; dv.x *= uAspectR;
        float dist = length(dv), rad = age * .75;
        float ring = exp(-pow((dist - rad) / .025, 2.)) + .85 * exp(-pow((dist - rad + .11) / .025, 2.));
        rip += ring * pow(1. - age / 1.5, 1.2);
      }
      rip = clamp(rip, 0., 1.);

      float rowH  = hash(vec2(cell.y, floor(uTime * 16.)));
      float shift = step(.6, rowH) * step(.12, tr) * floor((rowH - .6) * 14. * tr + .5);
      vec2 suv = (cell + .5 + vec2(shift, 0.)) / grid;

      vec4 s = texture2D(tScene, suv);
      float mk = M(s); float g = s.r * mk; float dorsal = clamp((s.a - .2) / .8, 0., 1.);

      vec2 dx = vec2(1./grid.x, 0.), dy = vec2(0., 1./grid.y);
      vec4 l = texture2D(tScene, suv-dx), r = texture2D(tScene, suv+dx);
      vec4 u = texture2D(tScene, suv+dy), d = texture2D(tScene, suv-dy);
      float e = abs(r.r*M(r) - l.r*M(l)) + abs(u.r*M(u) - d.r*M(d)) + abs(r.g-l.g)*.5 + abs(u.b-d.b)*.5;
      float edge = smoothstep(.05, .35, e);

      float n = uCount - 1.;
      float idx = floor(clamp(g,0.,1.) * n + .5);

      float gh = hash(cell + floor(uTime * 22.));
      float gl = max(tr, rip * .9);
      float swap = step(.15, gl) * step(1. - gl * .8, gh) * mk;
      idx = mix(idx, 1. + floor(hash(cell * 1.7 + floor(uTime * 22.)) * n), swap);

      vec2 auv = vec2((mod(idx,16.) + local.x) / 16., 1. - (floor(idx/16.) + 1. - local.y) / 16.);
      float glyph = texture2D(tGlyphs, auv).r;

      vec3 base = mix(uBase, uBandFg, band * .85) * (.3 + .7*g);
      float t = s.g * .9 + s.b * 1.2 + uTime * .08 + hash(cell) * .05 + tr * .35 + rip * .6 + vUv.x * .2;
      vec3 iri = mix(iridescent(t), emerald(t * .8), smoothstep(.35, .75, dorsal)) * 1.3;

      float m = max(clamp(tr * 1.8, 0., 1.) * (.35 + .65 * edge), rip * mk);
      m = max(m, uIdle * edge * mk);
      vec3 col = mix(base, iri, clamp(m * uShimmer, 0., 1.));

      gl_FragColor = vec4(mix(bg, col, glyph), 1.);
    }`
});

const quadGeo = new THREE.PlaneGeometry(2, 2);
const trailScene = new THREE.Scene(); trailScene.add(new THREE.Mesh(quadGeo, trailMat));
const asciiScene = new THREE.Scene(); asciiScene.add(new THREE.Mesh(quadGeo, asciiMat));
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/* ---------- colors (locked settings) ---------- */
const hexToVec = (h, v) => v.set(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
hexToVec('#09090b', asciiMat.uniforms.uBg.value);
hexToVec('#e1e6db', asciiMat.uniforms.uBase.value);

/* ---------- input ---------- */
const mouse = new THREE.Vector2(.5, .5), lastMouse = new THREE.Vector2(.5, .5), look = new THREE.Vector2();
let vel = 0;
addEventListener('pointermove', e => { mouse.set(e.clientX / innerWidth, 1 - e.clientY / innerHeight); });
const INTERACTIVE = 'a, button, input, select, textarea, label, .menu';

// click on the bird to send a shimmer ripple across it
let ripIdx = 0;
const _clickRay = new THREE.Raycaster(), _clickNdc = new THREE.Vector2();
const _hitBox = new THREE.Box3(), _hv = new THREE.Vector3();
addEventListener('pointerdown', e => {
  if (e.target.closest && e.target.closest(INTERACTIVE)) return;
  const ux = e.clientX / innerWidth, uy = 1 - e.clientY / innerHeight;
  let hit = false;
  for (const [ox, oy] of [[0, 0], [14, 0], [-14, 0], [0, 14], [0, -14]]) {
    _clickNdc.set(((e.clientX + ox) / innerWidth) * 2 - 1, 1 - ((e.clientY + oy) / innerHeight) * 2);
    _clickRay.setFromCamera(_clickNdc, camera);
    if (_clickRay.intersectObject(offset, true).length) { hit = true; break; }
  }
  // a thin ascii bird is hard to hit exactly, so the box around it counts as the bird too
  if (!hit) {
    _hitBox.setFromObject(offset);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _hv.set(i & 1 ? _hitBox.max.x : _hitBox.min.x, i & 2 ? _hitBox.max.y : _hitBox.min.y, i & 4 ? _hitBox.max.z : _hitBox.min.z).project(camera);
      const px = (_hv.x + 1) / 2 * innerWidth, py = (1 - _hv.y) / 2 * innerHeight;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    const mx = (x1 - x0) * .1, my = (y1 - y0) * .1;
    hit = e.clientX > x0 + mx && e.clientX < x1 - mx && e.clientY > y0 + my && e.clientY < y1 - my;
  }
  if (!hit) return;
  asciiMat.uniforms.uRip.value[ripIdx].set(ux, uy, time);
  measureChars(); textRippleUntil = time + 3.4;
  ripIdx = (ripIdx + 1) % 4;
});

/* ---------- text ripple: headings scramble into colorful glyphs as each ring passes ---------- */
const CHARS = [];
// every visible string is split into characters so the click ripple can scramble it.
// controls and headings get an aria-label and hide the pieces, so assistive tech reads them normally.
function splitText(el) {
  const named = el.matches('a,button,summary,.btn,h1,h2,h3') && !el.querySelector('a');
  if (named && !el.getAttribute('aria-label')) el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
  const fixed = !!el.closest('.nav, footer');
  const walk = n => {
    if (n.nodeType === 1 && (n.namespaceURI !== 'http://www.w3.org/1999/xhtml' || n.classList.contains('ch'))) return;
    if (n.nodeType === 3) {
      // one wrapper per run of text: inside a flex or grid parent the letters must not become items themselves
      const wrap = document.createElement('span'); wrap.className = 'chw';
      for (const c of n.textContent) {
        if (c.trim() === '') { wrap.appendChild(document.createTextNode(c)); continue; }
        const sp = document.createElement('span'); sp.textContent = c; sp.className = 'ch';
        wrap.appendChild(sp); CHARS.push({ el: sp, o: c, on: false, fixed, x: 0, y: 0, seed: Math.random() });
      }
      n.replaceWith(wrap);
    } else [...n.childNodes].forEach(walk);
  };
  [...el.childNodes].forEach(walk);
  if (named) for (const child of el.children) child.setAttribute('aria-hidden', 'true');
}
for (const ch of document.querySelectorAll('.split .ch')) CHARS.push({ el: ch, o: ch.textContent, on: false, fixed: false, x: 0, y: 0, seed: Math.random() });
const SPLIT = [...document.querySelectorAll(
  '#content :is(h1,h2,h3,p,li,blockquote,summary,.btn,.price,.ledger-lead,.who,.meta,.cover span,.field span),' +
  'footer span,footer a,.brand .word,.island a,.menu a span,.menu small')];
SPLIT.forEach(el => { if (!SPLIT.some(o => o !== el && o.contains(el))) splitText(el); });
function measureChars() {
  for (const c of CHARS) { const r = c.el.getBoundingClientRect(); c.x = r.left + r.width / 2; c.y = r.top + r.height / 2 + (c.fixed ? 0 : scrollY); }
}
const PAL = [[.10, .85, .52], [.08, .70, .90], [.50, .36, 1.], [1., .22, .62], [1., .58, .22]];
function palCss(t) {
  t = ((t % 1) + 1) % 1 * 5; const i = Math.floor(t), f = t - i, a = PAL[i % 5], b = PAL[(i + 1) % 5], k = f * f * (3 - 2 * f);
  return `rgb(${[0, 1, 2].map(j => Math.round((a[j] + (b[j] - a[j]) * k) * 255)).join(',')})`;
}
let textRippleUntil = -1;
let rippleClean = true;
function updateTextRipple() {
  if (time > textRippleUntil) {   // one last pass puts every letter back when the ripple ends
    if (!rippleClean) { for (const c of CHARS) { c.el.classList.remove('scr'); c.on = false; } rippleClean = true; }
    return;
  }
  rippleClean = false;
  const rips = asciiMat.uniforms.uRip.value, asp = innerWidth / innerHeight, glyphs = [...params.glyphs].filter(g => g.trim());
  for (const c of CHARS) {
    const ux = c.x / innerWidth, uy = 1 - (c.y - (c.fixed ? 0 : scrollY)) / innerHeight;
    let active = false, d0 = 0;
    for (const r of rips) {
      const age = time - r.z; if (age < 0 || age > 3.2) continue;
      const d = Math.hypot((ux - r.x) * asp, uy - r.y);
      const h1 = age - d / .75, h2 = age - (d + .11) / .75;
      if ((h1 >= 0 && h1 < .42) || (h2 >= 0 && h2 < .42)) { active = true; d0 = d; }
    }
    if (active) {
      if (!c.on || Math.random() < .35) c.el.dataset.g = glyphs[(Math.random() * glyphs.length) | 0] || '*';
      c.el.classList.add('scr');
      const col = palCss(c.seed * .3 + time * .6 + d0 * 1.5);
      c.el.style.setProperty('--gc', col);
      c.on = true;
    } else if (c.on) { c.el.classList.remove('scr'); c.on = false; }
  }
}

/* ---------- flight path built from the page layout ----------
   Each [data-side] chapter keeps the bird on the side opposite its text:
     side   while the copy passes the middle of the screen, the bird drifts down its open column and swings outward
     cross  between chapters it rides the empty gap as that gap scrolls up the screen,
            entering low on the old side, dipping behind the page at the middle, leaving high on the new side
   Keys are pinned to scroll positions measured from the real text, so the bird flies around the copy, not over it. */
let PATH = null, KEY_S = [], KEY_P = [], birdLen = .8, flightScale = 1, bandPage = -9999, bandPx = 0;
let perchPage = -99999, perchBase = -99999, perchX = 0, perchLift = 0, perched = false, perchK = 0, perchAnchor = 1, hopT = 0;
const FOLD = { x: -.24, y: -.5, z: .12, scale: .2, tail: .3 };   // wings closed against the body when sitting
function viewHalf() { const hh = camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); return [hh * camera.aspect, hh]; }
function pageTop(el) { let y = 0; for (; el; el = el.offsetParent) y += el.offsetTop; return y; }
function buildPath() {
  const vw = innerWidth, vh = innerHeight, max = Math.max(1, document.documentElement.scrollHeight - vh);
  const [hw, hh] = viewHalf(), narrow = vw < 768;
  const pxPerUnit = vh / (2 * hh);
  const toX = px => (px / vw * 2 - 1) * hw, toY = py => (.5 - py / vh) * 2 * hh;
  const chapters = [...document.querySelectorAll('[data-side]')].map(sec => {
    const col = sec.querySelector('.col') || sec, c = col.getBoundingClientRect();
    // offsets ignore the scroll reveal transforms, so this is the resting layout
    let top = Infinity, bottom = -Infinity;
    for (const k of (col.children.length ? col.children : [col])) { const y = pageTop(k); top = Math.min(top, y); bottom = Math.max(bottom, y + k.offsetHeight); }
    const S = sec.dataset.side === 'left' ? 1 : -1;   // +1 bird on the right, -1 bird on the left
    let a = S > 0 ? c.right : 0, b = S > 0 ? vw : c.left;   // open region beside the text, px
    if (narrow || b - a < vw * .22) { a = S > 0 ? vw * .5 : 0; b = S > 0 ? vw : vw * .5; }
    return { S, a, b, top, bottom };
  });
  // size the bird so it fits the narrowest open column with air around it
  const openPx = narrow ? vw * .5 : Math.max(vw * .3, Math.min(...chapters.map(c => c.b - c.a)));
  const BIRD_SIZE = 1.67;   // overall size multiplier on top of the fit
  flightScale = THREE.MathUtils.clamp(openPx * .5 / (birdLen * pxPerUnit), .45, 1) * BIRD_SIZE;
  const birdPx = birdLen * flightScale * pxPerUnit;

  const raw = [];
  chapters.forEach((ch, i) => {
    const cx = toX((ch.a + ch.b) / 2);
    // swing only as far as the bird still clears the text and the screen edge
    const span = Math.max(0, ((ch.b - ch.a) - birdPx) / 2 - 24) / pxPerUnit;
    const mid = (ch.top + ch.bottom) / 2 - vh / 2;
    if (i === 0) raw.push([0, new THREE.Vector3(cx - ch.S * span * .5, toY(vh * .42), 0)]);
    raw.push([mid, new THREE.Vector3(cx + ch.S * span, toY(vh * .5), -.25)]);
    const nx = chapters[i + 1];
    if (nx) {
      const gap = (ch.bottom + nx.top) / 2, ncx = toX((nx.a + nx.b) / 2);
      raw.push([gap - vh * .75, new THREE.Vector3(cx, toY(vh * .75), 0)]);                 // low on the old side
      raw.push([gap - vh * .5, new THREE.Vector3(ch.S * .06, toY(vh * .5), -.55)]);        // through the gap, behind the page
      raw.push([gap - vh * .25, new THREE.Vector3(ncx - nx.S * span * .4, toY(vh * .25), 0)]); // high on the new side
    } else {
      raw.push([mid + vh * .5, new THREE.Vector3(cx, toY(vh * .52), .3)]);                 // last chapter: settle in closer
    }
  });
  // the footer hairline is a place to land: the bird perches on it once you reach the bottom
  const footEl = document.querySelector('footer'), baseEl = document.querySelector('.foot-base');
  perchPage = footEl ? pageTop(footEl) : -99999;
  perchBase = baseEl ? pageTop(baseEl) : -99999;   // a second rule to sit on once the first leaves the screen
  perchX = toX(vw * (narrow ? .5 : .72));
  perchLift = birdLen * flightScale * .6;       // raise the body so the feet meet the line

  // the strip sits across one chapter, so the bird flies through it on the way past
  const bandOn = chapters.length >= 3 ? chapters[Math.min(3, chapters.length - 1)] : null;   // short pages stay plain
  if (bandOn) { bandPage = (bandOn.top + bandOn.bottom) / 2; bandPx = Math.max(vh * .62, (bandOn.bottom - bandOn.top) + vh * .3); }
  else { bandPage = -99999; bandPx = vh; }
  asciiMat.uniforms.uBandH.value = bandPx / vh * .5;

  KEY_S = []; KEY_P = [];
  for (const [s0, p] of raw) {
    const s = THREE.MathUtils.clamp(s0, 0, max), n = KEY_S.length;
    if (n && s <= KEY_S[n - 1] + 1) {
      if (s >= max - 1) { KEY_P[n - 1] = p; }   // at the bottom the later key wins
      continue;                                  // at the top the earlier key wins
    }
    KEY_S.push(s); KEY_P.push(p);
  }
  if (KEY_S[0] > 0) { KEY_S.unshift(0); KEY_P.unshift(KEY_P[0].clone()); }
  if (KEY_S[KEY_S.length - 1] < max) { KEY_S.push(max); KEY_P.push(KEY_P[KEY_P.length - 1].clone()); }
  PATH = new THREE.CatmullRomCurve3(KEY_P, false, 'centripetal');
}
// scroll px to curve parameter: each key sits exactly at its scroll position, eased so the bird lingers near keys
function scrollToT(y) {
  const n = KEY_S.length; if (n < 2) return 0;
  if (y <= KEY_S[0]) return 0;
  for (let k = 0; k < n - 1; k++) {
    if (y < KEY_S[k + 1]) {
      const f = (y - KEY_S[k]) / (KEY_S[k + 1] - KEY_S[k]);
      return (k + THREE.MathUtils.lerp(f, f * f * (3 - 2 * f), .45)) / (n - 1);
    }
  }
  return 1;
}
const trackPoint = (t, out = new THREE.Vector3()) => PATH ? PATH.getPoint(THREE.MathUtils.clamp(t, 0, 1), out) : out.set(.6, 0, 0);
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
// heading from a tangent; keeps the previous heading when the motion is nearly straight up or down
const yawFrom = (t, prev) => Math.hypot(t.x, t.z) > .35 * Math.abs(t.y) + 1e-4 ? Math.atan2(-t.z, t.x) : prev;
const _tan = new THREE.Vector3();
function headingAt(u) {
  if (!PATH) return { yaw: 0, pitch: 0 };
  PATH.getTangent(THREE.MathUtils.clamp(u, 0, 1), _tan);
  return { yaw: Math.atan2(-_tan.z, _tan.x), pitch: Math.atan2(_tan.y, Math.hypot(_tan.x, _tan.z)) };
}


let scrollTarget = 0, scrollP = 0, scrollVel = 0, lastScrollY = 0;
// aim slightly ahead of the scroll so the spring lag doesn't carry the bird over the copy during a crossing
const readScroll = () => { scrollTarget = scrollToT(scrollY + THREE.MathUtils.clamp(scrollVel * .1, -160, 160)); };
addEventListener('scroll', readScroll, { passive: true });

/* ---------- logo imprint: when the bird leaves the header it leaves an iridescent ASCII logo behind ---------- */
const imprint = document.querySelector('.imprint');
function showImprint(shimmer) {
  if (!imprint || imprint.classList.contains('on')) return;
  imprint.classList.add('on');
  if (shimmer) imprint.classList.add('shimmer');
}
if (mode !== 'logo') showImprint(false);   // the logo slot carries the imprint from the first frame

/* ---------- logo launch ---------- */
function startLaunch() {
  if (mode !== 'logo' || !rig.Body) return;
  mode = 'launch'; launchT = 0;
  setTimeout(() => showImprint(true), 220);
  const [hw, hh] = viewHalf(), a = dispPos.clone();
  launchPts = [a,
    new THREE.Vector3(a.x + .5, a.y - .05, .35),          // pop out toward the camera
    new THREE.Vector3(.05 * hw, .72 * hh, .75),            // sweep across the top, barrel roll
    new THREE.Vector3(.86 * hw, .42 * hh, .45),            // out to the open right side
    new THREE.Vector3(.95 * hw, -.4 * hh, .1),             // dive down the edge
    new THREE.Vector3(.5 * hw, -.62 * hh, .25),            // curl underneath
    trackPoint(scrollP)];                                  // join the track
  launchCurve = new THREE.CatmullRomCurve3(launchPts, false, 'centripetal');
}
addEventListener('scroll', () => { if (scrollY > 2) startLaunch(); }, { passive: true });
addEventListener('pointerdown', e => {
  if (e.target.closest && e.target.closest('a, button, input, select, textarea, label')) return;
  startLaunch();
});

/* ---------- page transitions: fly off in a random direction, arrive on the next page from the opposite edge ---------- */
const EXIT_ANGLES = [0, 25, 50, 90, 130, 155, 180, 205, 230, 270, 310, 335].map(d => d * Math.PI / 180);
let exitT = 0, exitDir = new THREE.Vector2(1, 0), exitFace = 1, exitHref = null, navigating = false, enterT = 0, enterCurve = null, enterPts = null;
function leave(href) {
  if (navigating || mode === 'exit') return;
  document.body.classList.remove('menu-open');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!rig.Body || reduce) { navigating = true; location.href = href; return; }
  const a = EXIT_ANGLES[(Math.random() * EXIT_ANGLES.length) | 0];
  exitDir.set(Math.cos(a), Math.sin(a));
  exitFace = Math.abs(exitDir.x) > .3 ? Math.sign(exitDir.x) : (Math.cos(yawS) >= 0 ? 1 : -1);
  if (mode === 'logo') showImprint(true);
  mode = 'exit'; exitT = 0; exitHref = href;
  store.set('hb_transit', '1'); store.set('hb_dir', a.toFixed(4));
  document.documentElement.classList.add('leaving');
  setTimeout(() => { if (!navigating) { navigating = true; location.href = href; } }, 2200);   // safety net
}
window.hbNavigate = leave;
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === '_blank' || a.hasAttribute('download')) return;
  const url = new URL(a.getAttribute('href'), location.href);
  if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return;
  if (url.pathname === location.pathname) {
    if (url.hash) return;
    e.preventDefault();
    if (mode === 'logo') startLaunch(); else scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  e.preventDefault();
  leave(url.href);
});
// coming back through the history cache: show the page again and put the bird back on its track
addEventListener('pageshow', e => {
  if (!e.persisted) return;
  document.documentElement.classList.remove('leaving', 'transit');
  navigating = false;
  if (mode === 'exit') { mode = 'flight'; dir = 1; off = 0; offTo = 0; turnT = 1; trackPoint(scrollP, dispPos); dispVel.set(0, 0, 0); }
});

/* ---------- resize ---------- */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const bw = Math.floor(w * DPR), bh = Math.floor(h * DPR);
  sceneRT.setSize(Math.max(2, bw >> 1), Math.max(2, bh >> 1));
  trailRT.setSize(Math.max(2, bw >> 2), Math.max(2, bh >> 2));
  asciiMat.uniforms.uRes.value.set(bw, bh);
  trailMat.uniforms.uAspect.value = w / h;
  asciiMat.uniforms.uAspectR.value = w / h;
  camera.aspect = w / h;
  camera.position.z = w / h < 1 ? 4.2 / Math.max(w / h, .55) : 4.2;
  camera.updateProjectionMatrix();
  buildPath(); readScroll();
}
addEventListener('resize', resize);
// rebuild the path whenever the page height or layout settles (fonts, images, edits)
let layoutH = 0, layoutTimer = 0;
new ResizeObserver(() => {
  const h = document.documentElement.scrollHeight;
  if (Math.abs(h - layoutH) < 4 && PATH) return;
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => { layoutH = document.documentElement.scrollHeight; buildPath(); readScroll(); }, 120);
}).observe(document.getElementById('content'));
document.fonts?.ready.then(() => { buildPath(); readScroll(); });
resize();

/* ---------- load model ---------- */
const rig = {};
const offset = new THREE.Group(); scene.add(offset);
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
function setRot(node, x, y, z, order = 'XYZ') {
  if (!node) return;
  _e.set(x, y, z, order); _q.setFromEuler(_e);
  node.quaternion.copy(node.userData.q0).multiply(_q);
}

// reduced motion: no flying bird; the static imprint logo stands in for it
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (REDUCE_MOTION) { canvas.style.display = 'none'; showImprint(false); document.documentElement.classList.remove('transit'); }
else fetch('/hummingbird/assets/hummingbird.glb').then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(bin => new GLTFLoader().parse(bin, '', gltf => {
  gltf.scene.traverse(o => {
    if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = birdMat; o.frustumCulled = false; }
    o.userData.q0 = o.quaternion.clone();
    if (o.name) rig[o.name] = o;
  });
  offset.add(gltf.scene);
  const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
  birdLen = Math.max(size.x, size.z);
  offset.userData.pivot = rig.Body.position.clone();
  gltf.scene.position.copy(rig.Body.position).multiplyScalar(-1);
  resize(); buildAtlas(); requestAnimationFrame(loop);
}, err => { throw err; })).catch(err => { document.documentElement.classList.remove('transit'); showImprint(false); console.error('Hummingbird model failed to load', err); });

/* ---------- loop ---------- */
const swoop = new THREE.Vector3(), dispPos = new THREE.Vector3(), dispVel = new THREE.Vector3(), chase = new THREE.Vector3(), _acc = new THREE.Vector3();
let launchT = 0, launchPts = null, launchCurve = null, rollExtra = 0, birdScale = mode === 'logo' ? .2 : flightScale, placed = false;
const _tan2 = new THREE.Vector3(), _tan3 = new THREE.Vector3(), _proj = new THREE.Vector3();
function slotWorld(out) {
  const r = ui('birdSlot').getBoundingClientRect();
  _ndc.set(((r.left + r.width / 2) / innerWidth) * 2 - 1, 1 - ((r.top + r.height / 2) / innerHeight) * 2);
  _ray.setFromCamera(_ndc, camera);
  _plane.set(_n.set(0, 0, 1), 0);
  _ray.ray.intersectPlane(_plane, out);
  return out;
}
function logoScale() {
  const unitsPerPx = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / innerHeight;
  return ui('birdSlot').offsetWidth * 1.3 * unitsPerPx;
}
let enterYaw = 0, idleS = 1, revT = 0, dir = 1, off = 0, offFrom = 0, offTo = 0, turnT = 1, turnDur = 1, turnPulse = 0, last = performance.now(), time = 0, phase = 0, bank = 0, yawS = 0, turnS = 0, headSnap = 0, headYaw = 0, headPitch = 0;
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _plane = new THREE.Plane(), _n = new THREE.Vector3();
const _hp = new THREE.Vector3(), _tgt = new THREE.Vector3(), _nq = new THREE.Quaternion();
const _perch = new THREE.Vector3(), _box = new THREE.Box3();
const FEATHERS = [['L2', -2], ['L1', -1], ['C', 0], ['R1', 1], ['R2', 2]];

function loop(now, manual) {
  const dt = THREE.MathUtils.clamp((now - last) / 1000, 0, 1 / 20); last = now; time += dt;

  const mv = mouse.distanceTo(lastMouse); lastMouse.copy(mouse);
  vel += (Math.min(mv * 30, 1) - vel) * .18;
  for (let i = TRAIL - 1; i > 0; i--) {
    trailPts[i].lerp(trailPts[i - 1], .5);
    trailStr[i] += (trailStr[i - 1] * .985 - trailStr[i]) * .5;
  }
  trailPts[0].copy(mouse); trailStr[0] = vel;

  if (dt > 0) { scrollVel += ((scrollY - lastScrollY) / dt - scrollVel) * Math.min(1, dt * 4); lastScrollY = scrollY; }
  readScroll();
  const scrollGap = Math.abs(scrollTarget - scrollP);
  const onTrack = mode === 'flight';
  // only turn around after the scroll has clearly reversed for a moment, so flicks and jitter don't spin the bird
  const nd = Math.sign(scrollTarget - scrollP);
  revT = onTrack && !perched && scrollGap > .006 && nd !== dir ? revT + dt : 0;
  if (revT > .18) {
    revT = 0;
    {
      dir = nd; offFrom = off; offTo = dir > 0 ? 0 : Math.PI;
      turnDur = Math.max(.15, 1.0 * Math.abs(offTo - offFrom) / Math.PI); turnT = 0;
      swoop.copy(dispPos);
    }
  }
  if (turnT < 1) {
    turnT = Math.min(1, turnT + dt / turnDur);
    const te = turnT * turnT * (3 - 2 * turnT);
    off = offFrom + (offTo - offFrom) * te;
    turnPulse = Math.sin(Math.PI * turnT) * Math.sign(offTo - offFrom) * Math.abs(offTo - offFrom) / Math.PI;
  } else turnPulse = 0;
  const fwd = Math.cos(off);
  // follow the scroll, but never race through more than a slice of the path at once
  const MAX_LAG = .1;
  if (scrollTarget - scrollP > MAX_LAG) scrollP = scrollTarget - MAX_LAG;
  else if (scrollP - scrollTarget > MAX_LAG) scrollP = scrollTarget + MAX_LAG;
  scrollP += THREE.MathUtils.clamp((scrollTarget - scrollP) * Math.min(1, dt * 6), -dt * .45, dt * .45);
  let idle = 1 - THREE.MathUtils.smoothstep(scrollGap, .002, .02);
  // once the footer rule comes up the screen the bird stops flying the path and lands on it
  const vhp = innerHeight, l1 = perchPage - scrollY, l2 = perchBase - scrollY;
  // the footer rule is the perch; deeper in the footer it hops down to the rule above the base row
  const anchor = (l1 < vhp * .16 && l2 > vhp * .22 && l2 < vhp * .96) ? 2 : 1;
  const lineY = anchor === 2 ? l2 : l1;
  const wasPerched = perched;
  perched = mode === 'flight' && perchPage > 0 && l1 < vhp * (perched ? 1.06 : .97);
  if (wasPerched && !perched) dispVel.y += 1.1;   // push off the line on the way back up
  if (perched && anchor !== perchAnchor) hopT = .5;            // let the spring carry the hop
  perchAnchor = anchor;
  hopT = Math.max(0, hopT - dt);
  perchK += ((perched ? 1 : 0) - perchK) * Math.min(1, dt * (perched ? 2.4 : 4.5));
  idle = Math.max(idle, perchK);
  const pos = trackPoint(scrollP);
  const h = headingAt(scrollP);
  const e = .25 / Math.max(1, KEY_S.length - 1), kappa = wrapA(headingAt(scrollP + e).yaw - headingAt(scrollP - e).yaw) / (2 * e) * (e / .012);

  const dart = Math.sin(time * .9) * .05 + Math.sin(time * 2.1 + 1.3) * .03 + Math.sin(time * .37) * .06;
  const dartV = Math.cos(time * .9) * .045 + Math.cos(time * 2.1 + 1.3) * .063 + Math.cos(time * .37) * .022;

  let yawGoal = h.yaw + off;
  let pitchBase = h.pitch * .7 * fwd + Math.abs(turnPulse) * .25;
  let bankPath = THREE.MathUtils.clamp(-fwd * kappa * .075, -1.2, 1.2) - turnPulse * 1.15;
  let scaleGoal = flightScale, hardLock = false;
  rollExtra = 0;

  if (mode === 'logo') {
    idle = 1; hardLock = true;
    slotWorld(chase);
    yawGoal = -.35 + Math.sin(time * .8) * .25; pitchBase = .05; bankPath = 0;
    scaleGoal = logoScale();
  } else if (mode === 'launch') {
    idle = 0; hardLock = true;
    launchT = Math.min(1, launchT + dt / 3.2);
    const s = launchT * launchT * (3 - 2 * launchT);
    trackPoint(scrollP, launchPts[launchPts.length - 1]);
    launchCurve.updateArcLengths();
    launchCurve.getPointAt(s, chase);
    launchCurve.getTangentAt(s, _tan2);
    launchCurve.getTangentAt(Math.min(1, s + .03), _tan3);
    yawGoal = Math.atan2(-_tan2.z, _tan2.x);
    pitchBase = Math.atan2(_tan2.y, Math.hypot(_tan2.x, _tan2.z)) * .6;
    bankPath = THREE.MathUtils.clamp(-wrapA(Math.atan2(-_tan3.z, _tan3.x) - yawGoal) / .03 * .06, -1.3, 1.3);
    rollExtra = -Math.PI * 2 * THREE.MathUtils.smootherstep(s, .22, .5);
    scaleGoal = THREE.MathUtils.lerp(logoScale(), flightScale, THREE.MathUtils.smoothstep(s, .02, .45));
    if (launchT >= 1) { mode = 'flight'; dir = 1; off = 0; offTo = 0; turnT = 1; rollExtra = 0; }
  } else if (mode === 'enter') {
    // new page: arrive from the edge opposite the exit, still heading the way it left, then curl onto the track
    idle = 0; hardLock = true;
    const end = trackPoint(scrollP), [hw, hh] = viewHalf();
    if (!enterCurve) {
      const d = new THREE.Vector2(Math.cos(enterAngle), Math.sin(enterAngle));
      const reach = Math.min(Math.abs(d.x) > 1e-3 ? (hw + .8) / Math.abs(d.x) : 1e9, Math.abs(d.y) > 1e-3 ? (hh + .75) / Math.abs(d.y) : 1e9);
      const p0 = new THREE.Vector3(-d.x * reach, -d.y * reach, .2);
      const swing = (Math.random() < .5 ? -1 : 1) * .22 * hh;
      const p1 = new THREE.Vector3(p0.x + d.x * reach * .55 - d.y * swing, p0.y + d.y * reach * .55 + d.x * swing, .3);
      enterPts = [p0, p1, p1.clone().lerp(end, .55).setZ(.2), end.clone()];
      enterCurve = new THREE.CatmullRomCurve3(enterPts, false, 'centripetal');
      yawS = enterYaw = Math.abs(d.x) > .3 ? (d.x > 0 ? 0 : Math.PI) : (end.x >= p0.x ? 0 : Math.PI);
      document.documentElement.classList.remove('transit');
    }
    enterT = Math.min(1, enterT + dt / 2.0);
    const s = 1 - Math.pow(1 - enterT, 2.4);   // arrive fast, settle gently
    enterPts[enterPts.length - 1].copy(end);
    enterCurve.updateArcLengths();
    enterCurve.getPointAt(s, chase);
    enterCurve.getTangentAt(s, _tan2);
    enterCurve.getTangentAt(Math.min(1, s + .03), _tan3);
    yawGoal = enterYaw = yawFrom(_tan2, enterYaw);
    pitchBase = THREE.MathUtils.clamp(Math.atan2(_tan2.y, Math.hypot(_tan2.x, _tan2.z)) * .6, -.9, .9);
    bankPath = THREE.MathUtils.clamp(-wrapA(yawFrom(_tan3, yawGoal) - yawGoal) / .03 * .06, -1.3, 1.3);
    if (enterT >= 1) { mode = 'flight'; dir = 1; off = 0; offTo = 0; turnT = 1; }
  } else if (mode === 'exit') {
    idle = 0; exitT += dt;
    yawGoal = exitFace > 0 ? 0 : Math.PI; bankPath = 0;
    pitchBase = THREE.MathUtils.clamp(Math.atan2(exitDir.y, Math.max(Math.abs(exitDir.x), .4)) * .9, -1.15, 1.15);
  }

  // posture follows a slowed idle value, so stop and start scrolling doesn't flip the bird back and forth
  idleS += (idle - idleS) * Math.min(1, dt * (idle > idleS ? 1.6 : 4));
  if (mode !== 'flight') idleS = idle;

  // resting keeps the heading it flew in on, so stopping and starting never swings the bird around;
  // on the perch it sits in profile, looking back toward the page
  if (mode === 'flight' && perchK > 0) yawGoal += wrapA((perchX > 0 ? Math.PI : 0) - yawGoal) * perchK;

  // turn at a capped rate so sudden heading changes become a swing, not a snap
  const yawErr = wrapA(yawGoal - yawS), yawRate = mode === 'launch' || mode === 'enter' ? 14 : 4.5;
  yawS += THREE.MathUtils.clamp(yawErr * Math.min(1, dt * (mode === 'launch' || mode === 'enter' ? 12 : 6)), -yawRate * dt, yawRate * dt);
  const bankTarget = THREE.MathUtils.clamp(bankPath - dartV * 3. * idleS, -1.1, 1.1);
  bank += (bankTarget - bank) * Math.min(1, dt * 3);
  const cres = Math.min(Math.abs(bank), 1.4);

  look.x += ((mouse.x - .5) - look.x) * Math.min(1, dt * 2.5);
  look.y += ((mouse.y - .5) - look.y) * Math.min(1, dt * 2.5);

  const bob = Math.sin(time * 2.3) * .025;
  if (onTrack) {
    if (turnT < 1) {
      const sp = .95 * (1 - turnT * .6);
      swoop.x += Math.cos(yawS) * sp * dt;
      swoop.z += -Math.sin(yawS) * sp * dt;
      swoop.y += Math.abs(turnPulse) * .35 * dt;
      const w = THREE.MathUtils.smoothstep(turnT, .45, 1);
      chase.copy(swoop).lerp(pos, w);
    } else chase.copy(pos);
    // keep the whole bird on screen, even mid swoop
    const edge = viewHalf()[0] - birdLen * flightScale * .52;
    chase.x = THREE.MathUtils.clamp(chase.x, -edge, edge);
    if (perchK > .001) {
      const hh2 = viewHalf()[1];
      // a tall footer can carry its rule off the top of the screen, so keep the landing in view
      const ly = THREE.MathUtils.clamp(lineY, innerHeight * .06, innerHeight * .97);
      // how far the lowest point sits under the body right now, so the feet land on the rule
      _box.setFromObject(offset);
      // the box corners overshoot the drawn silhouette, so add a slice of the height back to sit it on the rule
      const drop = Number.isFinite(_box.min.y)
        ? dispPos.y - _box.min.y + (_box.max.y - _box.min.y) * .09 : perchLift;
      _perch.set(perchX, (.5 - ly / innerHeight) * 2 * hh2 + drop, 0);
      chase.lerp(_perch, perchK * perchK * (3 - 2 * perchK));
    }
  }
  if (!placed) { placed = true; dispPos.copy(mode === 'logo' ? slotWorld(_tgt) : chase); }
  if (perchK > .985 && hopT <= 0 && mode === 'flight') {   // sitting: locked to the rule, scroll moves it with the page and nothing else does
    dispPos.copy(chase); dispVel.set(0, 0, 0);
  } else if (hardLock) {
    dispVel.copy(chase).sub(dispPos).divideScalar(Math.max(dt, 1e-3));
    dispPos.copy(chase);
  } else if (mode === 'exit') {
    // accelerate off screen, then load the next page
    dispVel.x += exitDir.x * 5.5 * dt; dispVel.y += (exitDir.y * 5.5 + .3) * dt; dispVel.z *= .95;
    dispPos.addScaledVector(dispVel, dt);
    _proj.copy(dispPos).project(camera);
    if (!navigating && (Math.abs(_proj.x) > 1.45 || Math.abs(_proj.y) > 1.5 || exitT > 1.8)) { navigating = true; location.href = exitHref; }
  } else {
    // damped spring with a top speed, so anchor jumps become flight instead of teleports
    for (let s = 0; s < 2; s++) {
      const h2 = dt / 2;
      _acc.copy(chase).sub(dispPos).multiplyScalar(40).addScaledVector(dispVel, -12.6);
      dispVel.addScaledVector(_acc, h2);
      const vmax = 2.8; if (dispVel.length() > vmax) dispVel.setLength(vmax);
      dispPos.addScaledVector(dispVel, h2);
    }
  }
  birdScale += (scaleGoal - birdScale) * Math.min(1, dt * (mode === 'launch' ? 30 : 8));
  offset.scale.setScalar(birdScale);
  const live = 1 - perchK;                    // hover jitter dies out completely on the perch
  offset.position.set(dispPos.x + dart * idleS * birdScale * live,
                      dispPos.y + bob * birdScale * live, dispPos.z);

  const wantCell = (mode === 'logo' || (mode === 'launch' && launchT < .18)) ? Math.max(4, params.cell - 3) : 0;
  if (wantCell !== cellOverride) { cellOverride = wantCell; buildAtlas(); }

  const yaw = yawS + dartV * 1.2 * idleS * live + bank * .15;
  const pitch = THREE.MathUtils.lerp(pitchBase + Math.sin(time * 2.3 + 1) * .03 - cres * .12, .05, perchK);
  setRot(rig.Body, (bank + rollExtra) * (1 - perchK), yaw, pitch, 'YZX');

  if (rig.Neck) {
    _ray.setFromCamera(_ndc.set(mouse.x * 2 - 1, mouse.y * 2 - 1), camera);
    rig.Head.getWorldPosition(_hp);
    _plane.set(_n.set(0, 0, 1), -(_hp.z + .9));
    if (_ray.ray.intersectPlane(_plane, _tgt)) {
      rig.Neck.getWorldQuaternion(_nq).invert();
      _tgt.sub(_hp).applyQuaternion(_nq);
      const ty = THREE.MathUtils.clamp(Math.atan2(-_tgt.z, _tgt.x), -1.5, 1.5);
      const tp = THREE.MathUtils.clamp(Math.atan2(_tgt.y, Math.hypot(_tgt.x, _tgt.z)), -.7, .7);
      headYaw += (ty * idleS - headYaw) * Math.min(1, dt * 6);
      headPitch += (tp * idleS - headPitch) * Math.min(1, dt * 6);
    }
  }

  turnS += (THREE.MathUtils.clamp(fwd * kappa * .04 + turnPulse * .7 + dartV * 3. * idleS, -1.2, 1.2) - turnS) * Math.min(1, dt * 3);
  const w = time * 3.1;
  headSnap += ((Math.round(Math.sin(time * .55) * 1.5 + Math.sin(time * 1.3) * .6) * .18) * (1 - idleS) - headSnap) * Math.min(1, dt * 9);
  setRot(rig.Hips, Math.sin(w + 1.2) * .05, -turnS * .35 + Math.sin(w * .6) * .06, Math.sin(w) * .09 - pitch * .3 - cres * .55, 'YZX');
  setRot(rig.Chest, Math.sin(w * .6 + .5) * .04, turnS * .2 + Math.sin(w * .6 + .9) * .05, Math.sin(w + .9) * .06 + cres * .3, 'YZX');
  setRot(rig.Neck, 0, turnS * .25 + headYaw * .4, Math.sin(w + 1.8) * .07 + cres * .3 + headPitch * .35, 'YZX');
  setRot(rig.Head, Math.sin(time * 1.7) * .14 * (1 - idleS * .6) - bank * .3, turnS * .25 + headSnap + headYaw * .6, Math.sin(w + 2.7) * -.05 + cres * .25 + headPitch * .65, 'YZX');

  // perched, the wings wind down and close against the body rather than cutting out mid beat
  phase += dt * THREE.MathUtils.lerp(params.flap, 4, perchK);
  const beat = Math.sin(phase), sweep = Math.sin(phase * 2) * .22 * live;
  const amp = (.5 + Math.abs(bank) * .15) * live;
  const L = THREE.MathUtils.lerp;
  setRot(rig.WingR, L(.28 + beat * amp, FOLD.x, perchK), L(sweep, FOLD.y, perchK), L(0, FOLD.z, perchK));
  setRot(rig.WingL, L(-(.28 + beat * amp), -FOLD.x, perchK), L(-sweep, -FOLD.y, perchK), L(0, -FOLD.z, perchK));
  const ws = L(1, FOLD.scale, perchK);
  if (rig.WingR) rig.WingR.scale.setScalar(ws);
  if (rig.WingL) rig.WingL.scale.setScalar(ws);

  const lift = Math.sin(time * 2.3 + 1.4) * .07 * live - pitch * .5 - cres * .45 + perchK * FOLD.tail;
  setRot(rig.Tail, 0, -bank * .5, lift);
  const fan = .04 + Math.sin(time * 1.4) * .035 + cres * .25 + (onTrack ? scrollP * .2 : 0);
  const curl = .08 + Math.sin(time * 2.3 + 2.2) * .08 + lift * .6;
  for (const [id, s] of FEATHERS) {
    setRot(rig['Tail_' + id], 0, s * fan * .5 + bank * .1, 0);
    setRot(rig['Tail_' + id + '_Tip'], 0, s * fan * .25, curl);
  }

  updateTextRipple();

  scene.updateMatrixWorld();
  birdMat.uniforms.uBodyInv.value.setFromMatrix4(rig.Body.matrixWorld).transpose();
  renderer.setRenderTarget(sceneRT); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  renderer.setRenderTarget(trailRT); renderer.clear(); renderer.render(trailScene, quadCam);
  renderer.setRenderTarget(null);
  const u = asciiMat.uniforms;
  u.uBandC.value = 1 - (bandPage - scrollY) / innerHeight;   // page position to screen, bottom up
  u.uTime.value = time; u.uShimmer.value = params.shim; u.uIdle.value = params.idle; u.uRaw.value = params.raw ? 1 : 0;
  renderer.render(asciiScene, quadCam);

  if (!manual) requestAnimationFrame(loop);
}

// ?debug exposes a small hook for testing the path without waiting on real frames
if (new URLSearchParams(location.search).has('debug')) window.__bird = {
  step(n = 60) { for (let i = 0; i < n; i++) loop(last + 1000 / 60, true); },
  launch: () => startLaunch(),
  keys: () => KEY_S.map((s, i) => [Math.round(s), KEY_P[i].toArray().map(v => +v.toFixed(2))]),
  screen() { const v = offset.position.clone().project(camera); return [Math.round((v.x + 1) / 2 * innerWidth), Math.round((1 - v.y) / 2 * innerHeight)]; },
  bbox() { const bx = new THREE.Box3().setFromObject(offset), r = [Infinity, Infinity, -Infinity, -Infinity], v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) { v.set(i & 1 ? bx.max.x : bx.min.x, i & 2 ? bx.max.y : bx.min.y, i & 4 ? bx.max.z : bx.min.z).project(camera);
      const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight; r[0] = Math.min(r[0], x); r[1] = Math.min(r[1], y); r[2] = Math.max(r[2], x); r[3] = Math.max(r[3], y); }
    return r.map(Math.round); },
  get scale() { return flightScale; },
  setBand(page) { bandPage = page; },
  rig, fold: FOLD,
  get pose() { return { yaw: yawS, bank, idle: idleS, off, dir, turnT }; },
  get perch() { return { on: perched, k: +perchK.toFixed(3), page: Math.round(perchPage), base: Math.round(perchBase), anchor: perchAnchor, x: +perchX.toFixed(2) }; },
  get band() { const u = asciiMat.uniforms; return { center: +u.uBandC.value.toFixed(3), half: +u.uBandH.value.toFixed(3), page: Math.round(bandPage) }; },
  // poses the bird exactly as the header logo draws it, at a chosen wing phase and moment
  logoPose(ph = 0, t = 0) { mode = 'logo'; phase = ph; time = t; loop(last, true); },
  // the bird's silhouette at real resolution, as rows of 0 and 1 (used to trace a line drawing of the logo)
  logoBitmap(cols = 200) {
    const W = 1200, H = 800, rt = new THREE.WebGLRenderTarget(W, H);
    const keep = { p: offset.position.clone(), s: offset.scale.x, a: camera.aspect };
    offset.position.set(0, 0, 0); offset.scale.setScalar(1.6);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    scene.updateMatrixWorld();
    birdMat.uniforms.uBodyInv.value.setFromMatrix4(rig.Body.matrixWorld).transpose();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera); renderer.setRenderTarget(null);
    const px = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); rt.dispose();
    offset.position.copy(keep.p); offset.scale.setScalar(keep.s); camera.aspect = keep.a; camera.updateProjectionMatrix();
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cw = (x1 - x0 + 1) / cols, rows = Math.max(1, Math.round((y1 - y0 + 1) / cw)), out = [];
    for (let r = rows - 1; r >= 0; r--) {          // pixels arrive bottom up
      let line = '';
      for (let c = 0; c < cols; c++) {
        let hit = 0, tot = 0;
        for (let y = Math.floor(y0 + r * cw); y < Math.min(y1 + 1, Math.floor(y0 + (r + 1) * cw)); y++)
          for (let x = Math.floor(x0 + c * cw); x < Math.min(x1 + 1, Math.floor(x0 + (c + 1) * cw)); x++) { tot++; if (px[(y * W + x) * 4 + 3] > 8) hit++; }
        line += hit / Math.max(1, tot) > .35 ? '1' : '0';
      }
      out.push(line);
    }
    return out.join('\n');
  },
  // renders the bird in its logo pose and returns it as rows of glyphs (used to make the logo imprint)
  logoGrid(cols = 40, beat = 1, yaw = -.35, glyphs = params.glyphs) {
    const W = 900, H = 600, rt = new THREE.WebGLRenderTarget(W, H);
    const keep = { p: offset.position.clone(), s: offset.scale.x, a: camera.aspect };
    offset.position.set(0, 0, 0); offset.scale.setScalar(1.6);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    if (yaw !== null) {   // null keeps the pose the live loop just set (see logoPose)
      setRot(rig.Body, 0, yaw, .05, 'YZX');
      for (const n of ['Hips', 'Chest', 'Neck', 'Head', 'Tail']) setRot(rig[n], 0, 0, 0);
      setRot(rig.WingR, .28 + beat * .5, 0, 0); setRot(rig.WingL, -(.28 + beat * .5), 0, 0);
      for (const [id, k] of FEATHERS) { setRot(rig['Tail_' + id], 0, k * .08, 0); setRot(rig['Tail_' + id + '_Tip'], 0, k * .04, .1); }
    }
    scene.updateMatrixWorld();
    birdMat.uniforms.uBodyInv.value.setFromMatrix4(rig.Body.matrixWorld).transpose();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera); renderer.setRenderTarget(null);
    const px = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); rt.dispose();
    offset.position.copy(keep.p); offset.scale.setScalar(keep.s); camera.aspect = keep.a; camera.updateProjectionMatrix();
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 3) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cell = (x1 - x0 + 1) / cols, rows = Math.ceil((y1 - y0 + 1) / cell), g = [...glyphs], n = g.length - 1, out = [];
    for (let r = rows - 1; r >= 0; r--) {   // pixels are bottom up
      let line = '';
      for (let c = 0; c < cols; c++) {
        let sum = 0, hit = 0, tot = 0;
        for (let y = Math.floor(y0 + r * cell); y < Math.min(y1 + 1, Math.floor(y0 + (r + 1) * cell)); y++)
          for (let x = Math.floor(x0 + c * cell); x < Math.min(x1 + 1, Math.floor(x0 + (c + 1) * cell)); x++) {
            const i = (y * W + x) * 4; tot++; if (px[i + 3] > 3) { hit++; sum += px[i] / 255; } }
        line += hit / Math.max(1, tot) < .3 ? ' ' : (g[Math.floor(Math.min(1, sum / hit) * n + .5)] || ' ');
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out.join('\n');
  },
  get mode() { return mode; }
};
