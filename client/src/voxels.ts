import {
	Box3, BufferAttribute, BufferGeometry, Color, Matrix4, type Mesh, SRGBColorSpace, Triangle, Vector3,
	type MeshBasicMaterial,
} from 'three';
import type { HitPointInfo, MeshBVH } from 'three-mesh-bvh';

// The Google surfaces read as voxels: a thin solid layer wherever a surface passes,
// with everything under the ground filled in. Damaged areas are rebuilt from that
// grid after carving, so blasts can tunnel through the ground, join up, and break
// through walls. The rebuilt surface snaps back onto the original geometry where
// it wasn't damaged, colored from the original texture, so it blends in.
//
// Regions are boxes on a global grid of H-sized cells. Inside a region the grid
// replaces the Google tiles completely; the tiles are cut exactly at the box faces
// (see craters.ts), and the rebuilt surface is clamped to those same faces.

export const H = 0.2;
/** Region boxes are built from chunks of CHUNK cells, so they line up between blasts. */
export const CHUNK = 12;
// Upward surfaces this close to street level count as ground (filled underneath).
const GROUND_RISE = 1.2;
const FALLBACK = new Color( 0x8a7a66 );
const BROWN = new Color( 0.62, 0.48, 0.34 );
const LIGHT = new Vector3( 0.4, 0.85, 0.35 ).normalize();

/** Integer cell coordinates, [x0, x1) etc. */
export type CellBox = { x0: number, y0: number, z0: number, x1: number, y1: number, z1: number };
export type Blast = { x: number, y: number, z: number, r: number };

export function worldBox( b: CellBox, target = new Box3() ) {

	return target.set( new Vector3( b.x0 * H, b.y0 * H, b.z0 * H ), new Vector3( b.x1 * H, b.y1 * H, b.z1 * H ) );

}

/** The original (pre-damage) geometry of a tile mesh. */
export function originalGeometry( mesh: Mesh ): BufferGeometry {

	return mesh.userData.twOriginal ?? mesh.geometry;

}

type Snap = { x: number, y: number, z: number, color: Color } | null;

const _hit: HitPointInfo = { point: new Vector3(), distance: 0, faceIndex: 0 };
const _local = new Vector3();
const _inverse = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _v = new Vector3();
const _tri = new Triangle();
const _box = new Box3();
const _color = new Color();

/** A tile mesh the grid is built from, with what's needed to query it. */
class Source {

	geometry: BufferGeometry;
	bvh: MeshBVH;
	inverse: Matrix4;
	image: ImageData | null;

	constructor( public mesh: Mesh ) {

		this.geometry = originalGeometry( mesh );
		if ( ! this.geometry.boundsTree ) this.geometry.computeBoundsTree();
		this.bvh = this.geometry.boundsTree as MeshBVH;
		this.inverse = mesh.matrixWorld.clone().invert();
		this.image = pixels( mesh );

	}

	/** World-space normal of a face. */
	normal( face: number, target: Vector3 ) {

		const [ ia, ib, ic ] = this.corners( face );
		const pos = this.geometry.attributes.position;
		_tri.set( _a.fromBufferAttribute( pos, ia ), _b.fromBufferAttribute( pos, ib ), _c.fromBufferAttribute( pos, ic ) );
		return _tri.getNormal( target ).transformDirection( this.mesh.matrixWorld );

	}

	/** Texture color at a point (local space) on a face. */
	color( face: number, point: Vector3, target: Color ) {

		const uv = this.geometry.attributes.uv;
		if ( ! uv || ! this.image ) return target.copy( FALLBACK );
		const [ ia, ib, ic ] = this.corners( face );
		const pos = this.geometry.attributes.position;
		_tri.set( _a.fromBufferAttribute( pos, ia ), _b.fromBufferAttribute( pos, ib ), _c.fromBufferAttribute( pos, ic ) );
		_tri.getBarycoord( point, _v );
		const u = uv.getX( ia ) * _v.x + uv.getX( ib ) * _v.y + uv.getX( ic ) * _v.z;
		const v = uv.getY( ia ) * _v.x + uv.getY( ib ) * _v.y + uv.getY( ic ) * _v.z;
		return sample( this.image, u, v, target );

	}

