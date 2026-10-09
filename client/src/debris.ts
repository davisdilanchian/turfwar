import {
	BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshStandardMaterial, Quaternion, type Scene, Vector3,
} from 'three';
import type { Crater, Piece } from './craters';

// Debris made from the actual triangles a crater wiped out. Each burst is one mesh;
// every piece keeps its shape and texture-sampled colors, flies outward from the
// blast, tumbles, bounces on the ground and settles, then is cleared after a while.

const GRAVITY = - 18;
const LIFETIME = 30;
const MAX_PIECES = 300;

type Fragment = {
	center: Vector3,
	offsets: [ Vector3, Vector3, Vector3 ],
	velocity: Vector3,
	spinAxis: Vector3,
	spinSpeed: number,
	rotation: Quaternion,
	resting: boolean,
};

type Burst = { mesh: Mesh, fragments: Fragment[], floor: number, age: number };

const material = new MeshStandardMaterial( { vertexColors: true, flatShading: true, roughness: 0.95, side: DoubleSide } );
const _q = new Quaternion();
const _v = new Vector3();

export class Debris {

	private bursts: Burst[] = [];

	constructor( private scene: Scene ) {}

	spawn( pieces: Piece[], crater: Crater ) {

		const blast = new Vector3( crater.x, crater.y, crater.z );
		// Keep bursts bounded: big blasts subdivide into many small triangles.
		const step = Math.max( 1, Math.ceil( pieces.length / MAX_PIECES ) );
		const chosen = pieces.filter( ( _, i ) => i % step === 0 );

		const positions = new Float32Array( chosen.length * 9 );
		const colors = new Float32Array( chosen.length * 9 );
		const fragments: Fragment[] = chosen.map( ( piece, i ) => {

			const center = piece.a.clone().add( piece.b ).add( piece.c ).divideScalar( 3 );
			// Shrink each piece a little so the debris reads as separate chunks.
			const offsets = [ piece.a, piece.b, piece.c ].map( p => p.clone().sub( center ).multiplyScalar( 0.85 ) ) as Fragment[ 'offsets' ];
			piece.colors.forEach( ( c, k ) => c.clone().multiplyScalar( 0.8 ).toArray( colors, i * 9 + k * 3 ) );
			const out = center.clone().sub( blast );
			if ( out.lengthSq() < 1e-6 ) out.set( 0, 1, 0 );
			// Blasted hard outward, with a strong upward kick.
			const speed = Math.max( 4, crater.r * ( 6 + Math.random() * 8 ) );
			return {
				center,
				offsets,
				velocity: out.normalize().multiplyScalar( speed ).add( new Vector3( 0, Math.max( 2, crater.r * ( 3 + Math.random() * 4 ) ), 0 ) ),
				spinAxis: new Vector3( Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5 ).normalize(),
				spinSpeed: 4 + Math.random() * 10,
				rotation: new Quaternion(),
				resting: false,
			};

		} );

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'color', new BufferAttribute( colors, 3 ) );
		const mesh = new Mesh( geometry, material );
		mesh.frustumCulled = false;
		this.scene.add( mesh );
		const floor = crater.floor ?? crater.y - crater.r;
		const burst = { mesh, fragments, floor, age: 0 };
		this.bursts.push( burst );
		this.write( burst );

	}

	update( dt: number ) {

		for ( const burst of [ ...this.bursts ] ) {

			burst.age += dt;
			if ( burst.age > LIFETIME ) {

				this.scene.remove( burst.mesh );
				burst.mesh.geometry.dispose();
				this.bursts.splice( this.bursts.indexOf( burst ), 1 );
				continue;

			}
			let moving = false;
			for ( const f of burst.fragments ) {

				if ( f.resting ) continue;
				moving = true;
				f.velocity.y += GRAVITY * dt;
				f.center.addScaledVector( f.velocity, dt );
				f.rotation.premultiply( _q.setFromAxisAngle( f.spinAxis, f.spinSpeed * dt ) );
				if ( f.center.y < burst.floor + 0.05 ) {

					// Bounce, losing most of the energy, until it comes to rest.
					f.center.y = burst.floor + 0.05;
					f.velocity.y *= - 0.3;
					f.velocity.x *= 0.5;
					f.velocity.z *= 0.5;
					f.spinSpeed *= 0.5;
					if ( f.velocity.lengthSq() < 0.5 ) f.resting = true;

				}

			}
			if ( moving ) this.write( burst );

		}

	}

	private write( burst: Burst ) {

		const positions = burst.mesh.geometry.attributes.position as BufferAttribute;
		burst.fragments.forEach( ( f, i ) => {

			for ( let k = 0; k < 3; k ++ ) {

				_v.copy( f.offsets[ k ] ).applyQuaternion( f.rotation ).add( f.center );
				positions.setXYZ( i * 3 + k, _v.x, _v.y, _v.z );

			}

		} );
		positions.needsUpdate = true;
		burst.mesh.geometry.computeVertexNormals();

	}

}
