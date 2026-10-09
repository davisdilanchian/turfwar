import {
	AdditiveBlending, BoxGeometry, BufferGeometry, CylinderGeometry, Group, Line, LineBasicMaterial,
	Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, type PerspectiveCamera, Raycaster,
	type Scene, SphereGeometry, Vector3,
} from 'three';
import type { Craters } from './craters';
import { visibleMeshes } from './player';

export type WeaponKind = 'rifle' | 'rocket';

const RIFLE = { interval: 0.1, range: 400, holeRadius: 0.22 };
const ROCKET = { interval: 0.9, speed: 70, gravity: 6, radius: 3, life: 6 };

export type Hit = { point: Vector3, normal: Vector3, distance: number };

const PUFF_GEOMETRY = new SphereGeometry( 1, 10, 8 );
const _raycaster = new Raycaster();
const _dir = new Vector3();
const _muzzle = new Vector3();
const _step = new Vector3();
const _probe = new Vector3();
const _downDir = new Vector3( 0, - 1, 0 );

/** First surface hit along a ray, ignoring anything already blown away by a crater. */
export function castShot( world: Object3D, craters: Craters, origin: Vector3, direction: Vector3, far: number ): Hit | null {

	_raycaster.set( origin, direction );
	_raycaster.far = far;
	_raycaster.firstHitOnly = false;
	const hits = _raycaster.intersectObjects( [ ...visibleMeshes( world ), ...craters.bowls.children ], false );
	for ( const hit of hits ) {

		if ( craters.inside( hit.point ) ) continue;
		const normal = hit.face ? hit.face.normal.clone().transformDirection( hit.object.matrixWorld ) : new Vector3( 0, 1, 0 );
		if ( normal.dot( direction ) > 0 ) normal.negate();
		return { point: hit.point.clone(), normal, distance: hit.distance };

	}
	return null;

}

function dispose( object: Object3D ) {

	const mesh = object as Mesh;
	if ( mesh.geometry && mesh.geometry !== PUFF_GEOMETRY ) mesh.geometry.dispose();
	( mesh.material as MeshBasicMaterial | undefined )?.dispose();

}

type Effect = { object: Object3D, age: number, life: number, tick: ( effect: Effect, dt: number ) => void };
type Rocket = { mesh: Mesh, velocity: Vector3, age: number };

export class Weapons {

	/** Seconds of screen shake left; read by the camera. */
	shake = 0;
	/** Called when an explosion happens at `point`, e.g. to knock the player back. */
	onExplosion: ( point: Vector3, radius: number ) => void = () => {};

	private viewmodel = new Group();
	private flash: Mesh;
	private recoil = 0;
	private cooldowns: Record<WeaponKind, number> = { rifle: 0, rocket: 0 };
	private effects: Effect[] = [];
	private rockets: Rocket[] = [];

	constructor( private scene: Scene, private camera: PerspectiveCamera, private world: Object3D, private craters: Craters ) {

		// A simple rifle with an under-barrel launcher, drawn in front of the camera.
		const metal = new MeshStandardMaterial( { color: 0x2b2f33, roughness: 0.6, metalness: 0.4 } );
		const body = new Mesh( new BoxGeometry( 0.07, 0.09, 0.5 ), metal );
		const barrel = new Mesh( new CylinderGeometry( 0.015, 0.015, 0.35 ).rotateX( Math.PI / 2 ), metal );
		barrel.position.set( 0, 0.02, - 0.4 );
		const launcher = new Mesh( new CylinderGeometry( 0.035, 0.035, 0.3 ).rotateX( Math.PI / 2 ), new MeshStandardMaterial( { color: 0x4b5320, roughness: 0.8 } ) );
		launcher.position.set( 0, - 0.07, - 0.25 );
		const grip = new Mesh( new BoxGeometry( 0.05, 0.12, 0.06 ).rotateX( 0.3 ), metal );
		grip.position.set( 0, - 0.09, 0.12 );
		this.flash = new Mesh( new SphereGeometry( 0.06, 8, 6 ), new MeshBasicMaterial( { color: 0xffd27a, blending: AdditiveBlending, transparent: true } ) );
		this.flash.position.set( 0, 0.02, - 0.6 );
		this.flash.visible = false;
		this.viewmodel.add( body, barrel, launcher, grip, this.flash );
		this.viewmodel.position.set( 0.2, - 0.2, - 0.45 );
		this.viewmodel.traverse( o => {

			o.renderOrder = 10;
			const m = ( o as Mesh ).material as MeshStandardMaterial | undefined;
			if ( m ) m.depthTest = false;

		} );
		camera.add( this.viewmodel );

	}

	fire( kind: WeaponKind ) {

		if ( this.cooldowns[ kind ] > 0 ) return;
		this.camera.getWorldDirection( _dir );
		this.flash.getWorldPosition( _muzzle );

		if ( kind === 'rifle' ) {

			this.cooldowns.rifle = RIFLE.interval;
			this.recoil = Math.min( this.recoil + 0.03, 0.08 );
			const hit = castShot( this.world, this.craters, this.camera.position, _dir, RIFLE.range );
			const end = hit ? hit.point : this.camera.position.clone().addScaledVector( _dir, RIFLE.range );
			this.tracer( _muzzle.clone(), end );
			if ( hit ) {

				this.craters.add( hit.point, RIFLE.holeRadius, this.groundAt( hit.point ) );
				this.puff( hit.point, 0.25, 0xd8c8a8, 0.4 );

			}

		} else {

			this.cooldowns.rocket = ROCKET.interval;
			this.recoil = 0.12;
			const mesh = new Mesh( new CylinderGeometry( 0.05, 0.05, 0.4 ).rotateX( Math.PI / 2 ), new MeshBasicMaterial( { color: 0xffaa33 } ) );
			mesh.position.copy( _muzzle );
			mesh.lookAt( _muzzle.clone().add( _dir ) );
			this.scene.add( mesh );
			this.rockets.push( { mesh, velocity: _dir.clone().multiplyScalar( ROCKET.speed ), age: 0 } );

		}

		this.flash.visible = true;
		this.flash.scale.setScalar( kind === 'rocket' ? 2.5 : 1 );

	}

