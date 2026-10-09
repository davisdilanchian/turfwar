import {
	AmbientLight, BufferGeometry, Clock, DirectionalLight, MathUtils, Mesh, PerspectiveCamera,
	Raycaster, Scene, Vector3, WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Player, groundBelow, type Input } from './player';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

// Launch area: Alexander St, Glendale City Center (street midpoint).
const ORIGIN = { lat: 34.1532, lon: - 118.2672 };

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const statusEl = document.getElementById( 'status' )!;
const overlayEl = document.getElementById( 'overlay' )!;
const readoutEl = document.getElementById( 'readout' )!;
const copyrightEl = document.getElementById( 'copyright' )!;

if ( ! apiKey ) {

	statusEl.textContent = 'Missing VITE_GOOGLE_MAPS_API_KEY in .env.local';
	throw new Error( 'Missing VITE_GOOGLE_MAPS_API_KEY' );

}

const renderer = new WebGLRenderer( { antialias: true, logarithmicDepthBuffer: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setClearColor( 0x9cc7e8 );
document.body.prepend( renderer.domElement );

const scene = new Scene();
scene.add( new AmbientLight( 0xffffff, 2 ) );
const sun = new DirectionalLight( 0xffffff, 1 );
sun.position.set( 1, 2, 1 );
scene.add( sun );

const camera = new PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 30000 );
camera.rotation.order = 'YXZ';

// Google Photorealistic 3D Tiles, re-centered so the launch point is the
// origin with +Y up. Tiles are streamed and only kept in memory.
const tiles = new TilesRenderer();
tiles.registerPlugin( new GoogleCloudAuthPlugin( { apiToken: apiKey, autoRefreshToken: true } ) );
tiles.registerPlugin( new GLTFExtensionsPlugin( {
	dracoLoader: new DRACOLoader().setDecoderPath( 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' ),
} ) );
tiles.registerPlugin( new ReorientationPlugin( {
	lat: ORIGIN.lat * MathUtils.DEG2RAD,
	lon: ORIGIN.lon * MathUtils.DEG2RAD,
	recenter: true,
} ) );
// Lower than the plugin's default of 20 so street level loads in full detail.
tiles.errorTarget = 12;
tiles.setCamera( camera );
tiles.setResolutionFromRenderer( camera, renderer );
tiles.addEventListener( 'dispose-model', ( { scene: model } ) => {

	model.traverse( obj => ( obj as Mesh ).geometry?.disposeBoundsTree?.() );

} );
scene.add( tiles.group );

// --- input ---------------------------------------------------------------
const keys = new Set<string>();
window.addEventListener( 'keydown', e => {

	keys.add( e.code );
	if ( e.code === 'KeyF' ) player.flying = ! player.flying;

} );
window.addEventListener( 'keyup', e => keys.delete( e.code ) );
window.addEventListener( 'blur', () => keys.clear() );

overlayEl.addEventListener( 'click', () => renderer.domElement.requestPointerLock() );
document.addEventListener( 'pointerlockchange', () => {

	overlayEl.classList.toggle( 'hidden', document.pointerLockElement === renderer.domElement );

} );
document.addEventListener( 'mousemove', e => {

	if ( document.pointerLockElement !== renderer.domElement ) return;
	player.yaw -= e.movementX * 0.0022;
	player.pitch = MathUtils.clamp( player.pitch - e.movementY * 0.0022, - 1.5, 1.5 );

} );

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
const player = new Player();
const raycaster = new Raycaster();
const SPAWN_PROBE = new Vector3( 0, 3000, 0 );
let spawned = false;
let spawnGround = 0;
// While waiting for the ground to load, hover above the launch point looking down
// so the tiles underneath are the ones that stream in.
player.position.set( 0, 400, 0 );
player.pitch = - 1.4;

function trySpawn() {

	const hit = groundBelow( tiles.group, SPAWN_PROBE, raycaster );
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

		player.update( dt, readInput(), tiles.group );
		if ( player.position.y < spawnGround - 200 ) trySpawn();

	} else if ( tiles.loadProgress === 1 && tiles.visibleTiles.size > 0 ) {

		trySpawn();

	}

	camera.position.copy( player.position );
	camera.rotation.set( player.pitch, player.yaw, 0 );
	camera.updateMatrixWorld();
	tiles.update();
	renderer.render( scene, camera );

	attributionTimer -= dt;
	if ( attributionTimer <= 0 ) {

		attributionTimer = 1;
		copyrightEl.textContent = tiles.getAttributions()
			.filter( a => a.type === 'string' ).map( a => a.value ).join( ' ' );

	}

	const p = player.position;
	readoutEl.textContent = `x ${ p.x.toFixed( 1 ) }  y ${ ( p.y - spawnGround ).toFixed( 1 ) }  z ${ p.z.toFixed( 1 ) }`
		+ `\n${ player.flying ? 'flying' : player.grounded ? 'on ground' : 'airborne' }`
		+ `  ·  tiles ${ tiles.visibleTiles.size }`;

	requestAnimationFrame( frame );

}
requestAnimationFrame( frame );

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
	tiles.setResolutionFromRenderer( camera, renderer );

} );

// Hooks for the scripted capture in tools/ (no effect during normal play).
Object.assign( window, {
	__turfwar: {
		player,
		tiles,
		camera,
		raycaster,
		isReady: () => spawned && tiles.loadProgress === 1,
		setLook( yaw: number, pitch: number ) {

			player.yaw = yaw;
			player.pitch = pitch;

		},
		hideOverlay: () => overlayEl.classList.add( 'hidden' ),
	},
} );
