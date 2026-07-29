import { Box3, Vector3 } from 'three';

/**
 * Vertical capsule used as the player's collision volume.
 *
 * `start` is the lower sphere centre, `end` the upper one. The rig keeps the
 * capsule's top roughly at the headset height so leaning into a wall in
 * roomscale still registers.
 */
export class Capsule {
  readonly start = new Vector3();
  readonly end = new Vector3();
  radius: number;

  constructor(start = new Vector3(), end = new Vector3(0, 1, 0), radius = 0.35) {
    this.start.copy(start);
    this.end.copy(end);
    this.radius = radius;
  }

  clone(): Capsule {
    return new Capsule(this.start, this.end, this.radius);
  }

  copy(other: Capsule): this {
    this.start.copy(other.start);
    this.end.copy(other.end);
    this.radius = other.radius;
    return this;
  }

  /** Places the capsule from a head position and a body height. */
  setFromHead(head: Vector3, bodyHeight: number, radius: number): this {
    this.radius = radius;
    const usable = Math.max(0, bodyHeight - radius * 2);
    this.end.set(head.x, head.y - radius, head.z);
    this.start.set(head.x, head.y - radius - usable, head.z);
    return this;
  }

  translate(v: Vector3): this {
    this.start.add(v);
    this.end.add(v);
    return this;
  }

  getBounds(target: Box3): Box3 {
    target.makeEmpty();
    target.expandByPoint(this.start);
    target.expandByPoint(this.end);
    target.expandByScalar(this.radius);
    return target;
  }

  getCenter(target: Vector3): Vector3 {
    return target.copy(this.start).add(this.end).multiplyScalar(0.5);
  }
}
