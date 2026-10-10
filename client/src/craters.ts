import {
	Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, Sphere, Vector3,
	type Object3D,
} from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { CHUNK, H, Region, originalGeometry, pixels, sample, worldBox, type CellBox } from './voxels';

// Craters change the world as voxels (see voxels.ts). Each blast marks the chunks
// of the global grid it reaches; touching chunks merge into box regions. Inside a
// region the Google tiles are cut away exactly at the box faces and replaced by
// a surface rebuilt from the voxelized original with every blast carved out, so
// tunnels connect and blasts break through walls. Outside regions the tiles are
// untouched.
//
// Only crater records are saved; the Google tiles are cut in memory and the
// regions rebuilt whenever the tiles stream in again.
export type Crater = {
	x: number, y: number, z: number, r: number,
	/** Direction into whatever was hit. */
	dx: number, dy: number, dz: number,
	/** Whether the blast hit ground (as opposed to a wall, roof or tree). */
	ground: boolean,
	/** Street level around the blast, where debris lands. */
	floor: number | null,
	t: number,
};

/** A world-space triangle that was blown away, with a color per corner. */
export type Piece = { a: Vector3, b: Vector3, c: Vector3, colors: [ Color, Color, Color ] };

const STORAGE_KEY = 'turfwar.craters.v9';
const MAX_PIECES = 300;
// Don't rebuild a region from newly streamed tiles more often than this (seconds).
const RESTREAM_DELAY = 1;
// Minimum time between rebuilds of the same region (seconds).
const REBUILD_INTERVAL = 0.15;

type Entry = { box: CellBox, region: Region | null, mesh: Mesh | null, built: number, builtAt: number, stale: boolean, staleSince: number };

const _box = new Box3();
const _inverse = new Matrix4();
const _v = new Vector3();
const _c = new Vector3();

export class Craters {

	list: Crater[] = [];
	/** Rebuilt region surfaces; add this to the world so they are drawn, collided with and shot at. */
	fills = new Group();
	/** Called with the triangles a new crater blew away. */
	onDebris: ( pieces: Piece[], crater: Crater ) => void = () => {};

	private meshes = new Set<Mesh>();
	/** Tile meshes whose cut needs redoing (new tile, or the regions changed). */
	private pending = new Set<Mesh>();
	private fresh = new Set<Crater>();
	private boxes: CellBox[] = [];
	private entries = new Map<string, Entry>();
	// Both sides, so the odd flipped triangle at a crater rim never shows as a gap.
	private material = new MeshBasicMaterial( { vertexColors: true, side: DoubleSide } );
	private time = 0;

	constructor() {

		try {

			this.list = JSON.parse( localStorage.getItem( STORAGE_KEY ) || '[]' );

		} catch {

			this.list = [];

		}
		this.boxes = mergeBoxes( this.list );

	}

	add( center: Vector3, r: number, direction: Vector3, ground: boolean, floor: number | null ) {

		const d = direction.clone().normalize();
		const crater: Crater = { x: center.x, y: center.y, z: center.z, r, dx: d.x, dy: d.y, dz: d.z, ground, floor, t: Date.now() };
		this.list.push( crater );
		this.fresh.add( crater );
		this.boxes = mergeBoxes( this.list );
		this.meshes.forEach( m => this.pending.add( m ) );
		return crater;

	}

	/** Forgets all craters and restores the tiles. */
	clear() {

		this.list = [];
		this.boxes = [];
		for ( const entry of this.entries.values() ) this.dropMesh( entry );
		this.entries.clear();
		this.meshes.forEach( m => this.pending.add( m ) );
		this.save();

	}

	/** Registers a freshly loaded tile mesh. */
	track( mesh: Mesh ) {

		this.meshes.add( mesh );
		this.pending.add( mesh );
		// Better tiles streamed in over a region: rebuild it from them soon.
		const bounds = tileBounds( mesh );
		for ( const entry of this.entries.values() ) {

			if ( bounds.intersectsBox( worldBox( entry.box ) ) && ! entry.stale ) {

				entry.stale = true;
				entry.staleSince = this.time;

			}

		}

	}

	untrack( mesh: Mesh ) {

		this.meshes.delete( mesh );
		this.pending.delete( mesh );
		const original = mesh.userData.twOriginal as BufferGeometry | undefined;
		if ( original && original !== mesh.geometry ) {

			original.disposeBoundsTree();
			original.dispose();

		}

	}