	corners( face: number ): [ number, number, number ] {

		const index = this.geometry.index;
		return index
			? [ index.getX( face * 3 ), index.getX( face * 3 + 1 ), index.getX( face * 3 + 2 ) ]
			: [ face * 3, face * 3 + 1, face * 3 + 2 ];

	}

}

/** A voxelized box of the world: the original solid, plus cached surface snapping. */
export class Region {

	readonly nx: number;
	readonly ny: number;
	readonly nz: number;
	/** 1 where the original world is solid. */
	readonly solid: Uint8Array;
	private sources: Source[];
	private snaps = new Map<number, Snap>();

	constructor( readonly box: CellBox, meshes: Mesh[], floor: number ) {

		this.nx = box.x1 - box.x0;
		this.ny = box.y1 - box.y0;
		this.nz = box.z1 - box.z0;
		this.solid = new Uint8Array( this.nx * this.ny * this.nz );
		this.sources = meshes.map( m => new Source( m ) );
		this.classify( floor );

	}

	private id( i: number, j: number, k: number ) {

		return ( i * this.ny + j ) * this.nz + k;

	}

	/** Marks surface cells as solid, then fills everything under the ground. */
	private classify( floor: number ) {

		const { box, nx, ny, nz } = this;
		const surface = new Uint8Array( nx * ny * nz );
		const region = worldBox( box );
		const cell = new Box3();
		const tri = new Triangle();

		for ( const source of this.sources ) {

			// The region in the tile's local space (an axis-aligned bound of it).
			const local = region.clone().applyMatrix4( source.inverse );
			source.bvh.shapecast( {
				intersectsBounds: b => b.intersectsBox( local ),
				intersectsTriangle: t => {

					tri.a.copy( t.a ).applyMatrix4( source.mesh.matrixWorld );
					tri.b.copy( t.b ).applyMatrix4( source.mesh.matrixWorld );
					tri.c.copy( t.c ).applyMatrix4( source.mesh.matrixWorld );
					_box.setFromPoints( [ tri.a, tri.b, tri.c ] );
					const i0 = Math.max( 0, Math.floor( _box.min.x / H ) - box.x0 ), i1 = Math.min( nx - 1, Math.floor( _box.max.x / H ) - box.x0 );
					const j0 = Math.max( 0, Math.floor( _box.min.y / H ) - box.y0 ), j1 = Math.min( ny - 1, Math.floor( _box.max.y / H ) - box.y0 );
					const k0 = Math.max( 0, Math.floor( _box.min.z / H ) - box.z0 ), k1 = Math.min( nz - 1, Math.floor( _box.max.z / H ) - box.z0 );
					for ( let i = i0; i <= i1; i ++ ) for ( let j = j0; j <= j1; j ++ ) for ( let k = k0; k <= k1; k ++ ) {

						const n = this.id( i, j, k );
						if ( surface[ n ] ) continue;
						cell.min.set( ( box.x0 + i ) * H, ( box.y0 + j ) * H, ( box.z0 + k ) * H );
						cell.max.set( cell.min.x + H, cell.min.y + H, cell.min.z + H );
						if ( cell.intersectsTriangle( tri ) ) surface[ n ] = 1;

					}
					return false;

				},
			} );

		}

		// Fill under the ground: below the lowest surface in each column if that's
		// near street level, and always below street level itself.
		for ( let i = 0; i < nx; i ++ ) for ( let k = 0; k < nz; k ++ ) {

			let lowest = - 1;
			for ( let j = 0; j < ny; j ++ ) if ( surface[ this.id( i, j, k ) ] ) {

				lowest = j;
				break;

			}
			const lowestY = ( box.y0 + lowest ) * H;
			for ( let j = 0; j < ny; j ++ ) {

				const n = this.id( i, j, k );
				const y = ( box.y0 + j + 0.5 ) * H;
				const underGround = lowest >= 0 && lowestY < floor + GROUND_RISE ? j < lowest : y < floor;
				this.solid[ n ] = surface[ n ] || underGround ? 1 : 0;

			}

		}

	}

