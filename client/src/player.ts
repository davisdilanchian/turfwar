import { Box3, Line3, Matrix4, Mesh, Object3D, Raycaster, Vector3 } from 'three';
import type { ExtendedTriangle } from 'three-mesh-bvh';

// Capsule sized for a ~1.75 m player whose position is the eye point.
const RADIUS = 0.35;
const SEGMENT_TOP = -0.25;
const SEGMENT_BOTTOM = -1.25;
const GRAVITY = -20;
const WALK_SPEED = 4.5;
const SPRINT_SPEED = 8;
const JUMP_SPEED = 6.5;
const FLY_SPEED = 40;
// Only tile meshes this close to the player are collision candidates.
const COLLISION_RANGE = 30;

const _inverse = new Matrix4();
const _segment = new Line3();
const _box = new Box3();
const _triPoint = new Vector3();
const _capsulePoint = new Vector3();
const _delta = new Vector3();
const _center = new Vector3();
const _move = new Vector3();
const _down = new Vector3( 0, - 1, 0 );

export type Input = { forward: number, right: number, jump: boolean, sprint: boolean, up: number };

/** Returns visible meshes under `root` whose bounds come within `range` of `point`. */
export function nearbyMeshes( root: Object3D, point: Vector3, range: number ): Mesh[] {

	const result: Mesh[] = [];
	root.traverseVisible( obj => {

		const mesh = obj as Mesh;
		if ( ! mesh.isMesh ) return;

		const geometry = mesh.geometry;
		if ( ! geometry.boundingSphere ) geometry.computeBoundingSphere();
		const sphere = geometry.boundingSphere!;
		_center.copy( sphere.center ).applyMatrix4( mesh.matrixWorld );
		if ( _center.distanceTo( point ) - sphere.radius < range ) result.push( mesh );

	} );
	return result;

}

export function ensureBVH( mesh: Mesh ) {

	if ( ! mesh.geometry.boundsTree ) mesh.geometry.computeBoundsTree();

}

/** Meshes that are actually drawn (hidden coarser LOD tiles are skipped). */
export function visibleMeshes( root: Object3D ): Mesh[] {

	const result: Mesh[] = [];
	root.traverseVisible( obj => {

		if ( ( obj as Mesh ).isMesh ) result.push( obj as Mesh );

	} );
	return result;

}

/** First hit straight down from `from`, or null. */
export function groundBelow( root: Object3D, from: Vector3, raycaster: Raycaster ): Vector3 | null {

	raycaster.set( from, _down );
	raycaster.firstHitOnly = true;
	raycaster.far = 5000;
	const hits = raycaster.intersectObjects( visibleMeshes( root ), false );
	return hits.length ? hits[ 0 ].point.clone() : null;

}

export class Player {

	position = new Vector3();
	velocity = new Vector3();
	yaw = 0;
	pitch = 0;
	grounded = false;
	flying = false;

	update( dt: number, input: Input, world: Object3D ) {

		// Shift sprints on foot, and flies 10x faster.
		const speed = this.flying ? FLY_SPEED * ( input.sprint ? 10 : 1 ) : input.sprint ? SPRINT_SPEED : WALK_SPEED;
		_move.set( input.right, 0, - input.forward );
		if ( _move.lengthSq() > 1 ) _move.normalize();
		_move.multiplyScalar( speed ).applyAxisAngle( new Vector3( 0, 1, 0 ), this.yaw );

		if ( this.flying ) {

			this.velocity.set( _move.x, input.up * speed, _move.z );
			this.position.addScaledVector( this.velocity, dt );
			return;

		}

		this.velocity.x = _move.x;
		this.velocity.z = _move.z;
		if ( this.grounded ) {

			// Keep a little downward pull so the capsule stays in contact with the ground.
			this.velocity.y = input.jump ? JUMP_SPEED : GRAVITY * dt;

		} else {

			this.velocity.y += GRAVITY * dt;

		}

		this.position.addScaledVector( this.velocity, dt );
		this.resolveCollisions( dt, world );

	}

	// Push the capsule out of every nearby tile mesh, following the
	// three-mesh-bvh character controller approach.
	private resolveCollisions( dt: number, world: Object3D ) {

		const start = this.position.clone();
		this.grounded = false;

		for ( const mesh of nearbyMeshes( world, this.position, COLLISION_RANGE ) ) {

			ensureBVH( mesh );
			_inverse.copy( mesh.matrixWorld ).invert();
			_segment.start.set( 0, SEGMENT_TOP, 0 ).add( this.position ).applyMatrix4( _inverse );
			_segment.end.set( 0, SEGMENT_BOTTOM, 0 ).add( this.position ).applyMatrix4( _inverse );

			_box.makeEmpty().expandByPoint( _segment.start ).expandByPoint( _segment.end );
			_box.min.addScalar( - RADIUS );
			_box.max.addScalar( RADIUS );

			let moved = false;
			mesh.geometry.boundsTree!.shapecast( {
				intersectsBounds: box => box.intersectsBox( _box ),
				intersectsTriangle: ( tri: ExtendedTriangle ) => {

					const distance = tri.closestPointToSegment( _segment, _triPoint, _capsulePoint );
					if ( distance < RADIUS ) {

						const depth = RADIUS - distance;
						const direction = _capsulePoint.sub( _triPoint ).normalize();
						_segment.start.addScaledVector( direction, depth );
						_segment.end.addScaledVector( direction, depth );
						moved = true;

					}
					return false;

				},
			} );

			if ( moved ) {

				this.position.copy( _segment.start.applyMatrix4( mesh.matrixWorld ) ).y -= SEGMENT_TOP;

			}

		}

		_delta.subVectors( this.position, start );
		this.grounded = _delta.y > Math.abs( dt * this.velocity.y * 0.25 );
		if ( this.grounded ) {

			this.velocity.y = 0;

		} else if ( _delta.lengthSq() > 0 ) {

			_delta.normalize();
			this.velocity.addScaledVector( _delta, - _delta.dot( this.velocity ) );

		}

	}

}
