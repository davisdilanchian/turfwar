import {
	BufferAttribute, BufferGeometry, Color, Group, Matrix4, SRGBColorSpace, Triangle, Vector3,
	type Material, type Mesh, type MeshBasicMaterial, type Object3D, type WebGLProgramParametersWithUniforms,
} from 'three';

// Craters deform the terrain mesh itself; nothing is added beside it.
//
// Every vertex remembers where it started on the original surface. Near a blast
// the triangles are subdivided, then each affected vertex is placed from scratch:
// start at its original position and, crater by crater in the order they
// happened, push it along that crater's direction (into whatever was hit) until it
// is outside the blast sphere. Everything moves the same way per blast, so the
// surface stays one smooth, connected sheet wrapped onto the crater walls.
//
// Ground is solid all the way down, so blasts keep digging and can tunnel; walls,
// roofs and trees are a WALL-thick shell. If a vertex would have to go deeper than
// the solid allows, the blast went all the way through, so its triangles are
// removed: a real hole you can see and shoot through.
//
// Only crater records are saved; the Google tiles are modified in memory and
// re-damaged whenever they stream in again.
export type Crater = {
	x: number, y: number, z: number, r: number,
	/** Direction the surface is pushed: into whatever was hit. */
	dx: number, dy: number, dz: number,
	/** Ground is solid all the way down; anything else is a WALL-thick shell. */
	ground: boolean,
	/** Typical ground height around the blast, where debris lands. */
	floor: number | null,
	t: number,
};

/** A world-space triangle that was blown away, with a color per corner. */
export type Piece = { a: Vector3, b: Vector3, c: Vector3, colors: [ Color, Color, Color ] };

const STORAGE_KEY = 'turfwar.craters.v8';
const WALL = 0.35;
// How far skirts hang from open edges that moved.
const SKIRT = 0.45;
// Damage paint and subdivision reach past the blast radius for a scorched rim.
const RIM = 1.6;
const MAX_PIECES = 400;
const FALLBACK_COLOR = new Color( 0x8a7a66 );

const _inverse = new Matrix4();
const _tri = new Triangle();
const _closest = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _v = new Vector3();
const _origin = new Vector3();
const _p = new Vector3();

/** Subdivision size near a blast of radius r. */
function spacing( r: number ) {

	return Math.min( 0.4, Math.max( 0.05, r / 5 ) );

}

export class Craters {

	list: Crater[] = [];
	/** Kept for callers that add it to the world; craters no longer create extra meshes. */
	fills = new Group();
	/** Called with the triangles a new crater blew away. */
	onDebris: ( pieces: Piece[], crater: Crater ) => void = () => {};

	/** Tile meshes that may still need craters applied. */
	private pending = new Set<Mesh>();
	private meshes = new Set<Mesh>();
	private fresh = new Set<Crater>();

	constructor() {

		try {

			this.list = JSON.parse( localStorage.getItem( STORAGE_KEY ) || '[]' );

		} catch {

			this.list = [];

		}

	}

	add( center: Vector3, r: number, direction: Vector3, ground: boolean, floor: number | null ) {

		const d = direction.clone().normalize();
		const crater: Crater = { x: center.x, y: center.y, z: center.z, r, dx: d.x, dy: d.y, dz: d.z, ground, floor, t: Date.now() };
		this.list.push( crater );
		this.fresh.add( crater );
		this.meshes.forEach( m => this.pending.add( m ) );
		return crater;

	}

	/** Forgets all craters. Tiles already damaged keep it until they stream in again. */
	clear() {

		this.list = [];
		this.meshes.forEach( m => ( m.userData.twApplied = 0 ) );
		this.save();

	}

