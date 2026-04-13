// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
	// 1. Register the PWA module here
	modules: ['@pinia/nuxt'],

	compatibilityDate: '2024-04-03', // Use a valid release date
	devtools: { enabled: true },
	ssr: false,
	app: {
		baseURL: '/space-proj/',
		head: {
			link: [{ rel: 'icon', href: '/space-proj/favicon.ico' }],
		},
	},
	imports: { autoImport: true },

	vite: {
		base: '/space-proj/',
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
		static: true,
		prerender: {
			routes: ['/nonexistent'],
			crawlLinks: false,
		},
	},

	vue: {
		propsDestructure: true,
	},

	features: {
		inlineStyles: false, // основной фикс для новых версий (по умолчанию true)
	},

	devServer: {
		host: '0.0.0.0',
		port: 3000,
	},

	// css: ['~/assets/styles/index.scss'],

	// vitepwa: {  // ← pwa → vitepwa
	//   registerType: 'autoUpdate',
	//   manifest: {
	//     name: 'Indoor Navigation AEKF',
	//     short_name: 'NavAEKF',
	//     theme_color: '#ffffff'
	//   },
	//   workbox: { navigateFallback: '/' },
	//   devOptions: { enabled: true }
	// }
});
