import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { defineConfig } from 'vite';


export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' },
			},
		},
	},
	build: {
		external: ['@cloudflare/node-cloudflare-r2'],
	  }
});