	/** Closest original surface point near `p` whose face looks toward `air`, with its color. */
	private snap( key: number, p: Vector3, air: Vector3 ): Snap {

		if ( this.snaps.has( key ) ) return this.snaps.get( key )!;
		let best: Snap = null;
		let bestDistance = H * 2;
		for ( const source of this.sources ) {

			_local.copy( p ).applyMatrix4( source.inverse );
			const hit = source.bvh.closestPointToPoint( _local, _hit, 0, bestDistance );
			if ( ! hit || hit.distance >= bestDistance ) continue;
			if ( source.normal( hit.faceIndex, _n ).dot( air ) < 0.2 ) continue;
			bestDistance = hit.distance;
			const world = hit.point.clone().applyMatrix4( source.mesh.matrixWorld );
			best = { x: world.x, y: world.y, z: world.z, color: source.color( hit.faceIndex, hit.point, new Color() ) };

		}
		this.snaps.set( key, best );
		return best;

	}

	/** Color of the nearest original surface (any facing), for newly exposed material. */
	private nearestColor( p: Vector3, target: Color ) {

		let bestDistance = 4;
		target.copy( FALLBACK );
		for ( const source of this.sources ) {

			_local.copy( p ).applyMatrix4( source.inverse );
			const hit = source.bvh.closestPointToPoint( _local, _hit, 0, bestDistance );
			if ( ! hit || hit.distance >= bestDistance ) continue;
			bestDistance = hit.distance;
			source.color( hit.faceIndex, hit.point, target );

		}
		return target;

	}

