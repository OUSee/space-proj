// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
	// 1. Register the PWA module here
	modules: ['@pinia/nuxt', '@vite-pwa/nuxt'],

	compatibilityDate: '2024-04-03', // Use a valid release date
	devtools: { enabled: true },
	ssr: false,
	imports: { autoImport: true, dirs: ['~/core', '~/sensors'] },

	vite: {
		build: {
			target: 'es2020',
			cssCodeSplit: false,
			cssMinify: true,
			rollupOptions: {
				output: {
					manualChunks: undefined,
					inlineDynamicImports: true,
				},
			},
			chunkSizeWarningLimit: 2000,
		},
		optimizeDeps: { include: ['three'] },
	},

	nitro: {
		prerender: {
			routes: ['/phone'],
		},
	},

	vue: {
		propsDestructure: true,
	},

	features: {
		inlineStyles: false, // основной фикс для новых версий (по умолчанию true)
	},

	css: ['~/assets/styles/index.scss'],

	pwa: {
		registerType: 'autoUpdate',
		manifest: {
			name: 'Indoor Navigation AEKF',
			short_name: 'NavAEKF',
			theme_color: '#ffffff',
		},
		workbox: {
			navigateFallback: '/',
		},
		devOptions: {
			enabled: true, // Useful for testing PWA locally
		},
	},
});
