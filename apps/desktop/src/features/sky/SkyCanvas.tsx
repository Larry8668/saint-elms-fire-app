import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type { EdgeOrigin, GraphNode, GraphResponse } from '@sef/shared';
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { LESSON_HEX, ORIGIN_STYLE, STATUS_STYLE } from '@/lib/brain-style';
import type { LabelItem } from './labels';
import { hash01, type SkyLayout } from './layout';
import { MapCamera, type FrameRequest, type Insets, type MapCameraApi } from './MapCamera';
import { LabelProjector, type LabelRegistry } from './SkyLabels';

export interface SkyCanvasProps {
  graph: GraphResponse;
  layout: SkyLayout;
  selectedId: string | null;
  /** Ids kept bright (selection neighbourhood or focused course); everything else dims. */
  focus: Set<string> | null;
  showUnseen: boolean;
  frame: FrameRequest;
  insets: Insets;
  minZoom: number;
  labels: LabelItem[];
  labelRegistry: LabelRegistry;
  cameraRef: RefObject<MapCameraApi | null>;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onZoom: (zoom: number) => void;
}

const MAX_ZOOM = 3.2;
const PICK_RADIUS_PX = 10;
const SUBJECT_HUES = ['#4f6bd8', '#8a5cf0', '#2fa3b8', '#c0618f', '#5a8f4e'];

const STAR_VERTEX = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute float phase;
  attribute float pulse;
  attribute vec3 starColor;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uZoom;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float twinkle = 0.9 + 0.1 * sin(uTime * 1.3 + phase * 6.2831);
    float throb = 1.0 + pulse * 0.35 * sin(uTime * 3.0 + phase * 6.2831);
    float scale = clamp(pow(uZoom, 0.6) * 2.1, 1.0, 5.5);
    gl_PointSize = clamp(size * scale * twinkle * throb, 2.0, 64.0) * uPixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vColor = starColor;
    vAlpha = alpha;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float core = smoothstep(0.14, 0.0, d);
    float halo = pow(smoothstep(0.5, 0.0, d), 2.2);
    float spikes = (max(0.0, 1.0 - abs(uv.y) * 30.0) * smoothstep(0.5, 0.0, abs(uv.x))
                  + max(0.0, 1.0 - abs(uv.x) * 30.0) * smoothstep(0.5, 0.0, abs(uv.y))) * 0.22;
    float intensity = core + halo * 0.65 + spikes;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.7) * intensity, intensity * vAlpha);
  }
`;

const NEBULA_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    float d = length((vUv - 0.5) * 2.0);
    float a = pow(smoothstep(1.0, 0.0, d), 1.8) * uAlpha;
    gl_FragColor = vec4(uColor * a, a);
  }
`;
const NEBULA_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

function starAppearance(node: GraphNode, showUnseen: boolean) {
  if (node.kind === 'lesson') return { hex: LESSON_HEX, size: 6.5, alpha: 0.9, pulse: 0 };
  switch (node.status) {
    case 'unseen':
      return { hex: STATUS_STYLE.unseen.hex, size: 2.6, alpha: showUnseen ? 0.55 : 0.08, pulse: 0 };
    case 'met':
      return { hex: STATUS_STYLE.met.hex, size: 5.4, alpha: 1, pulse: 0 };
    case 'shaky':
      return { hex: STATUS_STYLE.shaky.hex, size: 6, alpha: 1, pulse: 1 };
    case 'solid':
      return { hex: STATUS_STYLE.solid.hex, size: 7, alpha: 1, pulse: 0 };
  }
}

