import {
	BoxGeometry, CapsuleGeometry, CircleGeometry, CylinderGeometry, ExtrudeGeometry, Group, Mesh,
	MeshBasicMaterial, MeshStandardMaterial, Object3D, Shape, type BufferGeometry, type Material,
} from 'three';

// A procedural first-person rifle (AR-style, with a red-dot sight and an
// under-barrel grenade launcher) held in gloved hands. Units are meters, with the
// barrel pointing down -Z. Everything is built from primitives, so no model
// files are needed.

export type Viewmodel = {
	group: Group,
	/** Tip of the rifle barrel: tracers and the muzzle flash start here. */
	muzzle: Object3D,
	/** Mouth of the grenade launcher: rockets start here. */
	launcher: Object3D,
	flash: Mesh,
};

const polymer = new MeshStandardMaterial( { color: 0x1d1f22, roughness: 0.75, metalness: 0.05 } );
const metal = new MeshStandardMaterial( { color: 0x2c2f33, roughness: 0.38, metalness: 0.75 } );
const darkMetal = new MeshStandardMaterial( { color: 0x17181a, roughness: 0.45, metalness: 0.7 } );
const olive = new MeshStandardMaterial( { color: 0x4a4f35, roughness: 0.7, metalness: 0.15 } );
const glove = new MeshStandardMaterial( { color: 0x2b2a27, roughness: 0.9 } );
const lens = new MeshStandardMaterial( { color: 0x3a6f6a, roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.55 } );

function part( geometry: BufferGeometry, material: Material, x: number, y: number, z: number, parent: Object3D, rx = 0, ry = 0, rz = 0 ) {

	const mesh = new Mesh( geometry, material );
	mesh.position.set( x, y, z );
	mesh.rotation.set( rx, ry, rz );
	parent.add( mesh );
	return mesh;

}

/** A cylinder lying along Z. */
function tube( radius: number, length: number, segments = 16 ) {

	return new CylinderGeometry( radius, radius, length, segments ).rotateX( Math.PI / 2 );

}