	/** Applies craters to the scene. Call once per frame. */
	update( root: Object3D, dt = 0 ) {

		this.time += dt;

		// Debris comes from the original surface, before it is cut away.
		for ( const crater of this.fresh ) {

			const pieces = this.wipedPieces( crater, root );
			if ( pieces.length ) this.onDebris( pieces, crater );

		}

		// Cut tiles at region boxes. Tiles are only attached while visible, so
		// hidden ones are cut when they appear.
		const worldBoxes = this.boxes.map( b => worldBox( b ) );
		for ( const mesh of this.pending ) {

			if ( ! isUnder( mesh, root ) ) continue;
			mesh.updateWorldMatrix( true, false );
			cutTile( mesh, worldBoxes );
			this.pending.delete( mesh );

		}

		// Keep one rebuilt surface per region.
		const keys = new Set<string>();
		let classified = false;
		for ( const box of this.boxes ) {

			const key = `${ box.x0 },${ box.y0 },${ box.z0 },${ box.x1 },${ box.y1 },${ box.z1 }`;
			keys.add( key );
			let entry = this.entries.get( key );
			if ( ! entry ) {

				entry = { box, region: null, mesh: null, built: - 1, builtAt: - Infinity, stale: false, staleSince: 0 };
				this.entries.set( key, entry );

			}
			const restream = entry.stale && this.time - entry.staleSince > RESTREAM_DELAY;
			// Voxelizing is the expensive part: at most one region per frame.
			if ( ( ! entry.region || restream ) && ! classified ) {

				const sources = this.sourcesFor( box, root );
				if ( sources.length ) {

					entry.region = new Region( box, sources, this.floorFor( box ) );
					entry.stale = false;
					entry.built = - 1;
					classified = true;

				}

			}
			const inside = this.list.filter( c => worldBox( box ).distanceToPoint( _v.set( c.x, c.y, c.z ) ) < c.r ).length;
			// Rapid fire into one region is batched into a few rebuilds a second.
			if ( entry.region && entry.built !== inside && ( entry.built < 0 || this.time - entry.builtAt > REBUILD_INTERVAL ) ) {

				this.dropMesh( entry );
				const geometry = entry.region.build( this.list );
				if ( geometry ) {

					geometry.computeBoundsTree();
					entry.mesh = new Mesh( geometry, this.material );
					entry.mesh.updateMatrixWorld();
					this.fills.add( entry.mesh );

				}
				entry.built = inside;
				entry.builtAt = this.time;

			}

		}
		for ( const [ key, entry ] of this.entries ) {

			if ( keys.has( key ) ) continue;
			this.dropMesh( entry );
			this.entries.delete( key );

		}

		if ( this.fresh.size ) {

			this.fresh.clear();
			this.save();

		}

	}

	private dropMesh( entry: Entry ) {

		if ( ! entry.mesh ) return;
		this.fills.remove( entry.mesh );
		entry.mesh.geometry.disposeBoundsTree();
		entry.mesh.geometry.dispose();
		entry.mesh = null;

	}

	/** Visible tile meshes overlapping a region box. */
	private sourcesFor( box: CellBox, root: Object3D ) {

		const region = worldBox( box );
		const result: Mesh[] = [];
		root.traverseVisible( o => {

			const mesh = o as Mesh;
			if ( ! mesh.isMesh || isUnder( mesh, this.fills ) ) return;
			if ( tileBounds( mesh ).intersectsBox( region ) ) result.push( mesh );

		} );
		return result;

	}

	private floorFor( box: CellBox ) {

		const region = worldBox( box );
		const inside = this.list.filter( c => region.distanceToPoint( _v.set( c.x, c.y, c.z ) ) < c.r );
		const floors = inside.map( c => c.floor ).filter( ( f ): f is number => f !== null );
		return floors.length ? Math.min( ...floors ) : Math.min( ...inside.map( c => c.y - c.r ) );

	}