function StarField({ graph, layout, focus, showUnseen, onHover, onPick }: Pick<SkyCanvasProps, 'graph' | 'layout' | 'focus' | 'showUnseen' | 'onHover'> & { onPick: (index: number) => void }) {
  const { gl, raycaster } = useThree();
  const material = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPixelRatio: { value: Math.min(gl.getPixelRatio(), 2) }, uZoom: { value: 1 } }), [gl]);

  const geometry = useMemo(() => {
    const n = graph.nodes.length;
    const attrs = { position: new Float32Array(n * 3), starColor: new Float32Array(n * 3), size: new Float32Array(n), alpha: new Float32Array(n), phase: new Float32Array(n), pulse: new Float32Array(n) };
    const c = new THREE.Color();
    graph.nodes.forEach((node, i) => {
      const [x, y] = layout.positions.get(node.id) ?? [0, 0];
      attrs.position.set([x, y, 0], i * 3);
      const look = starAppearance(node, showUnseen);
      attrs.starColor.set(c.set(look.hex).toArray(), i * 3);
      const inFocus = focus?.has(node.id);
      attrs.size[i] = look.size * (inFocus ? 1.2 : 1);
      attrs.alpha[i] = focus && !inFocus ? look.alpha * 0.18 : look.alpha;
      attrs.phase[i] = hash01(node.id);
      attrs.pulse[i] = look.pulse;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(attrs.position, 3));
    g.setAttribute('starColor', new THREE.BufferAttribute(attrs.starColor, 3));
    for (const key of ['size', 'alpha', 'phase', 'pulse'] as const) g.setAttribute(key, new THREE.BufferAttribute(attrs[key], 1));
    return g;
  }, [graph, layout, focus, showUnseen]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(({ clock, camera }) => {
    const zoom = (camera as THREE.OrthographicCamera).zoom;
    raycaster.params.Points = { threshold: PICK_RADIUS_PX / zoom };
    if (!material.current) return;
    material.current.uniforms.uTime.value = clock.elapsedTime;
    material.current.uniforms.uZoom.value = zoom;
  });

  /** Ortho rays hit many points at equal depth; take the one nearest the cursor. */
  const nearest = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    let best: { index: number; d: number } | null = null;
    for (const hit of e.intersections) {
      if (hit.object !== e.object || hit.index == null) continue;
      const d = hit.distanceToRay ?? Infinity;
      if (!best || d < best.d) best = { index: hit.index, d };
    }
    return best?.index ?? null;
  };

  return (
    <points
      geometry={geometry}
      onPointerMove={(e) => {
        e.stopPropagation();
        const i = nearest(e);
        onHover(i == null ? null : graph.nodes[i]!.id);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        if (e.delta > 4) return;
        const i = nearest(e);
        if (i != null) onPick(i);
      }}
    >
      <shaderMaterial ref={material} vertexShader={STAR_VERTEX} fragmentShader={STAR_FRAGMENT} uniforms={uniforms} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

function Links({ graph, layout, focus, showUnseen }: Pick<SkyCanvasProps, 'graph' | 'layout' | 'focus' | 'showUnseen'>) {
  const groups = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const buckets = new Map<string, { color: string; opacity: number; points: number[] }>();
    const push = (key: string, color: string, opacity: number, a: [number, number], b: [number, number]) => {
      const bucket = buckets.get(key) ?? { color, opacity, points: [] };
      bucket.points.push(a[0], a[1], -0.5, b[0], b[1], -0.5);
      buckets.set(key, bucket);
    };

    // The constellation figure: lessons joined in teaching order.
    for (const c of layout.constellations) {
      const dim = focus && !c.nodeIds.some((id) => focus.has(id));
      for (let i = 1; i < c.path.length; i += 1) push(`path:${dim}`, LESSON_HEX, dim ? 0.06 : 0.3, c.path[i - 1]!, c.path[i]!);
    }

    for (const edge of graph.edges) {
      const a = layout.positions.get(edge.source);
      const b = layout.positions.get(edge.target);
      if (!a || !b) continue;
      const hidden = !showUnseen && [edge.source, edge.target].some((id) => byId.get(id)?.status === 'unseen' && byId.get(id)?.kind === 'concept');
      if (hidden && edge.origin === 'course') continue;
      const inFocus = Boolean(focus?.has(edge.source) && focus.has(edge.target));
      // Course links between courses span the whole chart; only draw them when they are the point.
      const crossCourse = byId.get(edge.source)?.courseId !== byId.get(edge.target)?.courseId;
      if (crossCourse && edge.origin === 'course' && !inFocus) continue;
      const mode = focus ? (inFocus ? 'hi' : 'dim') : 'base';
      const style = ORIGIN_STYLE[edge.origin as EdgeOrigin];
      const opacity = mode === 'hi' ? Math.min(0.9, style.opacity * (edge.origin === 'course' ? 4 : 1.2)) : mode === 'dim' ? style.opacity * 0.3 : style.opacity;
      push(`${edge.origin}:${mode}`, style.hex, opacity, a, b);
    }

    return [...buckets.entries()].map(([key, b]) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.points, 3));
      return { key, geometry, color: b.color, opacity: b.opacity };
    });
  }, [graph, layout, focus, showUnseen]);

  useEffect(() => () => groups.forEach((g) => g.geometry.dispose()), [groups]);

  return (
    <>
      {groups.map((g) => (
        <lineSegments key={g.key} geometry={g.geometry}>
          <lineBasicMaterial color={g.color} transparent opacity={g.opacity} depthWrite={false} blending={THREE.AdditiveBlending} />
        </lineSegments>
      ))}
    </>
  );
}

