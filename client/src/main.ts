import {
	AmbientLight, BufferGeometry, Clock, DirectionalLight, MathUtils, Mesh, PerspectiveCamera,
	PMREMGenerator, Raycaster, Scene, Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Craters } from './craters';
import { Debris } from './debris';
import { Player, groundBelow, type Input } from './player';
import { Weapons, type WeaponKind } from './weapons';
import { ORIGIN, createWorld, latLonToWorld, type World, type WorldKind } from './world';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

const statusEl = document.getElementById( 'status' )!;
const overlayEl = document.getElementById( 'overlay' )!;
const readoutEl = document.getElementById( 'readout' )!;
const providerEl = document.getElementById( 'provider' )!;
const copyrightEl = document.getElementById( 'copyright' )!;
const crosshairEl = document.getElementById( 'crosshair' )!;

const renderer = new WebGLRenderer( { antialias: true, logarithmicDepthBuffer: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setClearColor( 0x9cc7e8 );
// The world and the held weapon are drawn in two passes (see the loop).
renderer.autoClear = false;
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
// Cavity fills live in the world so they are drawn, collided with and shot at like tiles.
world.root.add( craters.fills );
scene.add( world.root );
const debris = new Debris( scene );
craters.onDebris = ( pieces, crater ) => debris.spawn( pieces, crater );

const player = new Player();
const weapons = new Weapons( scene, camera, world.root, craters );
// Studio lighting reflections so the weapon's metal reads well.
weapons.viewScene.environment = new PMREMGenerator( renderer ).fromScene( new RoomEnvironment(), 0.04 ).texture;
weapons.viewScene.environmentIntensity = 0.6;
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
	if ( e.code === 'KeyR' && spawned ) {

		// Back to the street spawn in front of the house.
		const spawn = latLonToWorld( world, SPAWN.lat, SPAWN.lon );
		spawnProbe.set( spawn.x, 3000, spawn.z );
		trySpawn();

	}

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
// The spawn point and the house to face come from .env.local, so the address
// stays out of git. Without them you spawn at the launch point facing north.
const env = import.meta.env;
const SPAWN = { lat: Number( env.VITE_SPAWN_LAT ?? ORIGIN.lat ), lon: Number( env.VITE_SPAWN_LON ?? ORIGIN.lon ) };
const HOME = env.VITE_HOME_LAT ? { lat: Number( env.VITE_HOME_LAT ), lon: Number( env.VITE_HOME_LON ) } : null;
const raycaster = new Raycaster();
const spawnProbe = new Vector3();
let spawnYaw = 0;
let hovering = false;
let hoverTime = 0;
let spawned = false;
let spawnGround = 0;

// Where you were in this tab, so a dev-server reload drops you back in place.
// sessionStorage is per tab: a fresh tab still starts at the spawn point.
type Session = { x: number, y: number, z: number, yaw: number, pitch: number, flying: boolean };
const SESSION_KEY = 'turfwar.session';
let resume: Session | null = null;
try {

	resume = JSON.parse( sessionStorage.getItem( SESSION_KEY ) || 'null' );

} catch {

	resume = null;

}
function saveSession() {

	if ( ! spawned ) return;
	const { x, y, z } = player.position;
	try {

		sessionStorage.setItem( SESSION_KEY, JSON.stringify( { x, y, z, yaw: player.yaw, pitch: player.pitch, flying: player.flying } ) );

	} catch {

		// Storage unavailable; reloads will start at the spawn point.

	}

}
window.addEventListener( 'pagehide', saveSession );
// Until the tiles' frame is known, hover above the launch point looking down.
player.position.set( 0, 400, 0 );
player.pitch = - 1.4;

const loaded = () => world.tilesets.every( t => t.loadProgress === 1 && t.visibleTiles.size > 0 );

// Once the root tileset has loaded, move the hover over the spawn point so the
// tiles under it stream in at full detail before dropping in.
function hoverOverSpawn() {

	const spawn = latLonToWorld( world, SPAWN.lat, SPAWN.lon );
	spawnProbe.set( spawn.x, 3000, spawn.z );
	player.position.set( spawn.x, 400, spawn.z );
	if ( HOME ) {

		const home = latLonToWorld( world, HOME.lat, HOME.lon );
		// Forward is -Z rotated by yaw, so face the house with atan2( -dx, -dz ).
		spawnYaw = Math.atan2( - ( home.x - spawn.x ), - ( home.z - spawn.z ) );

	}
	if ( resume ) {

		spawnProbe.set( resume.x, 3000, resume.z );
		player.position.set( resume.x, Math.max( resume.y, 400 ), resume.z );

	}
	hovering = true;

}

function trySpawn() {

	const hit = groundBelow( world.root, spawnProbe, raycaster );
	if ( ! hit ) return;
	spawned = true;
	spawnGround = hit.y;
	player.velocity.set( 0, 0, 0 );
	if ( resume ) {

		player.position.set( resume.x, resume.y, resume.z );
		player.yaw = resume.yaw;
		player.pitch = resume.pitch;
		player.flying = resume.flying;
		resume = null;

	} else {

		player.position.copy( hit ).y += 2;
		player.yaw = spawnYaw;
		player.pitch = 0;

	}
	statusEl.textContent = 'Alexander St, Glendale';

}

// --- loop ----------------------------------------------------------------
const clock = new Clock();
let attributionTimer = 0;
let sessionTimer = 0;

function frame() {

	const dt = Math.min( clock.getDelta(), 0.05 );

	if ( spawned ) {

		player.update( dt, readInput(), world.root );
		if ( player.position.y < spawnGround - 200 ) trySpawn();
		sessionTimer -= dt;
		if ( sessionTimer <= 0 ) {

			sessionTimer = 0.5;
			saveSession();

		}
		for ( const kind of triggers ) weapons.fire( kind );

	} else if ( ! hovering ) {

		if ( world.tilesets[ 0 ].root ) hoverOverSpawn();

	} else {

		hoverTime += dt;
		if ( hoverTime > 1.5 && loaded() ) trySpawn();

	}
	weapons.update( dt );
	debris.update( dt );

	camera.position.copy( player.position );
	camera.rotation.set( player.pitch, player.yaw, 0 );
	if ( weapons.shake > 0 ) {

		camera.position.x += ( Math.random() - 0.5 ) * weapons.shake * 0.4;
		camera.position.y += ( Math.random() - 0.5 ) * weapons.shake * 0.4;

	}
	camera.updateMatrixWorld();
	craters.update( world.root );
	for ( const tiles of world.tilesets ) tiles.update();
	renderer.clear();
	renderer.render( scene, camera );
	renderer.clearDepth();
	renderer.render( weapons.viewScene, camera );
	crosshairEl.style.setProperty( '--spread', `${ 6 + weapons.spread * 14 }px` );

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
