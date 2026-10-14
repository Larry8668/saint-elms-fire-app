import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { OrthographicCamera } from 'three';
import { boundsCenter, type Bounds } from './layout';

/** Screen space (px) covered by overlays; framing centres content in what is left. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FrameRequest {
  /** Change the key to re-run framing, even for the same bounds. */
  key: string;
  bounds: Bounds;
  maxZoom: number;
  instant?: boolean;
}

export interface MapCameraApi {
  zoomBy: (factor: number) => void;
  /** True if the last pointer gesture moved far enough to count as a drag, not a click. */
  wasDrag: () => boolean;
}

interface Goal {
  x: number;
  y: number;
  zoom: number;
}

const DRAG_THRESHOLD_PX = 4;
const FRAME_PAD_PX = 32;
const EASE_PER_SECOND = 7;

/**
 * Map-style orthographic camera: drag pans (content follows the pointer), wheel or pinch zooms
 * toward the cursor, and framing requests ease the camera so a target sits in the visible area.
 */
export function MapCamera({
  ref,
  frame,
  insets,
  minZoom,
  maxZoom,
  onZoom,
}: {
  ref?: Ref<MapCameraApi>;
  frame: FrameRequest;
  insets: Insets;
  minZoom: number;
  maxZoom: number;
  onZoom: (zoom: number) => void;
}) {
  const { camera, gl, size, invalidate } = useThree();
  const cam = camera as OrthographicCamera;
  const goal = useRef<Goal | null>(null);
  const dragged = useRef(false);
  const touchedSinceFrame = useRef(false);
  const lastZoom = useRef(0);

  const clampZoom = (z: number) => Math.min(maxZoom, Math.max(minZoom, z));

  const goalFor = (req: FrameRequest): Goal => {
    const b = req.bounds;
    const availW = Math.max(120, size.width - insets.left - insets.right - FRAME_PAD_PX * 2);
    const availH = Math.max(120, size.height - insets.top - insets.bottom - FRAME_PAD_PX * 2);
    const zoom = clampZoom(Math.min(availW / Math.max(1, b.maxX - b.minX), availH / Math.max(1, b.maxY - b.minY), req.maxZoom));
    const [cx, cy] = boundsCenter(b);
    return { x: cx + (insets.right - insets.left) / 2 / zoom, y: cy + (insets.top - insets.bottom) / 2 / zoom, zoom };
  };

  const applyGoal = (g: Goal) => {
    cam.position.x = g.x;
    cam.position.y = g.y;
    cam.zoom = g.zoom;
    cam.updateProjectionMatrix();
  };

  // New frame request: always honoured.
  useEffect(() => {
    const g = goalFor(frame);
    touchedSinceFrame.current = false;
    if (frame.instant) {
      goal.current = null;
      applyGoal(g);
    } else {
      goal.current = g;
    }
    invalidate();
  }, [frame.key]);

  // Overlays or window changed: re-centre the last target unless the student has since moved the map.
  useEffect(() => {
    if (touchedSinceFrame.current) return;
    goal.current = goalFor(frame);
  }, [insets.top, insets.right, insets.bottom, insets.left, size.width, size.height]);

  useImperativeHandle(ref, () => ({
    zoomBy: (factor: number) => {
      touchedSinceFrame.current = true;
      const base = goal.current ?? { x: cam.position.x, y: cam.position.y, zoom: cam.zoom };
      goal.current = { ...base, zoom: clampZoom(base.zoom * factor) };
    },
    wasDrag: () => dragged.current,
  }));

  useEffect(() => {
    const el = gl.domElement;
    let start: { px: number; py: number; x: number; y: number } | null = null;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragged.current = false;
      start = { px: e.clientX, py: e.clientY, x: cam.position.x, y: cam.position.y };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!dragged.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragged.current = true;
      touchedSinceFrame.current = true;
      goal.current = null;
      cam.position.x = start.x - dx / cam.zoom;
      cam.position.y = start.y + dy / cam.zoom;
      el.style.cursor = 'grabbing';
    };
    const onUp = (e: PointerEvent) => {
      start = null;
      el.style.cursor = '';
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touchedSinceFrame.current = true;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      const next = clampZoom(cam.zoom * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0016)));
      // Keep the world point under the cursor fixed while zooming.
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left - rect.width / 2;
      const sy = e.clientY - rect.top - rect.height / 2;
      cam.position.x += sx / cam.zoom - sx / next;
      cam.position.y -= sy / cam.zoom - sy / next;
      cam.zoom = next;
      cam.updateProjectionMatrix();
      goal.current = null;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [cam, gl, minZoom, maxZoom]);

  useFrame((_, dt) => {
    const g = goal.current;
    if (g) {
      const t = 1 - Math.exp(-dt * EASE_PER_SECOND);
      cam.position.x += (g.x - cam.position.x) * t;
      cam.position.y += (g.y - cam.position.y) * t;
      cam.zoom = Math.exp(Math.log(cam.zoom) + (Math.log(g.zoom) - Math.log(cam.zoom)) * t);
      cam.updateProjectionMatrix();
      if (Math.abs(g.x - cam.position.x) * cam.zoom < 0.5 && Math.abs(g.y - cam.position.y) * cam.zoom < 0.5 && Math.abs(g.zoom / cam.zoom - 1) < 0.002) {
        applyGoal(g);
        goal.current = null;
      }
    }
    if (cam.zoom !== lastZoom.current) {
      lastZoom.current = cam.zoom;
      onZoom(cam.zoom);
    }
  });

  return null;
}
