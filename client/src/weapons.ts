import {
	AdditiveBlending, BufferGeometry, CylinderGeometry, Group, Line, LineBasicMaterial,
	Mesh, MeshBasicMaterial, type Object3D, type PerspectiveCamera, Raycaster,
	Scene, SphereGeometry, Vector3, AmbientLight, DirectionalLight,
} from 'three';
import type { Craters } from './craters';
import { visibleMeshes } from './player';
import { createViewmodel } from './viewmodel';

export type WeaponKind = 'rifle' | 'rocket';

const RIFLE = { interval: 0.1, range: 400, holeRadius: 0.3 };
const ROCKET = { interval: 0.9, speed: 70, gravity: 6, radius: 2.2, life: 6 };

export type Hit = { point: Vector3, normal: Vector3, distance: number };

const PUFF_GEOMETRY = new SphereGeometry( 1, 10, 8 );
const _raycaster = new Raycaster();
const _dir = new Vector3();
const _muzzle = new Vector3();
const _step = new Vector3();
const _probe = new Vector3();
const _down = new Vector3( 0, - 1, 0 );
const SMOKE = { duration: 45, interval: 0.3, maxSources: 12 };

/** First surface hit along a ray. */
export function castShot( world: Object3D, origin: Vector3, direction: Vector3, far: number ): Hit | null {

	_raycaster.set( origin, direction );
	_raycaster.far = far;
	_raycaster.firstHitOnly = true;
	const hit = _raycaster.intersectObjects( visibleMeshes( world ), false )[ 0 ];
	if ( ! hit ) return null;
	const normal = hit.face ? hit.face.normal.clone().transformDirection( hit.object.matrixWorld ) : new Vector3( 0, 1, 0 );
	if ( normal.dot( direction ) > 0 ) normal.negate();
	return { point: hit.point.clone(), normal, distance: hit.distance };

}

function dispose( object: Object3D ) {

	const mesh = object as Mesh;
	if ( mesh.geometry && mesh.geometry !== PUFF_GEOMETRY ) mesh.geometry.dispose();
	( mesh.material as MeshBasicMaterial | undefined )?.dispose();

}

type Effect = { object: Object3D, age: number, life: number, tick: ( effect: Effect, dt: number ) => void };
type Rocket = { mesh: Mesh, velocity: Vector3, age: number };
type Smoker = { at: Vector3, age: number, next: number };

export class Weapons {

	/** Seconds of screen shake left; read by the camera. */
	shake = 0;
	/** Called when an explosion happens at `point`, e.g. to knock the player back. */
	onExplosion: ( point: Vector3, radius: number ) => void = () => {};

	/** Scene holding just the weapon and its lighting; render it after the world. */
	viewScene = new Scene();
	/** Current crosshair spread, 0 (still) to 1 (just fired a lot). */
	spread = 0;

	private holder = new Group();
	private viewmodel = new Group();
	private flash: Mesh;
	private muzzle: Object3D;
	private launcherMouth: Object3D;
	private recoil = 0;
	private cooldowns: Record<WeaponKind, number> = { rifle: 0, rocket: 0 };
	private effects: Effect[] = [];
	private rockets: Rocket[] = [];
	private smokers: Smoker[] = [];

	constructor( private scene: Scene, private camera: PerspectiveCamera, private world: Object3D, private craters: Craters ) {

		// The held weapon lives in its own scene (see `viewScene`), drawn after the
		// world with a cleared depth buffer so it never clips into walls.
		const vm = createViewmodel();
		this.flash = vm.flash;
		this.muzzle = vm.muzzle;
		this.launcherMouth = vm.launcher;
		this.viewmodel.add( vm.group );
		this.viewmodel.position.set( 0.15, - 0.16, - 0.3 );
		this.holder.add( this.viewmodel );
		const key = new DirectionalLight( 0xfff2e0, 2.2 );
		key.position.set( 1, 2, 1.5 );
		this.viewScene.add( this.holder, new AmbientLight( 0xffffff, 0.6 ), key );

	}

	fire( kind: WeaponKind ) {

		if ( this.cooldowns[ kind ] > 0 ) return;
		this.camera.getWorldDirection( _dir );
		this.syncHolder();
		( kind === 'rocket' ? this.launcherMouth : this.muzzle ).getWorldPosition( _muzzle );

		if ( kind === 'rifle' ) {

			this.cooldowns.rifle = RIFLE.interval;
			this.recoil = Math.min( this.recoil + 0.03, 0.08 );
			this.spread = Math.min( 1, this.spread + 0.25 );
			const hit = castShot( this.world, this.camera.position, _dir, RIFLE.range );
			const end = hit ? hit.point : this.camera.position.clone().addScaledVector( _dir, RIFLE.range );
			this.tracer( _muzzle.clone(), end );
			if ( hit ) {

				this.blast( hit, RIFLE.holeRadius );
				this.puff( hit.point, 0.25, 0xd8c8a8, 0.4 );

			}

		} else {

			this.cooldowns.rocket = ROCKET.interval;
			this.recoil = 0.12;
			this.spread = 1;
			const mesh = new Mesh( new CylinderGeometry( 0.05, 0.05, 0.4 ).rotateX( Math.PI / 2 ), new MeshBasicMaterial( { color: 0xffaa33 } ) );
			mesh.position.copy( _muzzle );
			mesh.lookAt( _muzzle.clone().add( _dir ) );
			this.scene.add( mesh );
			this.rockets.push( { mesh, velocity: _dir.clone().multiplyScalar( ROCKET.speed ), age: 0 } );

		}

		if ( kind === 'rifle' ) {

			this.flash.visible = true;
			this.flash.rotation.z = Math.random() * Math.PI;
			this.flash.scale.setScalar( 0.8 + Math.random() * 0.5 );

		}

	}

