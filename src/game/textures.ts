import * as THREE from 'three';

export interface ProceduralTextureSet {
  limestoneTile: THREE.CanvasTexture;
  mattePlaster: THREE.CanvasTexture;
  pastelWood: THREE.CanvasTexture;
  brushedBrass: THREE.CanvasTexture;
  contactShadow: THREE.CanvasTexture;
  skyGradient: THREE.CanvasTexture;
  dispose: () => void;
}

function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function configureTexture(
  canvas: HTMLCanvasElement,
  maxAnisotropy: number,
  repeatX = 1,
  repeatY = 1,
  wrap = true,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  if (wrap) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
  }
  tex.needsUpdate = true;
  return tex;
}

function createLimestoneTileCanvas(): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeSeededRandom(4217);

  // Warm sunlit travertine limestone base
  ctx.fillStyle = '#eee8dc';
  ctx.fillRect(0, 0, size, size);

  // Subtle multi-tile color variation (4x4 slabs)
  const cells = 4;
  const step = size / cells;
  for (let gx = 0; gx < cells; gx++) {
    for (let gy = 0; gy < cells; gy++) {
      const shade = Math.floor((rand() - 0.5) * 14);
      const r = 238 + shade;
      const g = 232 + shade;
      const b = 220 + shade;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(gx * step + 2, gy * step + 2, step - 4, step - 4);
    }
  }

  // Fine mineral speckling
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const rad = 0.6 + rand() * 1.5;
    const dark = rand() > 0.45;
    ctx.fillStyle = dark ? 'rgba(148, 136, 118, 0.14)' : 'rgba(255, 253, 248, 0.25)';
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Clean recessed mortar seams
  ctx.strokeStyle = 'rgba(176, 165, 148, 0.55)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= cells; i++) {
    const pos = i * step;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, size);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, pos);
    ctx.lineTo(size, pos);
    ctx.stroke();
  }

  // Subtle sunlit inner bevel edge
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1.5;
  for (let gx = 0; gx < cells; gx++) {
    for (let gy = 0; gy < cells; gy++) {
      ctx.strokeRect(gx * step + 3, gy * step + 3, step - 6, step - 6);
    }
  }

  return canvas;
}

function createMattePlasterCanvas(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeSeededRandom(9133);

  ctx.fillStyle = '#f6f3ee';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 2000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1 + rand() * 3.5;
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(215, 208, 198, 0.14)' : 'rgba(255, 255, 255, 0.18)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle ashlar stone horizontal courses
  ctx.strokeStyle = 'rgba(165, 155, 145, 0.16)';
  ctx.lineWidth = 2;
  for (let y = 32; y < size; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  return canvas;
}

function createPastelWoodCanvas(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeSeededRandom(7731);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Soft painted wood grain lines (multiplicative with material color)
  for (let y = 0; y < size; y += 3) {
    const alpha = 0.03 + rand() * 0.045;
    ctx.fillStyle = `rgba(90, 75, 65, ${alpha.toFixed(3)})`;
    ctx.fillRect(0, y, size, 1.5);
  }

  // Subtle chamfer frame border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, size - 10, size - 10);

  ctx.strokeStyle = 'rgba(60, 50, 45, 0.12)';
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, size - 24, size - 24);

  return canvas;
}

function createBrushedBrassCanvas(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeSeededRandom(5519);

  ctx.fillStyle = '#d9b974';
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y += 2) {
    const v = rand() > 0.5 ? 'rgba(255, 246, 214, 0.14)' : 'rgba(138, 102, 42, 0.14)';
    ctx.fillStyle = v;
    ctx.fillRect(0, y, size, 1);
  }

  return canvas;
}

function createContactShadowCanvas(): HTMLCanvasElement {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;
  const grad = ctx.createRadialGradient(cx, cx, size * 0.06, cx, cx, size * 0.48);
  grad.addColorStop(0, 'rgba(38, 48, 66, 0.48)');
  grad.addColorStop(0.55, 'rgba(38, 48, 66, 0.18)');
  grad.addColorStop(1, 'rgba(38, 48, 66, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function createSkyGradientCanvas(): HTMLCanvasElement {
  const width = 32;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, height);
  // Zenith alpine azure -> mid pastel sky -> soft warm horizon peach-cream -> alpine valley mist
  grad.addColorStop(0.0, '#6db3ee');
  grad.addColorStop(0.28, '#9dd0f7');
  grad.addColorStop(0.47, '#d6ebf8');
  grad.addColorStop(0.52, '#f5ebe0');
  grad.addColorStop(0.62, '#e4edf4');
  grad.addColorStop(1.0, '#bfd4e5');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

export function createProceduralTextures(maxAnisotropy: number): ProceduralTextureSet {
  const limestoneTile = configureTexture(createLimestoneTileCanvas(), maxAnisotropy, 10, 10);
  const mattePlaster = configureTexture(createMattePlasterCanvas(), maxAnisotropy, 2, 2);
  const pastelWood = configureTexture(createPastelWoodCanvas(), maxAnisotropy, 1, 1);
  const brushedBrass = configureTexture(createBrushedBrassCanvas(), maxAnisotropy, 2, 2);

  const contactShadow = new THREE.CanvasTexture(createContactShadowCanvas());
  contactShadow.colorSpace = THREE.SRGBColorSpace;
  contactShadow.needsUpdate = true;

  const skyGradient = new THREE.CanvasTexture(createSkyGradientCanvas());
  skyGradient.colorSpace = THREE.SRGBColorSpace;
  skyGradient.wrapS = THREE.ClampToEdgeWrapping;
  skyGradient.wrapT = THREE.ClampToEdgeWrapping;
  skyGradient.needsUpdate = true;

  return {
    limestoneTile,
    mattePlaster,
    pastelWood,
    brushedBrass,
    contactShadow,
    skyGradient,
    dispose() {
      limestoneTile.dispose();
      mattePlaster.dispose();
      pastelWood.dispose();
      brushedBrass.dispose();
      contactShadow.dispose();
      skyGradient.dispose();
    },
  };
}