	/** Original tile triangles inside a crater, in world space with sampled colors. */
	private wipedPieces( crater: Crater, root: Object3D ) {

		const pieces: Piece[] = [];
		const earlier = this.list.filter( c => c !== crater && c.t <= crater.t );
		const sphere = new Sphere( new Vector3( crater.x, crater.y, crater.z ), crater.r );
		root.traverseVisible( o => {

			const mesh = o as Mesh;
			if ( ! mesh.isMesh || isUnder( mesh, this.fills ) || pieces.length >= MAX_PIECES ) return;
			if ( ! tileBounds( mesh ).intersectsSphere( sphere ) ) return;
			const geometry = originalGeometry( mesh );
			if ( ! geometry.boundsTree ) geometry.computeBoundsTree();
			_inverse.copy( mesh.matrixWorld ).invert();
			const local = sphere.clone().applyMatrix4( _inverse );
			const uv = geometry.attributes.uv;
			const image = pixels( mesh );
			( geometry.boundsTree as MeshBVH ).shapecast( {
				intersectsBounds: b => b.intersectsSphere( local ),
				intersectsTriangle: ( t, face ) => {

					if ( pieces.length >= MAX_PIECES ) return true;
					_v.copy( t.a ).add( t.b ).add( t.c ).divideScalar( 3 );
					if ( ! local.containsPoint( _v ) ) return false;
					// Skip ground an earlier blast already removed.
					const at = _v.clone().applyMatrix4( mesh.matrixWorld );
					if ( earlier.some( c => at.distanceToSquared( _c.set( c.x, c.y, c.z ) ) < c.r * c.r ) ) return false;
					const index = geometry.index;
					const corner = ( k: number ) => {

						const i = index ? index.getX( face * 3 + k ) : face * 3 + k;
						return uv ? sample( image, uv.getX( i ), uv.getY( i ), new Color() ) : new Color( 0x8a7a66 );

					};
					pieces.push( {
						a: t.a.clone().applyMatrix4( mesh.matrixWorld ),
						b: t.b.clone().applyMatrix4( mesh.matrixWorld ),
						c: t.c.clone().applyMatrix4( mesh.matrixWorld ),
						colors: [ corner( 0 ), corner( 1 ), corner( 2 ) ],
					} );
					return false;

				},
			} );

		} );
		return pieces;

	}

	private save() {

		try {

			localStorage.setItem( STORAGE_KEY, JSON.stringify( this.list ) );

		} catch {

			// Storage can be unavailable (private mode); craters then last only for this session.

		}

	}

}

function isUnder( object: Object3D, root: Object3D ) {

	for ( let o: Object3D | null = object; o; o = o.parent ) if ( o === root ) return true;
	return false;

}

/** World-space bounds of a tile's original geometry. */
function tileBounds( mesh: Mesh ) {

	const geometry = originalGeometry( mesh );
	if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
	return _box.copy( geometry.boundingBox! ).applyMatrix4( mesh.matrixWorld );

}

/** Region boxes: the chunks each crater reaches, merged wherever they touch. */
function mergeBoxes( craters: Crater[] ): CellBox[] {

	const size = CHUNK * H;
	const boxes: CellBox[] = craters.map( c => {

		const reach = c.r + H;
		return {
			x0: Math.floor( ( c.x - reach ) / size ) * CHUNK, x1: ( Math.floor( ( c.x + reach ) / size ) + 1 ) * CHUNK,
			y0: Math.floor( ( c.y - reach ) / size ) * CHUNK, y1: ( Math.floor( ( c.y + reach ) / size ) + 1 ) * CHUNK,
			z0: Math.floor( ( c.z - reach ) / size ) * CHUNK, z1: ( Math.floor( ( c.z + reach ) / size ) + 1 ) * CHUNK,
		};

	} );
	let merged = true;
	while ( merged ) {

		merged = false;
		outer: for ( let i = 0; i < boxes.length; i ++ ) {

			for ( let j = i + 1; j < boxes.length; j ++ ) {

				const a = boxes[ i ], b = boxes[ j ];
				// Touching counts, so neighbouring regions never share a seam.
				if ( a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1 && a.z0 <= b.z1 && b.z0 <= a.z1 ) {

					boxes[ i ] = {
						x0: Math.min( a.x0, b.x0 ), y0: Math.min( a.y0, b.y0 ), z0: Math.min( a.z0, b.z0 ),
						x1: Math.max( a.x1, b.x1 ), y1: Math.max( a.y1, b.y1 ), z1: Math.max( a.z1, b.z1 ),
					};
					boxes.splice( j, 1 );
					merged = true;
					break outer;

				}

			}

		}

	}
	return boxes;

}

/**
 * Cuts the parts of a tile inside any of `boxes` (world space) out of its original
 * geometry, exactly at the box faces. Restores the original if no box touches it.
 */
