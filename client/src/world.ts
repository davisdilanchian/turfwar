import { DoubleSide, Group, MathUtils, type Mesh, type PerspectiveCamera, type WebGLRenderer } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
	CesiumIonAuthPlugin, CesiumIonOverlay, GLTFExtensionsPlugin, GoogleCloudAuthPlugin,
	ImageOverlayPlugin, ReorientationPlugin,
} from '3d-tiles-renderer/plugins';
import type { Craters } from './craters';
import { ensureBVH } from './player';

// Launch area: Alexander St, Glendale City Center (street midpoint).
export const ORIGIN = { lat: 34.1532, lon: - 118.2672 };

// Cesium ion asset IDs for its global content.
const CESIUM_WORLD_TERRAIN = 1;
const CESIUM_BING_AERIAL = 2;
const CESIUM_OSM_BUILDINGS = 96188;

export type WorldKind = 'google' | 'cesium';

export type World = {
	kind: WorldKind,
	root: Group,
	tilesets: TilesRenderer[],
	/** Text the provider requires on screen. */
	credit: string,
};

const draco = new DRACOLoader().setDecoderPath( 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' );

/**
 * Builds the streamed world for `kind`, re-centered so Alexander St is the origin
 * with +Y up. Every tile mesh gets crater cutting and a collision BVH as it loads.
 * Nothing is written to disk.
 */
export function createWorld( kind: WorldKind, env: ImportMetaEnv, renderer: WebGLRenderer, camera: PerspectiveCamera, craters: Craters ): World {

	const root = new Group();
	const tilesets: TilesRenderer[] = [];

	const addTileset = ( tiles: TilesRenderer ) => {

		tiles.registerPlugin( new ReorientationPlugin( {
			lat: ORIGIN.lat * MathUtils.DEG2RAD,
			lon: ORIGIN.lon * MathUtils.DEG2RAD,
			recenter: true,
		} ) );
		tiles.setCamera( camera );
		tiles.setResolutionFromRenderer( camera, renderer );
		tiles.addEventListener( 'load-model', ( { scene } ) => {

			scene.traverse( obj => {

				const mesh = obj as Mesh;
				if ( ! mesh.isMesh ) return;
				const materials = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ];
				for ( const material of materials ) {

					material.side = DoubleSide;
					craters.patch( material, 'tile' );

				}
				ensureBVH( mesh );

			} );

		} );
		tiles.addEventListener( 'dispose-model', ( { scene } ) => {

			scene.traverse( obj => ( obj as Mesh ).geometry?.disposeBoundsTree?.() );

		} );
		tilesets.push( tiles );
		root.add( tiles.group );

	};

	if ( kind === 'google' ) {

		const apiToken = env.VITE_GOOGLE_MAPS_API_KEY;
		if ( ! apiToken ) throw new Error( 'Missing VITE_GOOGLE_MAPS_API_KEY in .env.local' );
		const tiles = new TilesRenderer();
		tiles.registerPlugin( new GoogleCloudAuthPlugin( { apiToken, autoRefreshToken: true } ) );
		tiles.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader: draco } ) );
		addTileset( tiles );
		// Lower than the plugin's default of 20 so street level loads in full detail.
		tiles.errorTarget = 12;
		return { kind, root, tilesets, credit: 'Google' };

	}

	const apiToken = env.VITE_CESIUM_ION_TOKEN;
	if ( ! apiToken ) throw new Error( 'Missing VITE_CESIUM_ION_TOKEN in .env.local' );

	const terrain = new TilesRenderer();
	terrain.registerPlugin( new CesiumIonAuthPlugin( { apiToken, assetId: String( CESIUM_WORLD_TERRAIN ), autoRefreshToken: true } ) );
	terrain.registerPlugin( new ImageOverlayPlugin( {
		renderer,
		overlays: [ new CesiumIonOverlay( { assetId: CESIUM_BING_AERIAL, apiToken, autoRefreshToken: true } ) ],
	} ) );
	addTileset( terrain );
	terrain.errorTarget = 4;

	const buildings = new TilesRenderer();
	buildings.registerPlugin( new CesiumIonAuthPlugin( { apiToken, assetId: String( CESIUM_OSM_BUILDINGS ), autoRefreshToken: true } ) );
	buildings.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader: draco } ) );
	addTileset( buildings );
	buildings.errorTarget = 4;

	return { kind, root, tilesets, credit: 'Cesium ion' };

}