	/** Registers a freshly loaded tile mesh so existing craters get applied to it. */
	track( mesh: Mesh ) {

		mesh.userData.twApplied = 0;
		this.meshes.add( mesh );
		this.pending.add( mesh );

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

	/** Applies outstanding craters to tile meshes in the scene. Call once per frame. */
	update( root: Object3D ) {

		const pieces = new Map<Crater, Piece[]>();
		for ( const crater of this.fresh ) pieces.set( crater, [] );

		for ( const mesh of this.pending ) {

			// Tiles are only attached to the scene while visible, so debris comes from
			// what the player actually sees, not from hidden coarser copies.
			if ( ! isUnder( mesh, root ) ) continue;
			mesh.updateWorldMatrix( true, false );
			let changed = false;
			for ( let i = mesh.userData.twApplied; i < this.list.length; i ++ ) {

				const crater = this.list[ i ];
				changed = deform( mesh, crater, this.list, pieces.get( crater ) ?? null ) || changed;

			}
			mesh.userData.twApplied = this.list.length;
			this.pending.delete( mesh );
			if ( changed ) mesh.geometry.computeBoundsTree();

		}

		for ( const [ crater, wiped ] of pieces ) if ( wiped.length ) this.onDebris( wiped, crater );
		if ( this.fresh.size ) {

			this.fresh.clear();
			this.save();

		}

	}

	/** Adds the browning/char damage paint to a tile material. */
	patch( material: Material ) {

		const previous = material.onBeforeCompile;
		const previousKey = material.customProgramCacheKey;
		material.onBeforeCompile = ( shader: WebGLProgramParametersWithUniforms, renderer ) => {

			previous.call( material, shader, renderer );
			shader.vertexShader = 'attribute float twDamage;\nvarying float vTwDamage;\nvarying vec3 vTwWorld;\n' + shader.vertexShader.replace(
				'#include <project_vertex>',
				'#include <project_vertex>\nvTwDamage = twDamage;\nvTwWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
			);
			shader.fragmentShader = DAMAGE_GLSL + shader.fragmentShader.replace( '#include <dithering_fragment>', `
				if ( vTwDamage > 0.001 ) gl_FragColor.rgb = twBurn( gl_FragColor.rgb, vTwWorld, vTwDamage );
				#include <dithering_fragment>` );

		};
		material.customProgramCacheKey = () => previousKey.call( material ) + '|tw-damage';
		material.needsUpdate = true;

	}

	private save() {

		try {

			localStorage.setItem( STORAGE_KEY, JSON.stringify( this.list ) );

		} catch {

			// Storage can be unavailable (private mode); craters then last only for this session.

		}

	}

}

// Damage keeps the real texture but browns it, then chars it where it was blasted deepest.
const DAMAGE_GLSL = /* glsl */`
varying float vTwDamage;
varying vec3 vTwWorld;
float twHash( vec3 p ) { return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 ); }
float twNoise( vec3 p ) {
	vec3 i = floor( p ); vec3 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( twHash( i ), twHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( twHash( i + vec3( 0, 1, 0 ) ), twHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( twHash( i + vec3( 0, 0, 1 ) ), twHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( twHash( i + vec3( 0, 1, 1 ) ), twHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
		f.z );
}
vec3 twBurn( vec3 color, vec3 p, float damage ) {
	float n = twNoise( p * 2.0 ) * 0.6 + twNoise( p * 7.0 ) * 0.3 + twNoise( p * 23.0 ) * 0.1;
	vec3 browned = color * vec3( 0.72, 0.56, 0.40 ) * ( 0.7 + 0.5 * n );
	vec3 charred = browned * 0.3;
	float burnt = smoothstep( 0.7, 1.0, damage + ( n - 0.5 ) * 0.4 );
	return mix( color, mix( browned, charred, burnt ), smoothstep( 0.0, 0.5, damage ) * 0.9 );
}
`;

function isUnder( object: Object3D, root: Object3D ) {

	for ( let o: Object3D | null = object; o; o = o.parent ) if ( o === root ) return true;
	return false;

}

/** The original (pre-damage) geometry of a tile mesh. */
function originalGeometry( mesh: Mesh ): BufferGeometry {

	return mesh.userData.twOriginal ?? mesh.geometry;

}

// Decoded texture pixels, so debris can be colored from the real imagery.
const pixelCache = new WeakMap<object, ImageData | null>();

function pixels( mesh: Mesh ): ImageData | null {

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

function sample( data: ImageData | null, u: number, v: number, target: Color ) {

	if ( ! data ) return target.copy( FALLBACK_COLOR );
	// glTF textures aren't flipped, so v runs down the image.
	const x = Math.min( data.width - 1, Math.floor( ( u - Math.floor( u ) ) * data.width ) );
	const y = Math.min( data.height - 1, Math.floor( ( v - Math.floor( v ) ) * data.height ) );
	const i = ( y * data.width + x ) * 4;
	return target.setRGB( data.data[ i ] / 255, data.data[ i + 1 ] / 255, data.data[ i + 2 ] / 255, SRGBColorSpace );

}

/**
 * Applies `crater` to `mesh` (with every other crater nearby, so the result doesn't
 * depend on order). Blown-away triangles go into `wiped` if given.
 */
function deform( mesh: Mesh, crater: Crater, all: Crater[], wiped: Piece[] | null ): boolean {

	const geometry = mesh.geometry;
	const scale = mesh.matrixWorld.getMaxScaleOnAxis();
	_inverse.copy( mesh.matrixWorld ).invert();
	const center = new Vector3( crater.x, crater.y, crater.z ).applyMatrix4( _inverse );
	const reach = crater.r * RIM / scale;

	if ( ! geometry.boundingSphere ) geometry.computeBoundingSphere();
	if ( geometry.boundingSphere!.distanceToPoint( center ) > reach ) return false;

	// Copy every attribute into growable plain arrays (handles quantized and interleaved data).
	const skip = [ 'twDamage', 'twOrigin', 'twHole' ];
	const names = Object.keys( geometry.attributes ).filter( n => ! skip.includes( n ) );
	const data: Record<string, number[]> = {};
	const sizes: Record<string, number> = {};
	const first = ! geometry.attributes.twOrigin;
	// After the first blast, only the "core" sheet is reshaped; skirts are rebuilt each time.
	const count: number = first ? geometry.attributes.position.count : mesh.userData.twCoreCount;
	const read = ( name: string ) => {

		const attr = geometry.attributes[ name ];
		const out = new Array<number>( count * attr.itemSize );
		for ( let i = 0; i < count; i ++ ) for ( let k = 0; k < attr.itemSize; k ++ ) out[ i * attr.itemSize + k ] = attr.getComponent( i, k );
		return out;

	};
	for ( const name of names ) {

		sizes[ name ] = geometry.attributes[ name ].itemSize;
		data[ name ] = read( name );

	}
	const index: number[] = ! first ? mesh.userData.twCoreIndex
		: geometry.index ? Array.from( geometry.index.array ) : Array.from( { length: count }, ( _, i ) => i );
	// Per-vertex memory of the original surface, created on the first blast.
	const origin = first ? data.position.slice() : read( 'twOrigin' );
	const burn = first ? new Array<number>( count ).fill( 0 ) : read( 'twDamage' );
	const hole = first ? new Array<number>( count ).fill( 0 ) : read( 'twHole' );
	const holeIndex: number[] = first ? [] : ( mesh.userData.twHoleIndex ?? [] );
	const pos = data.position;

	let vertexCount = count;
	const midpoints = new Map<string, number>();
	const midpoint = ( i: number, j: number ) => {

		const key = i < j ? `${ i }_${ j }` : `${ j }_${ i }`;
		let m = midpoints.get( key );
		if ( m === undefined ) {

			m = vertexCount ++;
			for ( const name of names ) {

				const s = sizes[ name ], arr = data[ name ];
				for ( let k = 0; k < s; k ++ ) arr.push( ( arr[ i * s + k ] + arr[ j * s + k ] ) / 2 );

			}
			for ( let k = 0; k < 3; k ++ ) origin.push( ( origin[ i * 3 + k ] + origin[ j * 3 + k ] ) / 2 );
			burn.push( ( burn[ i ] + burn[ j ] ) / 2 );
			hole.push( 0 );
			midpoints.set( key, m );

		}
		return m;

	};
	// Subdivision works on the original surface, so repeated blasts refine consistently.
	const at = ( i: number, v: Vector3 ) => v.fromArray( origin, i * 3 );
	const touches = ( a: number, b: number, c: number ) => {

		_tri.set( at( a, _a ), at( b, _b ), at( c, _c ) );
		_tri.closestPointToPoint( center, _closest );
		return _closest.distanceTo( center ) <= reach;

	};

	// Split triangles near the blast until their edges are short enough to bend smoothly.
	const target = spacing( crater.r ) / scale;
	const outIndex: number[] = [];
	let touched = false;
	const split = ( a: number, b: number, c: number, depth: number ) => {

		at( a, _a ); at( b, _b ); at( c, _c );
		const ab = _a.distanceTo( _b ), bc = _b.distanceTo( _c ), ca = _c.distanceTo( _a );
		const longest = Math.max( ab, bc, ca );
		if ( longest <= target || depth > 14 || ! touches( a, b, c ) ) {

			outIndex.push( a, b, c );
			return;

		}
		if ( longest === ab ) {

			const m = midpoint( a, b );
			split( a, m, c, depth + 1 ); split( m, b, c, depth + 1 );

		} else if ( longest === bc ) {

			const m = midpoint( b, c );
			split( a, b, m, depth + 1 ); split( a, m, c, depth + 1 );

		} else {

			const m = midpoint( c, a );
			split( a, b, m, depth + 1 ); split( m, b, c, depth + 1 );

		}

	};
	const allIndex = [ ...index, ...holeIndex ];
	for ( let t = 0; t < allIndex.length; t += 3 ) {

		const a = allIndex[ t ], b = allIndex[ t + 1 ], c = allIndex[ t + 2 ];
		if ( touches( a, b, c ) ) {

			touched = true;
			split( a, b, c, 0 );

		} else {

			outIndex.push( a, b, c );

		}

	}
	if ( ! touched ) return false;

	// Every crater that can reach this mesh (in creation order), in its local space.
	const blasts = all
		.map( c => ( {
			center: new Vector3( c.x, c.y, c.z ).applyMatrix4( _inverse ),
			dir: new Vector3( c.dx, c.dy, c.dz ).transformDirection( _inverse ),
			r: c.r / scale,
			depth: c.ground ? Infinity : WALL / scale,
		} ) )
		.filter( b => geometry.boundingSphere!.distanceToPoint( b.center ) < b.r * RIM );

	// Record what gets blown away (original surface, world space) for debris.
	if ( wiped ) {

		const image = pixels( mesh );
		const uv = data.uv;
		const corner = ( i: number ) => uv ? sample( image, uv[ i * 2 ], uv[ i * 2 + 1 ], new Color() ) : FALLBACK_COLOR.clone();
		const r = crater.r / scale;
		for ( let t = 0; t < outIndex.length && wiped.length < MAX_PIECES; t += 3 ) {

			const a = outIndex[ t ], b = outIndex[ t + 1 ], c = outIndex[ t + 2 ];
			at( a, _a ); at( b, _b ); at( c, _c );
			if ( _v.addVectors( _a, _b ).add( _c ).divideScalar( 3 ).distanceTo( center ) > r * 0.9 ) continue;
			wiped.push( {
				a: _a.clone().applyMatrix4( mesh.matrixWorld ),
				b: _b.clone().applyMatrix4( mesh.matrixWorld ),
				c: _c.clone().applyMatrix4( mesh.matrixWorld ),
				colors: [ corner( a ), corner( b ), corner( c ) ],
			} );

		}

	}

	// Place every vertex near this blast from its original position: each crater in
	// turn pushes it along its direction until it is outside that crater's sphere.
	for ( let i = 0; i < vertexCount; i ++ ) {

		at( i, _origin );
		if ( _origin.distanceTo( center ) > reach ) continue;
		_p.copy( _origin );
		let through = false;
		let pushed = 0;
		for ( const b of blasts ) {

			_v.subVectors( _p, b.center );
			const inside = b.r * b.r - _v.lengthSq();
			if ( inside <= 1e-6 ) continue;
			const k = _v.dot( b.dir );
			const t = - k + Math.sqrt( k * k + inside );
			_p.addScaledVector( b.dir, t );
			pushed += t;
			// Pushed deeper than the material is thick: blown clean through.
			if ( t >= b.depth ) through = true;

		}
		hole[ i ] = through ? 1 : 0;
		pos[ i * 3 ] = _p.x;
		pos[ i * 3 + 1 ] = _p.y;
		pos[ i * 3 + 2 ] = _p.z;
		const t = pushed;

		// Brown by how far it was pushed, plus a scorched rim around the blast.
		const rim = 1 - Math.max( 0, _origin.distanceTo( center ) - crater.r / scale ) / ( reach - crater.r / scale );
		burn[ i ] = Math.max( burn[ i ], Math.min( 1, t * scale / 0.6 ), rim * 0.55 );

	}

	// Triangles touching a hole vertex are blown through; keep them aside so a later
	// blast can still reshape them consistently.
	const finalIndex: number[] = [];
	const nextHoles: number[] = [];
	for ( let t = 0; t < outIndex.length; t += 3 ) {

		const a = outIndex[ t ], b = outIndex[ t + 1 ], c = outIndex[ t + 2 ];
		( hole[ a ] || hole[ b ] || hole[ c ] ? nextHoles : finalIndex ).push( a, b, c );

	}

	// Skirts: every open edge that moved (a tile boundary, or the rim of a hole)
	// gets a strip hanging into the solid. It hides cracks where neighbouring tiles
	// bend slightly differently, and gives hole rims visible thickness.
	const coreCount = vertexCount;
	const key = ( i: number ) => `${ Math.round( origin[ i * 3 ] * 1e4 ) },${ Math.round( origin[ i * 3 + 1 ] * 1e4 ) },${ Math.round( origin[ i * 3 + 2 ] * 1e4 ) }`;
	const edgeUse = new Map<string, number>();
	const edgeKey = ( a: number, b: number ) => {

		const ka = key( a ), kb = key( b );
		return ka < kb ? `${ ka }|${ kb }` : `${ kb }|${ ka }`;

	};
	for ( let t = 0; t < finalIndex.length; t += 3 ) {

		for ( let e = 0; e < 3; e ++ ) {

			const k = edgeKey( finalIndex[ t + e ], finalIndex[ t + ( e + 1 ) % 3 ] );
			edgeUse.set( k, ( edgeUse.get( k ) ?? 0 ) + 1 );

		}

	}
	const moved = ( i: number ) => Math.hypot( pos[ i * 3 ] - origin[ i * 3 ], pos[ i * 3 + 1 ] - origin[ i * 3 + 1 ], pos[ i * 3 + 2 ] - origin[ i * 3 + 2 ] );
	const blastDir = new Vector3( crater.dx, crater.dy, crater.dz ).transformDirection( _inverse );
	const skirtDepth = SKIRT / scale;
	const skirtIndex: number[] = [];
	const hang = new Map<number, number>();
	const hanging = ( i: number ) => {

		let h = hang.get( i );
		if ( h !== undefined ) return h;
		h = vertexCount ++;
		for ( const name of names ) {

			const size = sizes[ name ], arr = data[ name ];
			for ( let k = 0; k < size; k ++ ) arr.push( arr[ i * size + k ] );

		}
		const m = moved( i );
		if ( m > 1e-4 ) _v.set( pos[ i * 3 ] - origin[ i * 3 ], pos[ i * 3 + 1 ] - origin[ i * 3 + 1 ], pos[ i * 3 + 2 ] - origin[ i * 3 + 2 ] ).divideScalar( m );
		else _v.copy( blastDir );
		pos[ h * 3 ] = pos[ i * 3 ] + _v.x * skirtDepth;
		pos[ h * 3 + 1 ] = pos[ i * 3 + 1 ] + _v.y * skirtDepth;
		pos[ h * 3 + 2 ] = pos[ i * 3 + 2 ] + _v.z * skirtDepth;
		origin.push( origin[ i * 3 ], origin[ i * 3 + 1 ], origin[ i * 3 + 2 ] );
		burn.push( 1 );
		hole.push( 0 );
		hang.set( i, h );
		return h;

	};
	for ( let t = 0; t < finalIndex.length; t += 3 ) {

		for ( let e = 0; e < 3; e ++ ) {

			const a = finalIndex[ t + e ], b = finalIndex[ t + ( e + 1 ) % 3 ];
			if ( edgeUse.get( edgeKey( a, b ) ) !== 1 ) continue;
			if ( moved( a ) * scale < 0.02 && moved( b ) * scale < 0.02 ) continue;
			const ha = hanging( a ), hb = hanging( b );
			// Both windings, so the strip shows from either side.
			skirtIndex.push( a, b, hb, a, hb, ha, a, hb, b, a, ha, hb );

		}

	}

	const next = new BufferGeometry();
	for ( const name of names ) next.setAttribute( name, new BufferAttribute( new Float32Array( data[ name ] ), sizes[ name ] ) );
	next.setAttribute( 'twOrigin', new BufferAttribute( new Float32Array( origin ), 3 ) );
	next.setAttribute( 'twDamage', new BufferAttribute( new Float32Array( burn ), 1 ) );
	next.setAttribute( 'twHole', new BufferAttribute( new Float32Array( hole ), 1 ) );
	next.setIndex( [ ...finalIndex, ...skirtIndex ] );
	if ( next.attributes.normal ) next.computeVertexNormals();
	next.computeBoundingSphere();
	next.computeBoundingBox();
	mesh.userData.twHoleIndex = nextHoles;
	mesh.userData.twCoreIndex = finalIndex;
	mesh.userData.twCoreCount = coreCount;
	// Keep the untouched original (and its BVH): solid depth is measured against it.
	if ( ! mesh.userData.twOriginal ) {

		mesh.userData.twOriginal = geometry;
		if ( ! geometry.boundsTree ) geometry.computeBoundsTree();

	} else {

		geometry.disposeBoundsTree();
		geometry.dispose();

	}
	mesh.geometry = next;
	return true;

}