function cutTile( mesh: Mesh, boxes: Box3[] ) {

	const original = originalGeometry( mesh );
	const bounds = tileBounds( mesh ).clone();
	const touching = boxes.filter( b => b.intersectsBox( bounds ) );
	if ( ! touching.length ) {

		if ( mesh.geometry !== original ) {

			mesh.geometry.disposeBoundsTree();
			mesh.geometry.dispose();
			mesh.geometry = original;

		}
		return;

	}
	if ( ! mesh.userData.twOriginal ) mesh.userData.twOriginal = original;
	if ( ! original.boundsTree ) original.computeBoundsTree();

	// Copy attributes into plain arrays (handles quantized and interleaved data).
	const names = Object.keys( original.attributes );
	const count = original.attributes.position.count;
	const data: Record<string, number[]> = {};
	const sizes: Record<string, number> = {};
	for ( const name of names ) {

		const attr = original.attributes[ name ];
		sizes[ name ] = attr.itemSize;
		const out = new Array<number>( count * attr.itemSize );
		for ( let i = 0; i < count; i ++ ) for ( let k = 0; k < attr.itemSize; k ++ ) out[ i * attr.itemSize + k ] = attr.getComponent( i, k );
		data[ name ] = out;

	}
	const world = new Array<number>( count * 3 );
	for ( let i = 0; i < count; i ++ ) _v.fromArray( data.position, i * 3 ).applyMatrix4( mesh.matrixWorld ).toArray( world, i * 3 );
	const index = original.index ? Array.from( original.index.array ) : Array.from( { length: count }, ( _, i ) => i );

	// Polygons are lists of barycentric weights over their source triangle.
	type Poly = number[][];
	const out: number[] = [];
	let vertexCount = count;
	const triBox = new Box3();
	const a = new Vector3(), b = new Vector3(), c = new Vector3();
	for ( let t = 0; t < index.length; t += 3 ) {

		const ia = index[ t ], ib = index[ t + 1 ], ic = index[ t + 2 ];
		a.fromArray( world, ia * 3 ); b.fromArray( world, ib * 3 ); c.fromArray( world, ic * 3 );
		triBox.setFromPoints( [ a, b, c ] );
		const hits = touching.filter( box => box.intersectsBox( triBox ) );
		if ( ! hits.length ) {

			out.push( ia, ib, ic );
			continue;

		}

		const coord = ( w: number[], axis: number ) => w[ 0 ] * a.getComponent( axis ) + w[ 1 ] * b.getComponent( axis ) + w[ 2 ] * c.getComponent( axis );
		let pieces: Poly[] = [ [ [ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ] ] ];
		for ( const box of hits ) {

			const next: Poly[] = [];
			for ( const poly of pieces ) {

				let rest: Poly = poly;
				// Peel off the parts outside each face; what's left inside the box goes.
				for ( let axis = 0; axis < 3; axis ++ ) {

					for ( const [ value, sign ] of [ [ box.min.getComponent( axis ), 1 ], [ box.max.getComponent( axis ), - 1 ] ] ) {

						if ( rest.length < 3 ) break;
						const [ outside, inside ] = splitPoly( rest, w => ( coord( w, axis ) - value ) * sign );
						if ( outside.length >= 3 ) next.push( outside );
						rest = inside;

					}

				}

			}
			pieces = next;

		}

		for ( const poly of pieces ) {

			const ids = poly.map( w => {

				for ( const name of names ) {

					const s = sizes[ name ], arr = data[ name ];
					for ( let k = 0; k < s; k ++ ) arr.push( w[ 0 ] * arr[ ia * s + k ] + w[ 1 ] * arr[ ib * s + k ] + w[ 2 ] * arr[ ic * s + k ] );

				}
				return vertexCount ++;

			} );
			for ( let k = 1; k < ids.length - 1; k ++ ) out.push( ids[ 0 ], ids[ k ], ids[ k + 1 ] );

		}

	}

	const next = new BufferGeometry();
	for ( const name of names ) next.setAttribute( name, new BufferAttribute( new Float32Array( data[ name ] ), sizes[ name ] ) );
	next.setIndex( out );
	next.computeBoundingSphere();
	next.computeBoundingBox();
	next.computeBoundsTree();
	if ( mesh.geometry !== original ) {

		mesh.geometry.disposeBoundsTree();
		mesh.geometry.dispose();

	}
	mesh.geometry = next;

}

/** Splits a polygon by a plane: [part where side(w) < 0, part where side(w) >= 0]. */
function splitPoly( poly: number[][], side: ( w: number[] ) => number ): [ number[][], number[][] ] {

	const outside: number[][] = [];
	const inside: number[][] = [];
	for ( let n = 0; n < poly.length; n ++ ) {

		const p = poly[ n ], q = poly[ ( n + 1 ) % poly.length ];
		const dp = side( p ), dq = side( q );
		( dp < 0 ? outside : inside ).push( p );
		if ( ( dp < 0 ) !== ( dq < 0 ) ) {

			const t = dp / ( dp - dq );
			const x = [ p[ 0 ] + ( q[ 0 ] - p[ 0 ] ) * t, p[ 1 ] + ( q[ 1 ] - p[ 1 ] ) * t, p[ 2 ] + ( q[ 2 ] - p[ 2 ] ) * t ];
			outside.push( x );
			inside.push( x );

		}

	}
	return [ outside, inside ];

}