	update( dt: number ) {

		this.cooldowns.rifle = Math.max( 0, this.cooldowns.rifle - dt );
		this.cooldowns.rocket = Math.max( 0, this.cooldowns.rocket - dt );
		this.recoil = Math.max( 0, this.recoil - dt * 0.6 );
		this.spread = Math.max( 0, this.spread - dt * 2.5 );
		this.viewmodel.position.z = - 0.3 + this.recoil;
		this.viewmodel.rotation.x = this.recoil * 1.5;
		this.syncHolder();
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
			const hit = castShot( this.world, rocket.mesh.position, _step.normalize(), length );
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

		// Craters keep smoking for a while after the blast.
		for ( const smoker of [ ...this.smokers ] ) {

			smoker.age += dt;
			smoker.next -= dt;
			if ( smoker.age > SMOKE.duration ) {

				this.smokers.splice( this.smokers.indexOf( smoker ), 1 );
				continue;

			}
			if ( smoker.next <= 0 ) {

				smoker.next = SMOKE.interval * ( 1 + smoker.age / SMOKE.duration * 2 );
				const jitter = new Vector3( Math.random() - 0.5, 0, Math.random() - 0.5 ).multiplyScalar( 2 );
				const shade = Math.random() < 0.5 ? 0x2a2a2a : 0x4a4642;
				this.puff( smoker.at.clone().add( jitter ), 1 + Math.random() * 1.5, shade, 5 + Math.random() * 3, 1.6 );

			}

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
		this.blast( hit, r );
		this.smokers.push( { at: hit.point.clone(), age: 0, next: 0.5 } );
		if ( this.smokers.length > SMOKE.maxSources ) this.smokers.shift();

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

	/**
	 * Street level around a hit: the lower quartile of samples straight down around
	 * it, so nearby roofs don't count but a single dip doesn't either.
	 */
	private streetLevel( hit: Hit ) {

		const heights: number[] = [];
		for ( const radius of [ 6, 12 ] ) {

			for ( let i = 0; i < 8; i ++ ) {

				const angle = i / 8 * Math.PI * 2;
				_probe.set( hit.point.x + Math.cos( angle ) * radius, hit.point.y + 30, hit.point.z + Math.sin( angle ) * radius );
				const below = castShot( this.world, _probe, _down, 80 );
				if ( below ) heights.push( below.point.y );

			}

		}
		if ( ! heights.length ) return hit.point.y;
		heights.sort( ( a, b ) => a - b );
		return heights[ Math.floor( heights.length / 4 ) ];

	}

	/**
	 * Adds a crater pushing into whatever was hit. Ground (facing up near street
	 * level, or anything below street level) is solid all the way down; walls, roofs
	 * and trees are thin shells that a big enough blast goes straight through.
	 */
	private blast( hit: Hit, r: number ) {

		const floor = this.streetLevel( hit );
		const ground = ( hit.normal.y > 0.6 && hit.point.y < floor + 2.5 ) || hit.point.y < floor - 0.3;
		this.craters.add( hit.point, r, hit.normal.clone().negate(), ground, floor );

	}

	/** Keeps the weapon glued to the camera. */
	private syncHolder() {

		this.camera.updateMatrixWorld();
		this.camera.matrixWorld.decompose( this.holder.position, this.holder.quaternion, this.holder.scale );
		this.holder.updateMatrixWorld( true );

	}

	private tracer( from: Vector3, to: Vector3 ) {

		const line = new Line( new BufferGeometry().setFromPoints( [ from, to ] ), new LineBasicMaterial( { color: 0xffe9a0, transparent: true } ) );
		this.add( line, 0.06, ( e ) => {

			( ( e.object as Line ).material as LineBasicMaterial ).opacity = 1 - e.age / e.life;

		} );

	}

	/** A soft ball of smoke or dust that grows, rises and fades. */
	private puff( at: Vector3, size: number, color: number, life: number, rise = 0.5 + Math.random() ) {

		const mesh = new Mesh( PUFF_GEOMETRY, new MeshBasicMaterial( { color, transparent: true, opacity: 0.45, depthWrite: false } ) );
		mesh.position.copy( at );
		mesh.scale.setScalar( size * 0.5 );
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