	update( dt: number ) {

		this.cooldowns.rifle = Math.max( 0, this.cooldowns.rifle - dt );
		this.cooldowns.rocket = Math.max( 0, this.cooldowns.rocket - dt );
		this.recoil = Math.max( 0, this.recoil - dt * 0.6 );
		this.viewmodel.position.z = - 0.45 + this.recoil;
		this.viewmodel.rotation.x = this.recoil * 1.5;
		if ( this.flash.visible && ( this.flash.userData.age = ( this.flash.userData.age ?? 0 ) + dt ) > 0.05 ) {

			this.flash.visible = false;
			this.flash.userData.age = 0;

		}
		this.shake = Math.max( 0, this.shake - dt );

		for ( const rocket of [ ...this.rockets ] ) {

			rocket.age += dt;
			rocket.velocity.y -= ROCKET.gravity * dt;
			_step.copy( rocket.velocity ).multiplyScalar( dt );
			const length = _step.length();
			const hit = castShot( this.world, this.craters, rocket.mesh.position, _step.normalize(), length );
			if ( hit || rocket.age > ROCKET.life ) {

				this.rockets.splice( this.rockets.indexOf( rocket ), 1 );
				this.scene.remove( rocket.mesh );
				dispose( rocket.mesh );
				if ( hit ) this.explode( hit );
				continue;

			}
			rocket.mesh.position.addScaledVector( _step, length );
			rocket.mesh.lookAt( rocket.mesh.position.clone().add( rocket.velocity ) );
			if ( Math.random() < 0.6 ) this.puff( rocket.mesh.position, 0.15, 0x999999, 0.6 );

		}

		for ( const effect of [ ...this.effects ] ) {

			effect.age += dt;
			if ( effect.age >= effect.life ) {

				this.effects.splice( this.effects.indexOf( effect ), 1 );
				this.scene.remove( effect.object );
				dispose( effect.object );
				continue;

			}
			effect.tick( effect, dt );

		}

	}

	private explode( hit: Hit ) {

		const r = ROCKET.radius;
		// Ground hits are centered a little above the impact, so the crater is a shallow
		// bowl rather than a half-sphere pit.
		const center = hit.point.clone();
		if ( hit.normal.y > 0.5 ) center.y += r * 0.3;
		this.craters.add( center, r, this.groundAt( center ) );

		const fireball = new Mesh( new SphereGeometry( 1, 20, 14 ), new MeshBasicMaterial( { color: 0xffa040, blending: AdditiveBlending, transparent: true, depthWrite: false } ) );
		fireball.position.copy( hit.point );
		this.add( fireball, 0.45, ( e ) => {

			const k = e.age / e.life;
			e.object.scale.setScalar( r * ( 0.4 + 1.3 * k ) );
			( ( e.object as Mesh ).material as MeshBasicMaterial ).opacity = 1 - k;

		} );
		for ( let i = 0; i < 14; i ++ ) {

			const p = hit.point.clone().add( new Vector3( Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5 ).multiplyScalar( r * 1.5 ) );
			this.puff( p, 0.8 + Math.random() * 1.2, Math.random() < 0.5 ? 0x3a3a3a : 0x5c5550, 2.5 + Math.random() * 2 );

		}
		const distance = hit.point.distanceTo( this.camera.position );
		this.shake = Math.max( this.shake, Math.max( 0, 0.6 - distance / 60 ) );
		this.onExplosion( hit.point, r );

	}

	/** Ground height under `point`, or null if there's no ground within reach. */
	private groundAt( point: Vector3 ) {

		const hit = castShot( this.world, this.craters, _probe.copy( point ).setY( point.y + 0.5 ), _downDir, 50 );
		return hit ? hit.point.y : null;

	}

	private tracer( from: Vector3, to: Vector3 ) {

		const line = new Line( new BufferGeometry().setFromPoints( [ from, to ] ), new LineBasicMaterial( { color: 0xffe9a0, transparent: true } ) );
		this.add( line, 0.06, ( e ) => {

			( ( e.object as Line ).material as LineBasicMaterial ).opacity = 1 - e.age / e.life;

		} );

	}

	/** A soft ball of smoke or dust that grows, rises and fades. */
	private puff( at: Vector3, size: number, color: number, life: number ) {

		const mesh = new Mesh( PUFF_GEOMETRY, new MeshBasicMaterial( { color, transparent: true, opacity: 0.45, depthWrite: false } ) );
		mesh.position.copy( at );
		mesh.scale.setScalar( size * 0.5 );
		const rise = 0.5 + Math.random();
		this.add( mesh, life, ( e, dt ) => {

			const k = e.age / e.life;
			e.object.scale.setScalar( size * ( 0.5 + k ) );
			e.object.position.y += rise * dt;
			( ( e.object as Mesh ).material as MeshBasicMaterial ).opacity = 0.45 * ( 1 - k );

		} );

	}

	private add( object: Object3D, life: number, tick: Effect[ 'tick' ] ) {

		this.scene.add( object );
		this.effects.push( { object, age: 0, life, tick } );

	}

}