	/** Builds the region's surface with `blasts` carved out. */
	build( blasts: Blast[] ): BufferGeometry | null {

		const { box, nx, ny, nz } = this;
		const near = blasts.filter( b => worldBox( box, _box ).distanceToPoint( _v.set( b.x, b.y, b.z ) ) < b.r );
		// Occupancy at a voxel, with the region's edge layer repeated outward so no
		// surface forms across the box faces.
		const state = new Uint8Array( nx * ny * nz ); // bit 0 solid now, bit 1 carved away
		for ( let i = 0; i < nx; i ++ ) for ( let j = 0; j < ny; j ++ ) for ( let k = 0; k < nz; k ++ ) {

			const n = this.id( i, j, k );
			if ( ! this.solid[ n ] ) continue;
			const x = ( box.x0 + i + 0.5 ) * H, y = ( box.y0 + j + 0.5 ) * H, z = ( box.z0 + k + 0.5 ) * H;
			let carved = false;
			for ( const b of near ) {

				if ( ( x - b.x ) ** 2 + ( y - b.y ) ** 2 + ( z - b.z ) ** 2 < b.r * b.r ) {

					carved = true;
					break;

				}

			}
			state[ n ] = carved ? 2 : 1;

		}
		const at = ( i: number, j: number, k: number ) => state[ this.id(
			Math.min( nx - 1, Math.max( 0, i ) ), Math.min( ny - 1, Math.max( 0, j ) ), Math.min( nz - 1, Math.max( 0, k ) ) ) ];

		// Surface nets over the lattice of voxel centers, padded one voxel past each face.
		// Cell (a, b, c) spans voxel centers a..a+1, for a in [-1, n - 1].
		const cx = nx + 1, cy = ny + 1, cz = nz + 1;
		const cellId = ( a: number, b: number, c: number ) => ( ( a + 1 ) * cy + ( b + 1 ) ) * cz + ( c + 1 );
		const cellVertex = new Int32Array( cx * cy * cz ).fill( - 1 );
		const positions: number[] = [];
		const colors: number[] = [];
		const exposed: number[] = [];
		const lo = worldBox( box ).min, hi = worldBox( box ).max;
		const offsets = [ [ 0, 0, 0 ], [ 1, 0, 0 ], [ 0, 1, 0 ], [ 1, 1, 0 ], [ 0, 0, 1 ], [ 1, 0, 1 ], [ 0, 1, 1 ], [ 1, 1, 1 ] ];
		const edges = [ [ 0, 1 ], [ 2, 3 ], [ 4, 5 ], [ 6, 7 ], [ 0, 2 ], [ 1, 3 ], [ 4, 6 ], [ 5, 7 ], [ 0, 4 ], [ 1, 5 ], [ 2, 6 ], [ 3, 7 ] ];
		const p = new Vector3();
		const air = new Vector3();

		for ( let a = - 1; a < nx; a ++ ) for ( let b = - 1; b < ny; b ++ ) for ( let c = - 1; c < nz; c ++ ) {

			const s = offsets.map( ( [ dx, dy, dz ] ) => at( a + dx, b + dy, c + dz ) );
			let solidCount = 0;
			for ( const v of s ) if ( v & 1 ) solidCount ++;
			if ( solidCount === 0 || solidCount === 8 ) continue;

			// Vertex at the average of the crossing edges' midpoints.
			p.set( 0, 0, 0 );
			let count = 0;
			for ( const [ ea, eb ] of edges ) {

				if ( ( s[ ea ] & 1 ) === ( s[ eb ] & 1 ) ) continue;
				p.x += ( offsets[ ea ][ 0 ] + offsets[ eb ][ 0 ] ) / 2;
				p.y += ( offsets[ ea ][ 1 ] + offsets[ eb ][ 1 ] ) / 2;
				p.z += ( offsets[ ea ][ 2 ] + offsets[ eb ][ 2 ] ) / 2;
				count ++;

			}
			p.divideScalar( count ).add( _v.set( box.x0 + a + 0.5, box.y0 + b + 0.5, box.z0 + c + 0.5 ) ).multiplyScalar( H );
			// Direction toward air (from solid corners toward empty ones).
			air.set( 0, 0, 0 );
			offsets.forEach( ( [ dx, dy, dz ], n ) => air.add( _v.set( dx - 0.5, dy - 0.5, dz - 0.5 ).multiplyScalar( s[ n ] & 1 ? - 1 : 1 ) ) );
			air.normalize();
			const carved = s.some( v => v === 2 );

			let depth = 0;
			const color = new Color();
			const snapped = carved ? null : this.snap( cellId( a, b, c ), p, air );
			if ( snapped ) {

				// Undamaged surface: back onto the original geometry, with its color.
				p.set( snapped.x, snapped.y, snapped.z );
				color.copy( snapped.color );

			} else {

				// Newly exposed material: round it onto the blast that exposed it.
				let blast: Blast | null = null;
				let gap = Infinity;
				for ( const bl of near ) {

					const d = Math.abs( _v.set( bl.x, bl.y, bl.z ).distanceTo( p ) - bl.r );
					if ( d < gap ) {

						gap = d;
						blast = bl;

					}

				}
				if ( blast && carved && gap < H * 1.5 ) p.sub( _v.set( blast.x, blast.y, blast.z ) ).setLength( blast.r ).add( _v );
				this.nearestColor( p, color );
				depth = carved ? 1 : 0.5;

			}
			p.clamp( lo, hi );
			cellVertex[ cellId( a, b, c ) ] = positions.length / 3;
			positions.push( p.x, p.y, p.z );
			colors.push( color.r, color.g, color.b );
			exposed.push( depth );

		}

		// A quad across every voxel edge where solid meets air.
		const index: number[] = [];
		const e1 = new Vector3(), e2 = new Vector3();
		const axes = [ [ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ] ];
		for ( let i = - 1; i < nx; i ++ ) for ( let j = - 1; j < ny; j ++ ) for ( let k = - 1; k < nz; k ++ ) {

			const s0 = at( i, j, k ) & 1;
			for ( let axis = 0; axis < 3; axis ++ ) {

				const [ dx, dy, dz ] = axes[ axis ];
				const s1 = at( i + dx, j + dy, k + dz ) & 1;
				if ( s0 === s1 ) continue;
				const [ u, v ] = axis === 0 ? [ [ 0, 1, 0 ], [ 0, 0, 1 ] ] : axis === 1 ? [ [ 0, 0, 1 ], [ 1, 0, 0 ] ] : [ [ 1, 0, 0 ], [ 0, 1, 0 ] ];
				const cellAt = ( m: number, n: number ) => {

					const a = i - u[ 0 ] * m - v[ 0 ] * n, b = j - u[ 1 ] * m - v[ 1 ] * n, c = k - u[ 2 ] * m - v[ 2 ] * n;
					if ( a < - 1 || b < - 1 || c < - 1 || a >= nx || b >= ny || c >= nz ) return - 1;
					return cellVertex[ cellId( a, b, c ) ];

				};
				const q = [ cellAt( 1, 1 ), cellAt( 0, 1 ), cellAt( 0, 0 ), cellAt( 1, 0 ) ];
				if ( q.some( n => n < 0 ) ) continue;
				// Wind it to face the air side.
				e1.fromArray( positions, q[ 1 ] * 3 ).sub( _v.fromArray( positions, q[ 0 ] * 3 ) );
				e2.fromArray( positions, q[ 2 ] * 3 ).sub( _v );
				const facing = e1.cross( e2 ).dot( _n.set( dx, dy, dz ).multiplyScalar( s0 ? 1 : - 1 ) );
				if ( facing >= 0 ) index.push( q[ 0 ], q[ 1 ], q[ 2 ], q[ 0 ], q[ 2 ], q[ 3 ] );
				else index.push( q[ 0 ], q[ 2 ], q[ 1 ], q[ 0 ], q[ 3 ], q[ 2 ] );

			}

		}
		if ( ! index.length ) return null;

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
		geometry.setIndex( index );
		geometry.computeVertexNormals();
		// Exposed material is browned, darker with depth, and lightly shaded so the
		// crater shape reads next to the unlit photo tiles.
		const normal = geometry.attributes.normal;
		const out = new Float32Array( colors.length );
		const burnt = new Color();
		for ( let n = 0; n < exposed.length; n ++ ) {

			_color.setRGB( colors[ n * 3 ], colors[ n * 3 + 1 ], colors[ n * 3 + 2 ] );
			if ( exposed[ n ] > 0 ) {

				burnt.copy( _color ).multiply( BROWN ).multiplyScalar( 0.5 + Math.random() * 0.15 );
				_color.lerp( burnt, 0.85 * exposed[ n ] );
				_n.fromBufferAttribute( normal, n );
				_color.multiplyScalar( 0.7 + 0.4 * Math.max( 0, _n.dot( LIGHT ) ) );

			}
			_color.toArray( out, n * 3 );

		}
		geometry.setAttribute( 'color', new BufferAttribute( out, 3 ) );
		geometry.computeBoundingSphere();
		geometry.computeBoundingBox();
		return geometry;

	}

}

