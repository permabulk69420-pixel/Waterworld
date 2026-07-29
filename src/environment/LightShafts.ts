import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';

const UP = new Vector3(0, 1, 0);
const WHITE_WATER = new Color(0xd8fff0);

/**
 * Cheap fake volumetric sunlight for standalone VR.
 *
 * Five shafts are batched into one geometry / one draw call. Each shaft is two crossed
 * translucent quads, so it still reads when viewed from different angles without doing an
 * expensive volumetric raymarch. The whole cluster follows the player horizontally, like a
 * sky effect, while slow shader motion prevents that camera-relative trick from being obvious.
 */
export class LightShafts {
  readonly root = new Group();
  private readonly material: ShaderMaterial;
  private readonly strengthUniform = { value: 0 };
  private readonly timeUniform = { value: 0 };
  private readonly colorUniform = { value: new Color(0xb8f4df) };

  constructor(
    private readonly seaLevel: number,
    sunDirection: Vector3,
  ) {
    this.root.name = 'underwater-sun-shafts';
    // Geometry runs downward along local -Y; align local +Y toward the sun.
    this.root.quaternion.setFromUnitVectors(UP, sunDirection.clone().normalize());

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      blending: AdditiveBlending,
      uniforms: {
        uTime: this.timeUniform,
        uStrength: this.strengthUniform,
        uColor: this.colorUniform,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vLocal;

        void main() {
          vUv = uv;
          vLocal = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uStrength;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying vec3 vLocal;

        void main() {
          float edge = sin(clamp(vUv.x, 0.0, 1.0) * 3.14159265);
          edge *= edge;

          // Fade just under the surface and well before the bottom of the geometry.
          float along = smoothstep(0.02, 0.16, vUv.y) * (1.0 - smoothstep(0.66, 1.0, vUv.y));

          // Two slow motions keep the shafts alive without texture lookups.
          float shimmer = 0.72 + 0.28 * sin(vLocal.y * 0.105 + vLocal.x * 0.14 + uTime * 0.83);
          shimmer *= 0.82 + 0.18 * sin(vLocal.z * 0.19 - vLocal.y * 0.051 - uTime * 0.57);

          float alpha = uStrength * edge * along * shimmer;
          if (alpha < 0.002) discard;
          gl_FragColor = vec4(uColor * alpha, alpha);
        }
      `,
    });

    const mesh = new Mesh(createShaftGeometry(), this.material);
    mesh.name = 'sun-shaft-batch';
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.root.add(mesh);
    this.root.visible = false;
  }

  update(
    elapsed: number,
    cameraPosition: Vector3,
    submergence: number,
    depth: number,
    shallowWater: Color,
  ): void {
    this.timeUniform.value = elapsed;

    // Strongest in the bright top 10-20 m, with a long fade for clear open water.
    const depthFade = 1 - smoothstep(18, 72, depth);
    const strength = submergence * depthFade * 0.19;
    this.strengthUniform.value = strength;
    this.root.visible = strength > 0.004;
    if (!this.root.visible) return;

    // Follow the player so a small amount of geometry can imply a huge sunlit volume.
    // The tiny drift keeps the illusion from feeling locked to the headset.
    this.root.position.set(
      cameraPosition.x + Math.sin(elapsed * 0.08) * 3.5,
      this.seaLevel + 0.35,
      cameraPosition.z + Math.cos(elapsed * 0.067) * 3.0,
    );
    this.colorUniform.value.copy(shallowWater).lerp(WHITE_WATER, 0.72);
  }

  dispose(): void {
    const mesh = this.root.children[0] as Mesh;
    mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** One non-indexed geometry containing five crossed tapered shafts. */
function createShaftGeometry(): BufferGeometry {
  const specs = [
    [-13, -7, 5.8, 64],
    [8, 4, 8.5, 70],
    [-2, 15, 4.6, 58],
    [16, -14, 6.4, 66],
    [-19, 13, 7.1, 72],
  ] as const;

  const positions: number[] = [];
  const uvs: number[] = [];

  for (const [ox, oz, width, height] of specs) {
    appendQuad(positions, uvs, ox, oz, width, height, false);
    appendQuad(positions, uvs, ox, oz, width * 0.86, height, true);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function appendQuad(
  positions: number[],
  uvs: number[],
  ox: number,
  oz: number,
  width: number,
  height: number,
  alongZ: boolean,
): void {
  const top = width * 0.34;
  const bottom = width;
  const y0 = -1.0;
  const y1 = -height;

  const point = (side: -1 | 1, bottomPoint: boolean): [number, number, number] => {
    const half = (bottomPoint ? bottom : top) * 0.5 * side;
    return alongZ
      ? [ox, bottomPoint ? y1 : y0, oz + half]
      : [ox + half, bottomPoint ? y1 : y0, oz];
  };

  const a = point(-1, false);
  const b = point(1, false);
  const c = point(1, true);
  const d = point(-1, true);

  pushTri(positions, uvs, a, b, c, [0, 0], [1, 0], [1, 1]);
  pushTri(positions, uvs, a, c, d, [0, 0], [1, 1], [0, 1]);
}

function pushTri(
  positions: number[],
  uvs: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  ua: [number, number],
  ub: [number, number],
  uc: [number, number],
): void {
  positions.push(...a, ...b, ...c);
  uvs.push(...ua, ...ub, ...uc);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
