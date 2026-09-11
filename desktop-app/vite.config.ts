import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Plugin to polyfill TextureUtils for Three.js r150 when imported by 3d-tiles-renderer
const threeTextureUtilsPlugin = () => ({
  name: 'three-texture-utils-shim',
  transform(code: string, id: string) {
    if (id.includes('three/build/three.module.js') || id.includes('three.module.js')) {
      if (!code.includes('export const TextureUtils') && !code.includes('TextureUtils,')) {
        return {
          code: code + '\nexport const TextureUtils = { sRGBToLinear: function(c) { return c; }, linearTosRGB: function(c) { return c; } };\n',
          map: null
        };
      }
    }
    return null;
  }
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const appEnv = loadEnv(mode, __dirname, '');
  const env = { ...rootEnv, ...appEnv };

  const googleMapsKey =
    env.GOOGLE_MAPS_API_KEY ||
    env.MAP_TILES_API_KEY ||
    env.GOOGLE_CLOUD_API_KEY ||
    env.NEXT_PUBLIC_MAP_TILES_API_KEY ||
    env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    '';

  return {
    plugins: [threeTextureUtilsPlugin(), react()],
    define: {
      'process.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleMapsKey),
      'process.env.MAP_TILES_API_KEY': JSON.stringify(googleMapsKey),
      'process.env.GOOGLE_MAPS_KEY': JSON.stringify(googleMapsKey),
      'process.env.GOOGLE_CLOUD_API_KEY': JSON.stringify(googleMapsKey),
    },
    server: {
      port: 3000,
      host: '127.0.0.1',
      proxy: {
        '/gemini': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true
        },
        '/workspace': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true
        },
        '/media': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true
        },
        '/api/browser': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true
        }
      }
    },
    resolve: {
      alias: [
        { find: '@scratchbox/core/style.css', replacement: path.resolve(__dirname, '../packages/core/src/style.css') },
        { find: '@scratchbox/core', replacement: path.resolve(__dirname, '../packages/core/src') },
        { find: '@', replacement: path.resolve(__dirname, './src') },
        { find: /^three$/, replacement: path.resolve(__dirname, './src/three-compat.ts') }
      ]
    }
  };
});