/** A soft glow behind each course so constellations read as groups when zoomed out. */
function Nebulae({ layout, focus }: Pick<SkyCanvasProps, 'layout' | 'focus'>) {
  return (
    <>
      {layout.constellations.map((c) => {
        const w = (c.bounds.maxX - c.bounds.minX) * 1.15;
        const h = (c.bounds.maxY - c.bounds.minY) * 1.25;
        const dim = focus && !c.nodeIds.some((id) => focus.has(id));
        const hue = SUBJECT_HUES[Math.floor(hash01(c.subjectId) * SUBJECT_HUES.length)]!;
        return (
          <mesh key={c.courseId} position={[(c.bounds.minX + c.bounds.maxX) / 2, (c.bounds.minY + c.bounds.maxY) / 2, -2]}>
            <planeGeometry args={[w, h]} />
            <shaderMaterial
              vertexShader={NEBULA_VERTEX}
              fragmentShader={NEBULA_FRAGMENT}
              uniforms={{ uColor: { value: new THREE.Color(hue) }, uAlpha: { value: dim ? 0.04 : 0.16 } }}
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        );
      })}
    </>
  );
}

/** Background dust that drifts slower than the chart, for depth. */
function Dust({ layout }: Pick<SkyCanvasProps, 'layout'>) {
  const group = useRef<THREE.Group>(null);
  const geometry = useMemo(() => {
    const { minX, maxX, minY, maxY } = layout.bounds;
    const w = Math.max(2000, maxX - minX) * 2.4;
    const h = Math.max(1600, maxY - minY) * 2.4;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const count = 2600;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      pos.set([cx + (hash01(`x${i}`) - 0.5) * w, cy + (hash01(`y${i}`) - 0.5) * h, -5], i * 3);
      const b = 0.25 + hash01(`b${i}`) * 0.5;
      col.set([b * 0.85, b * 0.9, b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }, [layout]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({ camera }) => group.current?.position.set(camera.position.x * 0.55, camera.position.y * 0.55, 0));

  return (
    <group ref={group}>
      <points geometry={geometry} raycast={() => null}>
        <pointsMaterial size={1.6} sizeAttenuation={false} vertexColors transparent opacity={0.8} depthWrite={false} />
      </points>
    </group>
  );
}

export function SkyCanvas(props: SkyCanvasProps) {
  const { graph, layout, focus, showUnseen, frame, insets, minZoom, labels, labelRegistry, cameraRef, onSelect, onHover, onZoom } = props;

  return (
    <Canvas
      orthographic
      camera={{ position: [0, 0, 100], zoom: 0.5, near: 0.1, far: 1000 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      onPointerMissed={() => {
        if (!cameraRef.current?.wasDrag()) onSelect(null);
      }}
    >
      <Dust layout={layout} />
      <Nebulae layout={layout} focus={focus} />
      <Links graph={graph} layout={layout} focus={focus} showUnseen={showUnseen} />
      <StarField graph={graph} layout={layout} focus={focus} showUnseen={showUnseen} onHover={onHover} onPick={(i) => onSelect(graph.nodes[i]?.id ?? null)} />
      <MapCamera
        ref={cameraRef}
        frame={frame}
        insets={insets}
        minZoom={minZoom}
        maxZoom={MAX_ZOOM}
        onZoom={onZoom}
      />
      <LabelProjector items={labels} registry={labelRegistry} />
    </Canvas>
  );
}
