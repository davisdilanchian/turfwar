import {
	BackSide, BufferAttribute, Color, Group, Material, MathUtils, Mesh, MeshStandardMaterial, SphereGeometry, Vector3, Vector4,
	type WebGLProgramParametersWithUniforms,
} from 'three';

// A crater is a sphere in world space (the local frame centered on Alexander St).
// Tile pixels inside it are discarded, collision ignores tile surfaces inside it,
// and where the sphere dips below the ground it gets a "bowl": the part of the
// sphere under ground level, seen from inside, so holes in the ground have a floor.
// Craters are our own data, so they can be saved; Google content never is.
export type Crater = {
	x: number, y: number, z: number, r: number,
	/** Height of the bowl's rim (ground level at the crater), or null for no bowl. */
	top: number | null,
	t: number,
};

const MAX_SHADER_CRATERS = 128;
const STORAGE_KEY = 'turfwar.craters';
const _p = new Vector3();
const _color = new Color();
const RIM_COLOR = new Color( 0x8a7058 );
const BOTTOM_COLOR = new Color( 0x2e241c );

export class Craters {

	list: Crater[] = [];
	bowls = new Group();

	private uniforms = {
		twCraters: { value: Array.from( { length: MAX_SHADER_CRATERS }, () => new Vector4() ) },
		twCraterCount: { value: 0 },
	};
	private bowlMaterial = new MeshStandardMaterial( { vertexColors: true, flatShading: true, roughness: 1, side: BackSide } );
	private dirty = true;
	private lastFocus = new Vector3( Infinity, 0, 0 );

	constructor() {

		this.patch( this.bowlMaterial, 'bowl' );
		try {

			this.list = JSON.parse( localStorage.getItem( STORAGE_KEY ) || '[]' );

		} catch {

			this.list = [];

		}
		this.list.forEach( c => this.addBowl( c ) );

	}

	/** `ground` is the ground height at the crater; pass null if the blast doesn't reach the ground. */
	add( center: Vector3, r: number, ground: number | null ) {

		// Lift the rim a touch so it covers slightly sloped ground at the edge of the hole.
		const top = ground === null || ground < center.y - r ? null : Math.min( ground + 0.1, center.y + r * 0.9 );
		const crater = { x: center.x, y: center.y, z: center.z, r, top, t: Date.now() };
		this.list.push( crater );
		this.addBowl( crater );
		this.dirty = true;
		this.save();
		return crater;

	}

	clear() {

		this.list = [];
		this.bowls.clear();
		this.dirty = true;
		this.save();

	}

	/** True if `p` is inside any crater (with a hair of margin so a bowl isn't cut by its own crater). */
	inside( p: Vector3, except?: Crater ) {

		for ( const c of this.list ) {

			if ( c === except ) continue;
			const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
			if ( dx * dx + dy * dy + dz * dz < c.r * c.r * 0.998 ) return true;

		}
		return false;

	}

	/** Sends the craters nearest `focus` to the shaders. Call once per frame. */
	update( focus: Vector3 ) {

		if ( ! this.dirty && focus.distanceToSquared( this.lastFocus ) < 25 ) return;
		this.dirty = false;
		this.lastFocus.copy( focus );

		const nearest = this.list
			.map( c => ( { c, d: _p.set( c.x, c.y, c.z ).distanceTo( focus ) - c.r } ) )
			.sort( ( a, b ) => a.d - b.d )
			.slice( 0, MAX_SHADER_CRATERS );
		nearest.forEach( ( { c }, i ) => this.uniforms.twCraters.value[ i ].set( c.x, c.y, c.z, c.r ) );
		this.uniforms.twCraterCount.value = nearest.length;

	}

	/**
	 * Adds crater cutting to a material. Tiles also get scorch around craters, and their
	 * back faces are drawn dark so a hole in a hollow building shell reads as a dark inside.
	 */
	patch( material: Material, kind: 'tile' | 'bowl' ) {

		const tile = kind === 'tile';

		const previous = material.onBeforeCompile;
		const previousKey = material.customProgramCacheKey;
		material.onBeforeCompile = ( shader: WebGLProgramParametersWithUniforms, renderer ) => {

			previous.call( material, shader, renderer );
			Object.assign( shader.uniforms, this.uniforms );
			shader.vertexShader = 'varying vec3 vTwWorld;\n' + shader.vertexShader.replace(
				'#include <project_vertex>',
				'#include <project_vertex>\nvTwWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
			);
			shader.fragmentShader = [
				'varying vec3 vTwWorld;',
				`uniform vec4 twCraters[ ${ MAX_SHADER_CRATERS } ];`,
				'uniform int twCraterCount;',
				shader.fragmentShader,
			].join( '\n' ).replace( 'void main() {', `void main() {
				float twScorch = 1.0;
				for ( int i = 0; i < ${ MAX_SHADER_CRATERS }; i ++ ) {
					if ( i >= twCraterCount ) break;
					vec4 c = twCraters[ i ];
					float d = distance( vTwWorld, c.xyz );
					if ( d < c.w * 0.999 ) discard;
					twScorch = min( twScorch, mix( 0.3, 1.0, smoothstep( c.w, c.w * 1.7, d ) ) );
				}` ).replace( '#include <dithering_fragment>', tile ? `gl_FragColor.rgb *= twScorch;
				if ( ! gl_FrontFacing ) gl_FragColor.rgb *= 0.15;
				#include <dithering_fragment>` : '#include <dithering_fragment>' );

		};
		material.customProgramCacheKey = () => previousKey.call( material ) + '|tw-' + kind;
		material.needsUpdate = true;

	}

	private addBowl( c: Crater ) {

		if ( c.top === null ) return;
		// The cap of the sphere below the rim: theta runs from +Y (0) to -Y (PI).
		// Slightly oversized so its flat faces stay outside its own crater's cut.
		const thetaStart = Math.acos( MathUtils.clamp( ( c.top - c.y ) / c.r, - 1, 1 ) );
		const detail = c.r < 1 ? 12 : 32;
		const geometry = new SphereGeometry( c.r * 1.01, detail, detail / 2, 0, Math.PI * 2, thetaStart, Math.PI - thetaStart );
		// Packed dirt at the rim fading to dark, scorched soil at the bottom, with some grit.
		const positions = geometry.attributes.position;
		const colors = new Float32Array( positions.count * 3 );
		for ( let i = 0; i < positions.count; i ++ ) {

			const depth = MathUtils.clamp( ( c.top - c.y - positions.getY( i ) ) / c.r, 0, 1 );
			const grit = 0.85 + Math.random() * 0.3;
			_color.copy( RIM_COLOR ).lerp( BOTTOM_COLOR, depth ).multiplyScalar( grit );
			_color.toArray( colors, i * 3 );

		}
		geometry.setAttribute( 'color', new BufferAttribute( colors, 3 ) );
		const bowl = new Mesh( geometry, this.bowlMaterial );
		bowl.position.set( c.x, c.y, c.z );
		bowl.userData.crater = c;
		bowl.updateMatrixWorld();
		this.bowls.add( bowl );

	}

	private save() {

		try {

			localStorage.setItem( STORAGE_KEY, JSON.stringify( this.list ) );

		} catch {

			// Storage can be unavailable (private mode); craters then last only for this session.

		}

	}

}
