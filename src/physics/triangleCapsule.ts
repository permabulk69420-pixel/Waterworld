import { Line3, Plane, Triangle, Vector3 } from 'three';
import type { Capsule } from './Capsule.ts';

export interface Contact {
  normal: Vector3;
  depth: number;
}

const _plane = new Plane();
const _triangle = new Triangle();
const _point = new Vector3();
const _line1 = new Line3();
const _line2 = new Line3();
const _p1 = new Vector3();
const _p2 = new Vector3();
const _r = new Vector3();
const _d1 = new Vector3();
const _d2 = new Vector3();

/**
 * Closest points between two segments. Standard Ericson (Real-Time Collision
 * Detection) formulation, including the degenerate cases.
 */
export function closestPointsSegmentSegment(
  l1: Line3,
  l2: Line3,
  out1: Vector3,
  out2: Vector3,
): void {
  _d1.subVectors(l1.end, l1.start);
  _d2.subVectors(l2.end, l2.start);
  _r.subVectors(l1.start, l2.start);

  const a = _d1.dot(_d1);
  const e = _d2.dot(_d2);
  const f = _d2.dot(_r);

  let s: number;
  let t: number;

  const EPS = 1e-9;
  if (a <= EPS && e <= EPS) {
    out1.copy(l1.start);
    out2.copy(l2.start);
    return;
  }
  if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = _d1.dot(_r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  out1.copy(_d1).multiplyScalar(s).add(l1.start);
  out2.copy(_d2).multiplyScalar(t).add(l2.start);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Capsule vs triangle. Writes the push-out normal and penetration depth into
 * `contact` and returns true on overlap.
 *
 * Faces are treated as one-sided (front side = the triangle's winding normal,
 * which for our terrain always points into the water) so the solver never
 * tries to eject the player *through* the seabed when it is deep inside a
 * cluster of back-facing triangles.
 */
export function capsuleTriangleContact(
  capsule: Capsule,
  a: Vector3,
  b: Vector3,
  c: Vector3,
  contact: Contact,
): boolean {
  _triangle.set(a, b, c);
  _triangle.getPlane(_plane);

  const dStart = _plane.distanceToPoint(capsule.start) - capsule.radius;
  const dEnd = _plane.distanceToPoint(capsule.end) - capsule.radius;

  // Entirely in front of the face, or entirely behind it by more than the
  // capsule diameter (i.e. a face on the far side of a thin wall).
  if (dStart > 0 && dEnd > 0) return false;
  if (dStart < -capsule.radius && dEnd < -capsule.radius) return false;

  // Face region: the segment point nearest the plane projects inside the triangle.
  const denom = Math.abs(dStart) + Math.abs(dEnd);
  const t = denom > 1e-9 ? Math.abs(dStart / denom) : 0;
  _point.copy(capsule.start).lerp(capsule.end, t);
  if (_triangle.containsPoint(_point)) {
    contact.normal.copy(_plane.normal);
    contact.depth = Math.abs(Math.min(dStart, dEnd));
    return true;
  }

  // Edge region: closest approach between the capsule segment and each edge.
  const r2 = capsule.radius * capsule.radius;
  _line1.set(capsule.start, capsule.end);
  for (let e = 0; e < 3; e++) {
    const e0 = e === 0 ? a : e === 1 ? b : c;
    const e1 = e === 0 ? b : e === 1 ? c : a;
    _line2.set(e0, e1);
    closestPointsSegmentSegment(_line1, _line2, _p1, _p2);
    const distSq = _p1.distanceToSquared(_p2);
    if (distSq < r2) {
      const dist = Math.sqrt(distSq);
      if (dist < 1e-6) {
        contact.normal.copy(_plane.normal);
      } else {
        contact.normal.copy(_p1).sub(_p2).divideScalar(dist);
      }
      contact.depth = capsule.radius - dist;
      return true;
    }
  }

  return false;
}
