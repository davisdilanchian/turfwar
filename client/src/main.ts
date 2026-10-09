import {
	AmbientLight, BufferGeometry, Clock, DirectionalLight, MathUtils, Mesh, PerspectiveCamera,
	Raycaster, Scene, Vector3, WebGLRenderer,
} from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Craters } from './craters';
import { Player, groundBelow, type Input } from './player';
import { Weapons, type WeaponKind } from './weapons';
import { createWorld, type World, type WorldKind } from './world';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

const statusEl = document.getElementById( 'status' )!;
const overlayEl = document.getElementById( 'overlay' )!;
const readoutEl = document.getElementById( 'readout' )!;
const providerEl = document.getElementById( 'provider' )!;
const copyrightEl = document.getElementById( 'copyright' )!;

const renderer = new WebGLRenderer( { antialias: true, logarithmicDepthBuffer: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setClearColor( 0x9cc7e8 );
document.body.prepend( renderer.domElement );

const scene = new Scene();
scene.add( new AmbientLight( 0xffffff, 2 ) );
const sun = new DirectionalLight( 0xffffff, 1.5 );
sun.position.set( 1, 2, 1 );
scene.add( sun );

const camera = new PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.05, 30000 );
camera.rotation.order = 'YXZ';
scene.add( camera );

// ?world=cesium switches from Google Photorealistic 3D Tiles to Cesium ion
// (World Terrain + OSM Buildings + Bing imagery) for comparison.
const kind: WorldKind = new URLSearchParams( location.search ).get( 'world' ) === 'cesium' ? 'cesium' : 'google';
const craters = new Craters();
let world: World;
try {

	world = createWorld( kind, import.meta.env, renderer, camera, craters );

} catch ( error ) {

	statusEl.textContent = ( error as Error ).message;
	throw error;

}
providerEl.textContent = world.credit;
scene.add( world.root, craters.bowls );

const player = new Player();
const weapons = new Weapons( scene, camera, world.root, craters );
weapons.onExplosion = ( point, radius ) => {

	// Knock the player away from nearby blasts.
	const away = player.position.clone().sub( point );
	const distance = away.length();
	if ( distance < radius * 3 ) {

		player.velocity.addScaledVector( away.normalize(), ( 1 - distance / ( radius * 3 ) ) * 12 );
		player.velocity.y += ( 1 - distance / ( radius * 3 ) ) * 6;
		player.grounded = false;

	}

};

// --- input ---------------------------------------------------------------
const keys = new Set<string>();
const triggers = new Set<WeaponKind>();
window.addEventListener( 'keydown', e => {

	keys.add( e.code );
	if ( e.code === 'KeyF' ) player.flying = ! player.flying;
	if ( e.code === 'KeyX' ) craters.clear();

} );
window.addEventListener( 'keyup', e => keys.delete( e.code ) );
window.addEventListener( 'blur', () => {

	keys.clear();
	triggers.clear();

} );

const locked = () => document.pointerLockElement === renderer.domElement;
overlayEl.addEventListener( 'click', () => renderer.domElement.requestPointerLock() );
document.addEventListener( 'pointerlockchange', () => {

	overlayEl.classList.toggle( 'hidden', locked() );
	if ( ! locked() ) triggers.clear();

} );
document.addEventListener( 'mousemove', e => {

	if ( ! locked() ) return;
	player.yaw -= e.movementX * 0.0022;
	player.pitch = MathUtils.clamp( player.pitch - e.movementY * 0.0022, - 1.5, 1.5 );

} );
document.addEventListener( 'mousedown', e => {

	if ( locked() ) triggers.add( e.button === 2 ? 'rocket' : 'rifle' );

} );
document.addEventListener( 'mouseup', e => triggers.delete( e.button === 2 ? 'rocket' : 'rifle' ) );
document.addEventListener( 'contextmenu', e => e.preventDefault() );

function readInput(): Input {

	const axis = ( a: string, b: string ) => ( keys.has( a ) ? 1 : 0 ) - ( keys.has( b ) ? 1 : 0 );
	return {
		forward: axis( 'KeyW', 'KeyS' ),
		right: axis( 'KeyD', 'KeyA' ),
		up: axis( 'Space', 'ControlLeft' ),
		jump: keys.has( 'Space' ),
		sprint: keys.has( 'ShiftLeft' ),
	};

}

// --- spawn ---------------------------------------------------------------
const raycaster = new Raycaster();
const SPAWN_PROBE = new Vector3( 0, 3000, 0 );
let spawned = false;
let spawnGround = 0;
// While waiting for the ground to load, hover above the launch point looking down
// so the tiles underneath are the ones that stream in.
player.position.set( 0, 400, 0 );
player.pitch = - 1.4;

const loaded = () => world.tilesets.every( t => t.loadProgress === 1 && t.visibleTiles.size > 0 );

function trySpawn() {

	const hit = groundBelow( world.root, SPAWN_PROBE, raycaster );
	if ( ! hit ) return;
	spawned = true;
	spawnGround = hit.y;
	player.position.copy( hit ).y += 2;
	player.velocity.set( 0, 0, 0 );
	player.pitch = 0;
	statusEl.textContent = 'Alexander St, Glendale';

}

// --- loop ----------------------------------------------------------------
const clock = new Clock();
let attributionTimer = 0;

function frame() {

	const dt = Math.min( clock.getDelta(), 0.05 );

	if ( spawned ) {

		player.update( dt, readInput(), world.root, craters );
		if ( player.position.y < spawnGround - 200 ) trySpawn();
		for ( const kind of triggers ) weapons.fire( kind );

	} else if ( loaded() ) {

		trySpawn();

	}
	weapons.update( dt );

	camera.position.copy( player.position );
	camera.rotation.set( player.pitch, player.yaw, 0 );
	if ( weapons.shake > 0 ) {

		camera.position.x += ( Math.random() - 0.5 ) * weapons.shake * 0.4;
		camera.position.y += ( Math.random() - 0.5 ) * weapons.shake * 0.4;

	}
	camera.updateMatrixWorld();
	craters.update( camera.position );
	for ( const tiles of world.tilesets ) tiles.update();
	renderer.render( scene, camera );

	attributionTimer -= dt;
	if ( attributionTimer <= 0 ) {

		attributionTimer = 1;
		copyrightEl.textContent = world.tilesets
			.flatMap( t => t.getAttributions() )
			.filter( a => a.type === 'string' ).map( a => a.value ).join( ' ' );

	}

	const p = player.position;
	readoutEl.textContent = `x ${ p.x.toFixed( 1 ) }  y ${ ( p.y - spawnGround ).toFixed( 1 ) }  z ${ p.z.toFixed( 1 ) }`
		+ `\n${ player.flying ? 'flying' : player.grounded ? 'on ground' : 'airborne' }`
		+ `  ·  craters ${ craters.list.length }`;

	requestAnimationFrame( frame );

}
requestAnimationFrame( frame );

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
	for ( const tiles of world.tilesets ) tiles.setResolutionFromRenderer( camera, renderer );

} );

// Hooks for scripted captures and tests (no effect during normal play).
Object.assign( window, {
	__turfwar: {
		player,
		world,
		craters,
		raycaster,
		camera,
		isReady: () => spawned && loaded(),
		setLook( yaw: number, pitch: number ) {

			player.yaw = yaw;
			player.pitch = pitch;

		},
		fire: ( kind: WeaponKind ) => weapons.fire( kind ),
		hideOverlay: () => overlayEl.classList.add( 'hidden' ),
	},
} );