// Decoded texture pixels, so the rebuilt surface and debris can be colored from the imagery.
const pixelCache = new WeakMap<object, ImageData | null>();

export function pixels( mesh: Mesh ): ImageData | null {

	const image = ( mesh.material as MeshBasicMaterial ).map?.image as CanvasImageSource & { width: number, height: number } | undefined;
	if ( ! image || ! image.width ) return null;
	if ( pixelCache.has( image ) ) return pixelCache.get( image )!;
	let data: ImageData | null = null;
	try {

		const canvas = new OffscreenCanvas( image.width, image.height );
		const context = canvas.getContext( '2d' )!;
		context.drawImage( image, 0, 0 );
		data = context.getImageData( 0, 0, image.width, image.height );

	} catch {

		data = null;

	}
	pixelCache.set( image, data );
	return data;

}

export function sample( data: ImageData | null, u: number, v: number, target: Color ) {

	if ( ! data ) return target.copy( FALLBACK );
	// glTF textures aren't flipped, so v runs down the image.
	const x = Math.min( data.width - 1, Math.floor( ( u - Math.floor( u ) ) * data.width ) );
	const y = Math.min( data.height - 1, Math.floor( ( v - Math.floor( v ) ) * data.height ) );
	const i = ( y * data.width + x ) * 4;
	return target.setRGB( data.data[ i ] / 255, data.data[ i + 1 ] / 255, data.data[ i + 2 ] / 255, SRGBColorSpace );

}