export function createViewmodel(): Viewmodel {

	const group = new Group();
	const rifle = new Group();
	group.add( rifle );

	// Receiver: upper with ejection port and charging handle, lower with trigger guard.
	part( new BoxGeometry( 0.05, 0.055, 0.24 ), metal, 0, 0, 0.02, rifle );
	part( new BoxGeometry( 0.02, 0.02, 0.06 ), darkMetal, 0.026, 0.005, 0.03, rifle );
	part( new BoxGeometry( 0.03, 0.012, 0.05 ), darkMetal, 0, 0.032, 0.13, rifle );
	part( new BoxGeometry( 0.044, 0.05, 0.18 ), polymer, 0, - 0.05, 0.04, rifle );
	part( new BoxGeometry( 0.008, 0.03, 0.06 ), darkMetal, 0, - 0.088, 0.06, rifle );

	// Top rail with cross slots, running the length of receiver and handguard.
	part( new BoxGeometry( 0.024, 0.008, 0.52 ), darkMetal, 0, 0.032, - 0.13, rifle );
	for ( let i = 0; i < 22; i ++ ) part( new BoxGeometry( 0.026, 0.004, 0.008 ), darkMetal, 0, 0.038, 0.1 - i * 0.022, rifle );

	// Handguard (octagonal) with side rails, barrel, gas block and muzzle brake.
	part( new CylinderGeometry( 0.034, 0.034, 0.3, 8 ).rotateX( Math.PI / 2 ), polymer, 0, - 0.002, - 0.25, rifle );
	part( new BoxGeometry( 0.006, 0.014, 0.26 ), darkMetal, 0.036, - 0.002, - 0.25, rifle );
	part( new BoxGeometry( 0.006, 0.014, 0.26 ), darkMetal, - 0.036, - 0.002, - 0.25, rifle );
	part( tube( 0.011, 0.2 ), metal, 0, 0, - 0.49, rifle );
	part( new BoxGeometry( 0.024, 0.03, 0.03 ), darkMetal, 0, 0.004, - 0.42, rifle );
	const brake = part( tube( 0.016, 0.055, 12 ), darkMetal, 0, 0, - 0.61, rifle );
	for ( const side of [ - 1, 1 ] ) part( new BoxGeometry( 0.004, 0.012, 0.03 ), metal, side * 0.016, 0, 0, brake );

	// Curved magazine.
	const mag = new Shape();
	mag.moveTo( 0, 0 );
	mag.lineTo( 0.07, 0 );
	mag.quadraticCurveTo( 0.075, - 0.08, 0.1, - 0.16 );
	mag.lineTo( 0.03, - 0.17 );
	mag.quadraticCurveTo( 0.01, - 0.09, 0, 0 );
	const magGeometry = new ExtrudeGeometry( mag, { depth: 0.032, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 1 } )
		.translate( 0, 0, - 0.016 ).rotateY( Math.PI / 2 );
	part( magGeometry, polymer, 0, - 0.07, - 0.01, rifle );

	// Pistol grip, buffer tube and stock.
	part( new BoxGeometry( 0.034, 0.1, 0.04 ), polymer, 0, - 0.11, 0.11, rifle, - 0.32 );
	part( tube( 0.016, 0.2 ), darkMetal, 0, - 0.01, 0.22, rifle );
	part( new BoxGeometry( 0.042, 0.075, 0.14 ), polymer, 0, - 0.025, 0.3, rifle );
	part( new BoxGeometry( 0.044, 0.09, 0.02 ), darkMetal, 0, - 0.03, 0.37, rifle );

	// Red-dot sight on a riser mount.
	part( new BoxGeometry( 0.028, 0.02, 0.05 ), darkMetal, 0, 0.046, 0.02, rifle );
	const optic = part( tube( 0.021, 0.075, 20 ), metal, 0, 0.074, 0.02, rifle );
	part( new CircleGeometry( 0.018, 20 ), lens, 0, 0, - 0.038, optic );
	part( new CircleGeometry( 0.0025, 10 ), new MeshBasicMaterial( { color: 0xff2a2a } ), 0, 0, 0.03, optic, 0, Math.PI );

	// Under-barrel grenade launcher.
	const gl = new Group();
	gl.position.set( 0, - 0.062, - 0.25 );
	rifle.add( gl );
	part( tube( 0.026, 0.26, 20 ), olive, 0, 0, 0, gl );
	part( tube( 0.029, 0.03, 20 ), darkMetal, 0, 0, - 0.13, gl );
	part( new BoxGeometry( 0.03, 0.04, 0.06 ), olive, 0, - 0.03, 0.1, gl );
	part( new BoxGeometry( 0.006, 0.035, 0.025 ), darkMetal, 0, - 0.062, 0.1, gl );
	const launcher = new Object3D();
	launcher.position.set( 0, 0, - 0.15 );
	gl.add( launcher );

	const muzzle = new Object3D();
	muzzle.position.set( 0, 0, - 0.645 );
	rifle.add( muzzle );
	const flash = new Mesh( new CylinderGeometry( 0.0, 0.05, 0.14, 8, 1, true ).rotateX( - Math.PI / 2 ), new MeshBasicMaterial( { color: 0xffc46b, transparent: true, opacity: 0.9, depthWrite: false } ) );
	flash.position.set( 0, 0, - 0.07 );
	flash.visible = false;
	muzzle.add( flash );

	// Gloved hands: one on the pistol grip, one under the handguard.
	const right = new Group();
	right.position.set( 0.012, - 0.12, 0.13 );
	rifle.add( right );
	part( new CapsuleGeometry( 0.032, 0.05, 4, 10 ), glove, 0, 0, 0, right, 0.3, 0, 0.2 );
	const left = new Group();
	left.position.set( - 0.03, - 0.045, - 0.3 );
	rifle.add( left );
	part( new CapsuleGeometry( 0.03, 0.07, 4, 10 ), glove, 0, 0, 0, left, 0, 0, 1.25 );

	return { group, muzzle, launcher, flash };

}
