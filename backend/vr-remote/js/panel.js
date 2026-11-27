/**
 * In-scene UI panels for the WebXR client.
 *
 * Inside an immersive-vr session there is no DOM, so every piece of UI is a
 * quad textured with a 2D canvas we render ourselves. A UIPanel owns:
 *   canvas + CanvasTexture + PlaneGeometry quad (mesh.userData.uiPanel back-ref)
 *   a list of rectangular hit regions in canvas pixel space
 *   a redraw callback supplied by the consumer (it draws everything, using
 *   panel.hoverId to highlight the hovered region)
 *
 * Hover/select plumbing lives in main.js: it raycasts controller rays
 * against panel meshes, then feeds the intersection UV back here.
 */

import * as THREE from '../vendor/three/three.module.js';
import { hitRegion } from './util.js';

export class UIPanel {
  /**
   * @param {object} opts
   * @param {number} opts.worldWidth  quad width in meters
   * @param {number} opts.pixelWidth  canvas width in px
   * @param {number} opts.pixelHeight canvas height in px
   */
  constructor({ worldWidth, pixelWidth, pixelHeight }) {
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;

    this.canvas = document.createElement('canvas');
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    const worldHeight = worldWidth * (pixelHeight / pixelWidth);
    this.geometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.uiPanel = this;

    /** @type {Array<{x:number,y:number,w:number,h:number,id:string,onClick:Function,disabled?:boolean}>} */
    this.regions = [];
    this.hoverId = null;
    this.drawFn = null;
  }

  /** Consumer draws the whole panel; called on every redraw. */
  setDraw(fn) {
    this.drawFn = fn;
    this.redraw();
  }

  setRegions(regions) {
    this.regions = regions || [];
  }

  redraw() {
    this.ctx.clearRect(0, 0, this.pixelWidth, this.pixelHeight);
    if (this.drawFn) this.drawFn(this);
    this.texture.needsUpdate = true;
  }

  /** Update hover from an intersection UV; returns true if it changed. */
  handleHover(uv) {
    const region = hitRegion(this.regions, uv.x, uv.y, this.pixelWidth, this.pixelHeight);
    const id = region ? region.id : null;
    if (id === this.hoverId) return false;
    this.hoverId = id;
    this.redraw();
    return true;
  }

  clearHover() {
    if (this.hoverId === null) return;
    this.hoverId = null;
    this.redraw();
  }

  /**
   * Fire the clicked region's handler (unless disabled). Returns whether a
   * region hit. The handler receives (region, uv) so position-sensitive
   * controls (the seek bar) know where on the region the press landed.
   */
  activate(uv) {
    const region = hitRegion(this.regions, uv.x, uv.y, this.pixelWidth, this.pixelHeight);
    if (!region || region.disabled || typeof region.onClick !== 'function') return false;
    region.onClick(region, uv);
    return true;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shared canvas drawing helpers (all in canvas pixel space)
// ---------------------------------------------------------------------------

export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

export function drawPanelBackground(ctx, w, h, { fill = 'rgba(14, 16, 26, 0.94)', border = 'rgba(120, 130, 170, 0.35)' } = {}) {
  roundRect(ctx, 4, 4, w - 8, h - 8, 22);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Draw a button over `region` (a hit region), honouring hover/disabled and
 * the panel's current hoverId. Label auto-sizes down a notch if it would
 * overflow the region.
 */
export function drawButton(ctx, region, panel, { fontSize = 30, base = '#2a3050', hover = '#3d4a7a', disabledColor = '#1b1f30', text = '#e8ecf8' } = {}) {
  const hovered = panel.hoverId === region.id;
  roundRect(ctx, region.x, region.y, region.w, region.h, 12);
  ctx.fillStyle = region.disabled ? disabledColor : (hovered ? hover : base);
  ctx.fill();
  if (hovered && !region.disabled) {
    ctx.strokeStyle = '#7ea2ff';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.fillStyle = region.disabled ? '#5a6070' : text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = fontSize;
  ctx.font = `${size}px "Noto Sans JP", "Hiragino Kaku Gothic ProN", sans-serif`;
  while (ctx.measureText(region.label).width > region.w - 16 && size > 14) {
    size -= 2;
    ctx.font = `${size}px "Noto Sans JP", "Hiragino Kaku Gothic ProN", sans-serif`;
  }
  ctx.fillText(region.label, region.x + region.w / 2, region.y + region.h / 2 + 2);
}

/** Truncate `text` with an ellipsis so it fits `maxWidth` under the current font. */
export function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '…';
}
