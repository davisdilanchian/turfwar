import { defineConfig } from 'vite';

export default defineConfig( {
	// .env.local lives at the repo root so the server can share it later.
	envDir: '..',
	server: { port: 5173, strictPort: true },
} );
